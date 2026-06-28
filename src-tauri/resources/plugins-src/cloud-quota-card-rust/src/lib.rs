use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::ptr;

const ABI_VERSION: u32 = 1;
const PLUGIN_ID: &str = "cloud-quota-card";
const LOCAL_KEY_MATERIAL: &str = "cliproxy-cloud-quota-card-local-v1";
const BASE_TOKENS_PER_USD: i64 = 500_000;
const MIN_CHARGE_USD_MICRO: i64 = 1;

#[repr(C)]
pub struct CliproxyBuffer {
    ptr: *mut u8,
    len: usize,
}

type HostCall =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const u8, usize, *mut CliproxyBuffer) -> i32;
type HostFree = unsafe extern "C" fn(*mut c_void, usize);
type PluginCall = unsafe extern "C" fn(*const c_char, *const u8, usize, *mut CliproxyBuffer) -> i32;
type PluginFree = unsafe extern "C" fn(*mut c_void, usize);
type PluginShutdown = unsafe extern "C" fn();

#[repr(C)]
pub struct CliproxyHostApi {
    abi_version: u32,
    host_ctx: *mut c_void,
    call: Option<HostCall>,
    free_buffer: Option<HostFree>,
}

#[repr(C)]
pub struct CliproxyPluginApi {
    abi_version: u32,
    call: Option<PluginCall>,
    free_buffer: Option<PluginFree>,
    shutdown: Option<PluginShutdown>,
}

static mut STORED_HOST: *const CliproxyHostApi = ptr::null();

#[no_mangle]
pub extern "C" fn cliproxy_plugin_init(
    host: *const CliproxyHostApi,
    plugin: *mut CliproxyPluginApi,
) -> i32 {
    if plugin.is_null() {
        return 1;
    }
    unsafe {
        STORED_HOST = host;
        (*plugin).abi_version = ABI_VERSION;
        (*plugin).call = Some(plugin_call);
        (*plugin).free_buffer = Some(plugin_free);
        (*plugin).shutdown = Some(plugin_shutdown);
    }
    0
}

unsafe extern "C" fn plugin_call(
    method: *const c_char,
    request: *const u8,
    request_len: usize,
    response: *mut CliproxyBuffer,
) -> i32 {
    if !response.is_null() {
        (*response).ptr = ptr::null_mut();
        (*response).len = 0;
    }
    let method = match read_cstr(method) {
        Ok(value) => value,
        Err(error) => {
            write_response(response, &error_envelope("invalid_method", &error, 0));
            return 1;
        }
    };
    let request = if request.is_null() || request_len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(request, request_len)
    };
    let raw = match handle_method(&method, request) {
        Ok(value) => value,
        Err(error) => error_envelope("plugin_error", &error, 502),
    };
    write_response(response, &raw);
    0
}

unsafe extern "C" fn plugin_free(ptr: *mut c_void, len: usize) {
    if !ptr.is_null() {
        let _ = Vec::from_raw_parts(ptr as *mut u8, len, len);
    }
}

unsafe extern "C" fn plugin_shutdown() {}

fn handle_method(method: &str, raw_req: &[u8]) -> Result<Vec<u8>, String> {
    match method {
        "plugin.register" | "plugin.reconfigure" => ok_envelope(json!({
            "schema_version": 1,
            "metadata": {
                "Name": PLUGIN_ID,
                "Version": "0.1.0",
                "Author": "CLIProxyApp",
                "GitHubRepository": "https://github.com/xieyuqiyu-source/CLIProxyApp",
                "ConfigFields": []
            },
            "capabilities": {
                "auth_provider": true,
                "executor": true,
                "executor_model_scope": "both",
                "executor_input_formats": ["chat-completions", "responses", "codex", "openai"],
                "executor_output_formats": ["chat-completions", "responses", "codex", "openai"]
            }
        })),
        "auth.identifier" | "executor.identifier" => {
            ok_envelope(json!({ "identifier": PLUGIN_ID }))
        }
        "auth.parse" => handle_auth_parse(raw_req),
        "auth.refresh" => handle_auth_refresh(raw_req),
        "executor.http_request" => handle_http_request(raw_req),
        "executor.execute" | "executor.execute_stream" | "executor.count_tokens" => Ok(error_envelope(
            "unsupported_execution",
            "cloud quota card currently supports HTTP request execution",
            400,
        )),
        _ => Ok(error_envelope(
            "unknown_method",
            &format!("unknown method: {method}"),
            0,
        )),
    }
}

fn handle_auth_parse(raw_req: &[u8]) -> Result<Vec<u8>, String> {
    let req: AuthParseRequest =
        serde_json::from_slice(raw_req).map_err(|err| format!("decode auth parse request: {err}"))?;
    let Some(card) = parse_quota_card(&req.raw_json) else {
        return ok_envelope(json!({ "Handled": false }));
    };
    let file_name = first_non_empty(&[card.file_name.as_deref(), req.file_name.as_deref()])
        .unwrap_or("cloud-quota-card.json")
        .to_string();
    let id = first_non_empty(&[card.cloud_file_id.as_deref()]).unwrap_or("local");
    ok_envelope(json!({
        "Handled": true,
        "Auth": auth_data(
            format!("quota-card-{id}"),
            file_name,
            card.display_name.as_deref().unwrap_or("Cloud quota card").to_string(),
            &req.raw_json,
            &card,
        )
    }))
}

fn handle_auth_refresh(raw_req: &[u8]) -> Result<Vec<u8>, String> {
    let req: AuthRefreshRequest = serde_json::from_slice(raw_req)
        .map_err(|err| format!("decode auth refresh request: {err}"))?;
    let Some(card) = parse_quota_card(&req.storage_json) else {
        return Ok(error_envelope(
            "invalid_quota_card",
            "stored auth is not a cloud quota card",
            400,
        ));
    };
    let auth_id = req
        .auth_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("quota-card-{}", card.cloud_file_id.as_deref().unwrap_or("local")));
    ok_envelope(json!({
        "Auth": auth_data(
            auth_id,
            card.file_name.as_deref().unwrap_or("cloud-quota-card.json").to_string(),
            card.display_name.as_deref().unwrap_or("Cloud quota card").to_string(),
            &req.storage_json,
            &card,
        )
    }))
}

fn handle_http_request(raw_req: &[u8]) -> Result<Vec<u8>, String> {
    let req: ExecutorHTTPRequest = serde_json::from_slice(raw_req)
        .map_err(|err| format!("decode executor http request: {err}"))?;
    let Some(card) = parse_quota_card(&req.storage_json) else {
        return Ok(error_envelope(
            "invalid_quota_card",
            "selected auth is not a cloud quota card",
            401,
        ));
    };
    if let Err(error) = check_quota(&card, MIN_CHARGE_USD_MICRO) {
        return Ok(error_envelope("quota_limited", &error, 402));
    }
    let mut decrypted = match decrypt_card(&card) {
        Ok(value) => value,
        Err(error) => return Ok(error_envelope("decrypt_failed", &error, 401)),
    };
    let mut headers = req.headers;
    apply_credential_headers(&mut headers, card.provider.as_deref().unwrap_or(""), &decrypted, &req.url);
    let resp = call_host_http(&HostHTTPRequest {
        method: req.method,
        url: req.url,
        headers,
        body: req.body,
    })?;
    decrypted.fill(0);
    if (200..500).contains(&resp.status_code) {
        let charge = charge_usd_micro(&card, &resp.body);
        let _ = report_usage(&card, charge);
    }
    ok_envelope(serde_json::to_value(resp).map_err(|err| err.to_string())?)
}

fn auth_data(
    id: String,
    file_name: String,
    label: String,
    storage_json: &[u8],
    card: &QuotaCardPackage,
) -> Value {
    json!({
        "Provider": PLUGIN_ID,
        "ID": id,
        "FileName": file_name,
        "Label": label,
        "StorageJSON": BASE64.encode(storage_json),
        "Metadata": {
            "type": PLUGIN_ID,
            "provider": card.provider.as_deref().unwrap_or(""),
            "cloud_file_id": card.cloud_file_id.as_deref().unwrap_or(""),
            "quota_limit": card.quota_limit.unwrap_or_default(),
            "quota_used": card.quota_used.unwrap_or_default()
        },
        "Attributes": {
            "auth_kind": "cloud_quota_card",
            "card_provider": card.provider.as_deref().unwrap_or(""),
            "cloud_file_id": card.cloud_file_id.as_deref().unwrap_or("")
        }
    })
}

fn parse_quota_card(raw: &[u8]) -> Option<QuotaCardPackage> {
    if raw.iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    let card: QuotaCardPackage = serde_json::from_slice(raw).ok()?;
    let kind_ok = card.kind.as_deref() == Some("cloud_quota_card")
        || card.r#type.as_deref() == Some("cloud-quota-card");
    if !kind_ok {
        return None;
    }
    let has_id = card.cloud_file_id.as_deref().unwrap_or("").trim().is_empty() == false;
    let has_cipher = card.cipher.as_deref().unwrap_or("").trim().is_empty() == false;
    has_id.then_some(card).filter(|_| has_cipher)
}

fn decrypt_card(card: &QuotaCardPackage) -> Result<Vec<u8>, String> {
    let sealed = BASE64
        .decode(card.cipher.as_deref().unwrap_or("").trim())
        .map_err(|err| format!("decode card cipher: {err}"))?;
    let key_hash = Sha256::digest(LOCAL_KEY_MATERIAL.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key_hash).map_err(|err| err.to_string())?;
    if sealed.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce, payload) = sealed.split_at(12);
    cipher
        .decrypt(Nonce::from_slice(nonce), payload)
        .map_err(|err| format!("decrypt card cipher: {err}"))
}

fn apply_credential_headers(
    headers: &mut BTreeMap<String, Vec<String>>,
    provider: &str,
    decrypted: &[u8],
    target_url: &str,
) {
    let credential: Value = serde_json::from_slice(decrypted).unwrap_or(Value::Null);
    let attrs = string_map(credential.get("attributes").or_else(|| credential.get("Attributes")));
    let meta = any_map(credential.get("metadata").or_else(|| credential.get("Metadata")));
    for (key, value) in &attrs {
        if key.to_ascii_lowercase().starts_with("header:") {
            set_header(headers, key[7..].trim(), value);
        }
    }
    if let Some(api_key) = first_string(&credential, &attrs, &meta, &["api_key", "apiKey", "key"]) {
        if provider.eq_ignore_ascii_case("claude") && is_anthropic_url(target_url) {
            del_header(headers, "Authorization");
            set_header(headers, "x-api-key", &api_key);
        } else {
            set_header(headers, "Authorization", &format!("Bearer {api_key}"));
        }
    }
    if let Some(token) = first_string(&credential, &attrs, &meta, &["access_token", "accessToken", "token"]) {
        set_header(headers, "Authorization", &format!("Bearer {token}"));
    }
    if let Some(account_id) = first_string(&credential, &attrs, &meta, &["account_id", "accountID", "account"]) {
        set_header(headers, "Chatgpt-Account-Id", &account_id);
    }
}

fn check_quota(card: &QuotaCardPackage, units: i64) -> Result<(), String> {
    let base = card.cloud_base_url.as_deref().unwrap_or("").trim_end_matches('/');
    if base.is_empty() {
        return Err("missing cloud base url".to_string());
    }
    let url = format!(
        "{}/quota-cards/{}/check",
        base,
        urlencoding::encode(card.cloud_file_id.as_deref().unwrap_or(""))
    );
    let resp = call_host_http(&HostHTTPRequest {
        method: "POST".to_string(),
        url,
        headers: content_type_headers(),
        body: serde_json::to_vec(&json!({ "quotaToken": card.quota_token, "units": units }))
            .map_err(|err| err.to_string())?,
    })?;
    if !(200..300).contains(&resp.status_code) {
        return Err(format!("cloud quota check failed: {}", resp.status_code));
    }
    let out: Value = serde_json::from_slice(&resp.body).map_err(|err| format!("decode quota check: {err}"))?;
    if !out.get("allowed").and_then(Value::as_bool).unwrap_or(false) {
        return Err("quota card limit reached".to_string());
    }
    Ok(())
}

fn report_usage(card: &QuotaCardPackage, units: i64) -> Result<(), String> {
    let base = card.cloud_base_url.as_deref().unwrap_or("").trim_end_matches('/');
    if base.is_empty() {
        return Ok(());
    }
    let url = format!(
        "{}/quota-cards/{}/usage",
        base,
        urlencoding::encode(card.cloud_file_id.as_deref().unwrap_or(""))
    );
    let _ = call_host_http(&HostHTTPRequest {
        method: "POST".to_string(),
        url,
        headers: content_type_headers(),
        body: serde_json::to_vec(&json!({ "quotaToken": card.quota_token, "units": units }))
            .map_err(|err| err.to_string())?,
    })?;
    Ok(())
}

fn charge_usd_micro(card: &QuotaCardPackage, body: &[u8]) -> i64 {
    let (input, output, total) = usage_tokens(body);
    let total = if total > 0 { total } else { input + output };
    if total <= 0 {
        return MIN_CHARGE_USD_MICRO;
    }
    let multiplier = card.billing_multiplier.unwrap_or(1000).max(1);
    let base = card
        .quota_base_tokens_per_dollar
        .unwrap_or(BASE_TOKENS_PER_USD)
        .max(1);
    let charge = ((total as f64) * (multiplier as f64) * 1000.0 / (base as f64)).ceil() as i64;
    charge.max(MIN_CHARGE_USD_MICRO)
}

fn usage_tokens(body: &[u8]) -> (i64, i64, i64) {
    let Ok(root) = serde_json::from_slice::<Value>(body) else {
        return (0, 0, 0);
    };
    let mut input = 0;
    let mut output = 0;
    let mut total = 0;
    find_usage(&root, &mut input, &mut output, &mut total);
    (input, output, total)
}

fn find_usage(value: &Value, input: &mut i64, output: &mut i64, total: &mut i64) {
    match value {
        Value::Object(map) => {
            if let Some(usage) = map.get("usage") {
                apply_usage_map(usage, input, output, total);
            }
            apply_usage_map(value, input, output, total);
            for child in map.values() {
                find_usage(child, input, output, total);
            }
        }
        Value::Array(items) => {
            for item in items {
                find_usage(item, input, output, total);
            }
        }
        _ => {}
    }
}

fn apply_usage_map(value: &Value, input: &mut i64, output: &mut i64, total: &mut i64) {
    let Some(map) = value.as_object() else {
        return;
    };
    if *input <= 0 {
        *input = first_i64(map, &["prompt_tokens", "input_tokens", "promptTokens", "inputTokens"]);
    }
    if *output <= 0 {
        *output = first_i64(map, &["completion_tokens", "output_tokens", "completionTokens", "outputTokens"]);
    }
    if *total <= 0 {
        *total = first_i64(map, &["total_tokens", "totalTokens"]);
    }
}

fn call_host_http(req: &HostHTTPRequest) -> Result<HostHTTPResponse, String> {
    let payload = serde_json::to_vec(req).map_err(|err| err.to_string())?;
    let result = call_host("host.http.do", &payload)?;
    serde_json::from_slice(&result).map_err(|err| format!("decode host http response: {err}"))
}

fn call_host(method: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        if STORED_HOST.is_null() {
            return Err("host callback is not available".to_string());
        }
        let host = &*STORED_HOST;
        let Some(call) = host.call else {
            return Err("host callback is not available".to_string());
        };
        let c_method = CString::new(method).map_err(|err| err.to_string())?;
        let mut response = CliproxyBuffer {
            ptr: ptr::null_mut(),
            len: 0,
        };
        let rc = call(
            host.host_ctx,
            c_method.as_ptr(),
            payload.as_ptr(),
            payload.len(),
            &mut response,
        );
        if rc != 0 {
            return Err(format!("host callback failed: {method}"));
        }
        if response.ptr.is_null() || response.len == 0 {
            return Err(format!("empty host callback response: {method}"));
        }
        let raw = std::slice::from_raw_parts(response.ptr, response.len).to_vec();
        if let Some(free_buffer) = host.free_buffer {
            free_buffer(response.ptr as *mut c_void, response.len);
        }
        let envelope: Envelope =
            serde_json::from_slice(&raw).map_err(|err| format!("decode host callback envelope: {err}"))?;
        if !envelope.ok {
            return Err(envelope
                .error
                .map(|err| err.message)
                .unwrap_or_else(|| "host callback returned error".to_string()));
        }
        Ok(envelope.result.unwrap_or(Value::Null).to_string().into_bytes())
    }
}

fn ok_envelope(result: Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({ "ok": true, "result": result })).map_err(|err| err.to_string())
}

fn error_envelope(code: &str, message: &str, status: i64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "http_status": status
        }
    }))
    .unwrap_or_else(|_| b"{\"ok\":false}".to_vec())
}

fn read_cstr(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("method is required".to_string());
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map(|value| value.to_string())
        .map_err(|_| "method is not utf-8".to_string())
}

fn write_response(response: *mut CliproxyBuffer, raw: &[u8]) {
    if response.is_null() || raw.is_empty() {
        return;
    }
    let mut bytes = raw.to_vec();
    let len = bytes.len();
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    unsafe {
        (*response).ptr = ptr;
        (*response).len = len;
    }
}

fn set_header(headers: &mut BTreeMap<String, Vec<String>>, key: &str, value: &str) {
    let key = key.trim();
    let value = value.trim();
    if key.is_empty() || value.is_empty() {
        return;
    }
    del_header(headers, key);
    headers.insert(key.to_string(), vec![value.to_string()]);
}

fn del_header(headers: &mut BTreeMap<String, Vec<String>>, key: &str) {
    let existing = headers
        .keys()
        .find(|existing| existing.eq_ignore_ascii_case(key))
        .cloned();
    if let Some(existing) = existing {
        headers.remove(&existing);
    }
}

fn first_string(
    credential: &Value,
    attrs: &BTreeMap<String, String>,
    meta: &Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(value) = attrs.get(*key).filter(|value| !value.trim().is_empty()) {
            return Some(value.trim().to_string());
        }
        if let Some(value) = meta.get(*key).and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
            return Some(value.trim().to_string());
        }
        if let Some(value) = credential.get(*key).and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = value {
        for (key, value) in map {
            if let Some(value) = value.as_str().filter(|value| !value.trim().is_empty()) {
                out.insert(key.clone(), value.trim().to_string());
            }
        }
    }
    out
}

fn any_map(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn is_anthropic_url(raw: &str) -> bool {
    raw.starts_with("https://api.anthropic.com/") || raw.starts_with("http://api.anthropic.com/")
}

fn first_non_empty<'a>(values: &[Option<&'a str>]) -> Option<&'a str> {
    values
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
}

fn first_i64(map: &Map<String, Value>, keys: &[&str]) -> i64 {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .filter_map(Value::as_i64)
        .find(|value| *value > 0)
        .unwrap_or(0)
}

fn content_type_headers() -> BTreeMap<String, Vec<String>> {
    BTreeMap::from([("Content-Type".to_string(), vec!["application/json".to_string()])])
}

fn bytes_from_json<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(text) => BASE64.decode(text).map_err(serde::de::Error::custom),
        Value::Array(items) => items
            .into_iter()
            .map(|item| {
                item.as_u64()
                    .and_then(|value| u8::try_from(value).ok())
                    .ok_or_else(|| serde::de::Error::custom("invalid byte value"))
            })
            .collect(),
        Value::Null => Ok(Vec::new()),
        _ => Err(serde::de::Error::custom("expected base64 string or byte array")),
    }
}

fn bytes_to_json<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&BASE64.encode(bytes))
}

#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    result: Option<Value>,
    error: Option<EnvelopeError>,
}

#[derive(Deserialize)]
struct EnvelopeError {
    message: String,
}

#[derive(Deserialize)]
struct QuotaCardPackage {
    kind: Option<String>,
    #[serde(rename = "type")]
    r#type: Option<String>,
    cloud_file_id: Option<String>,
    provider: Option<String>,
    display_name: Option<String>,
    file_name: Option<String>,
    quota_limit: Option<i64>,
    quota_used: Option<i64>,
    billing_multiplier: Option<i64>,
    quota_base_tokens_per_dollar: Option<i64>,
    cipher: Option<String>,
    quota_token: Option<String>,
    cloud_base_url: Option<String>,
}

#[derive(Deserialize)]
struct AuthParseRequest {
    #[serde(rename = "FileName")]
    file_name: Option<String>,
    #[serde(rename = "RawJSON", deserialize_with = "bytes_from_json")]
    raw_json: Vec<u8>,
}

#[derive(Deserialize)]
struct AuthRefreshRequest {
    #[serde(rename = "AuthID")]
    auth_id: Option<String>,
    #[serde(rename = "StorageJSON", deserialize_with = "bytes_from_json")]
    storage_json: Vec<u8>,
}

#[derive(Deserialize)]
struct ExecutorHTTPRequest {
    #[serde(rename = "Method")]
    method: String,
    #[serde(rename = "URL")]
    url: String,
    #[serde(rename = "Headers")]
    headers: BTreeMap<String, Vec<String>>,
    #[serde(rename = "Body", deserialize_with = "bytes_from_json")]
    body: Vec<u8>,
    #[serde(rename = "StorageJSON", deserialize_with = "bytes_from_json")]
    storage_json: Vec<u8>,
}

#[derive(Serialize)]
struct HostHTTPRequest {
    method: String,
    url: String,
    headers: BTreeMap<String, Vec<String>>,
    #[serde(serialize_with = "bytes_to_json")]
    body: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct HostHTTPResponse {
    #[serde(rename = "StatusCode")]
    status_code: i64,
    #[serde(rename = "Headers")]
    headers: BTreeMap<String, Vec<String>>,
    #[serde(rename = "Body", deserialize_with = "bytes_from_json", serialize_with = "bytes_to_json")]
    body: Vec<u8>,
}
