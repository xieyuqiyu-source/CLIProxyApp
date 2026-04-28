use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use serde_yaml::{Mapping, Number, Value as YamlValue};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Cursor, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Signal, System};
use tauri::{AppHandle, Emitter, Manager};

const OPENCLAW_SETUP_LOG_EVENT: &str = "openclaw-setup-log";
const CLOUD_BASE_URL_DEV: &str = "https://cliproxy.szxsai.com/api/v1";
const CLOUD_BASE_URL_RELEASE: &str = "https://cliproxy.szxsai.com/api/v1";
const CONTINUE_CHAT_MODEL_NAME: &str = "CLIProxy Chat";
const CONTINUE_AUTOCOMPLETE_MODEL_NAME: &str = "CLIProxy Autocomplete";
const APP_UPDATE_MANIFEST_PATHS: [&str; 3] = [
    "/downloads/cliproxyapp/latest.json",
    "/cliproxyapp/latest.json",
    "/latest.json",
];
const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/xieyuqiyu-source/CLIProxyApp/releases/latest";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSettings {
    pub api_port: u16,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_management_key")]
    pub management_key: String,
    pub auto_start: bool,
    pub binary_mode: String,
    pub explicit_binary_path: Option<String>,
}

impl Default for BootstrapSettings {
    fn default() -> Self {
        Self {
            host: default_host(),
            api_port: 8317,
            management_key: default_management_key(),
            auto_start: true,
            binary_mode: "development".to_string(),
            explicit_binary_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePaths {
    pub app_data_dir: String,
    pub runtime_dir: String,
    pub static_dir: String,
    pub config_dir: String,
    pub logs_dir: String,
    pub bootstrap_path: String,
    pub config_path: String,
    pub stdout_log_path: String,
    pub stderr_log_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub app_name: String,
    pub app_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaState {
    pub status: String,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub api_port: u16,
    pub binary_path: Option<String>,
    pub config_path: String,
    pub logs_dir: String,
    pub last_error: Option<String>,
    pub browser_management_disabled: bool,
    pub runtime_mode_label: String,
    pub bootstrap: BootstrapSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementProxyRequest {
    pub method: String,
    pub path: String,
    pub query: Option<Vec<(String, String)>>,
    pub body: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaManagementInfo {
    pub management_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAuthInputFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAuthFilesResult {
    pub imported_count: usize,
    pub extracted_count: usize,
    pub skipped: Vec<String>,
    pub response: JsonValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAuthArchiveResult {
    pub file_name: String,
    pub file_count: usize,
    pub saved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawSetupResult {
    pub config_path: String,
    pub provider_id: String,
    pub model_count: usize,
    pub alias: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawConfigState {
    pub available_models: Vec<String>,
    pub recommended_primary_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawSetupInput {
    #[serde(default = "default_openclaw_config_mode")]
    pub mode: OpenClawConfigMode,
    #[serde(default)]
    pub selected_models: Vec<String>,
    #[serde(default)]
    pub primary_model: Option<String>,
    #[serde(default)]
    pub fallback_models: Vec<String>,
    #[serde(default)]
    pub clear_other_models: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenClawConfigMode {
    Legacy,
    Modern,
}

fn default_openclaw_config_mode() -> OpenClawConfigMode {
    OpenClawConfigMode::Legacy
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigState {
    pub config_path: String,
    pub exists: bool,
    pub current_model: Option<String>,
    pub current_base_url: Option<String>,
    pub available_models: Vec<String>,
    pub can_restore_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigUpdateResult {
    pub config_path: String,
    pub model: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigRestoreResult {
    pub config_path: String,
    pub restored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueConfigState {
    pub config_path: String,
    pub exists: bool,
    pub current_base_url: Option<String>,
    pub chat_model: Option<String>,
    pub autocomplete_model: Option<String>,
    pub recommended_chat_model: Option<String>,
    pub recommended_autocomplete_model: Option<String>,
    pub available_models: Vec<String>,
    pub can_restore_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueConfigSetupInput {
    pub chat_model: String,
    pub autocomplete_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueConfigSetupResult {
    pub config_path: String,
    pub base_url: String,
    pub chat_model: String,
    pub autocomplete_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueConfigRestoreResult {
    pub config_path: String,
    pub restored: bool,
}

#[derive(Debug, Clone)]
struct CommandSpec {
    program: PathBuf,
    args: Vec<String>,
    display: String,
}

const OPENCLAW_CLI_CACHE_FILE: &str = "openclaw-cli-path.txt";
const CODEX_CONFIG_BACKUP_FILE: &str = "codex-config-backup.json";
const CONTINUE_CONFIG_BACKUP_FILE: &str = "continue-config-backup.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfigBackup {
    existed: bool,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProxyRequest {
    pub method: String,
    pub path: String,
    pub body: Option<JsonValue>,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudUploadRequest {
    pub path: String,
    pub file_name: String,
    pub bytes: Vec<u8>,
    pub mime_type: Option<String>,
    pub fields: Option<HashMap<String, String>>,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDownloadRequest {
    pub path: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDownloadResult {
    pub file_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
struct RuntimeContext {
    paths: ResolvedPaths,
    bootstrap: BootstrapSettings,
}

#[derive(Debug, Clone)]
struct ResolvedPaths {
    app_data_dir: PathBuf,
    runtime_dir: PathBuf,
    static_dir: PathBuf,
    config_dir: PathBuf,
    logs_dir: PathBuf,
    bootstrap_path: PathBuf,
    config_path: PathBuf,
    stdout_log_path: PathBuf,
    stderr_log_path: PathBuf,
}

#[derive(Debug, Default)]
struct RuntimeInner {
    child: Option<Child>,
    started_at: Option<SystemTime>,
    last_error: Option<String>,
}

pub struct CpaRuntimeState {
    inner: Mutex<RuntimeInner>,
}

impl Default for CpaRuntimeState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner::default()),
        }
    }
}

pub fn get_app_state(app: &AppHandle) -> AppState {
    AppState {
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

pub fn get_runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let ctx = load_runtime_context(app)?;
    Ok(to_runtime_paths(&ctx.paths))
}

pub fn get_cpa_state(
    app: &AppHandle,
    state: &tauri::State<'_, CpaRuntimeState>,
) -> Result<CpaState, String> {
    let ctx = load_runtime_context(app)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "failed to lock runtime state".to_string())?;
    refresh_child_state(&mut inner);
    Ok(build_cpa_state(&ctx, &inner))
}

pub fn start_cpa(
    app: &AppHandle,
    state: &tauri::State<'_, CpaRuntimeState>,
) -> Result<CpaState, String> {
    let ctx = load_runtime_context(app)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "failed to lock runtime state".to_string())?;
    refresh_child_state(&mut inner);

    if inner.child.is_some() {
        return Ok(build_cpa_state(&ctx, &inner));
    }

    cleanup_stale_cpa_processes(&ctx.paths, None)?;
    write_runtime_config(&ctx)?;
    reset_log_files(&ctx.paths)?;

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ctx.paths.stdout_log_path)
        .map_err(|error| format!("failed to open stdout log file: {error}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ctx.paths.stderr_log_path)
        .map_err(|error| format!("failed to open stderr log file: {error}"))?;

    let mut command = build_cpa_command(&ctx)?;
    command.stdout(Stdio::from(stdout));
    command.stderr(Stdio::from(stderr));

    let child = command
        .spawn()
        .map_err(|error| format!("failed to start CLIProxyApi: {error}"))?;

    inner.last_error = None;
    inner.started_at = Some(SystemTime::now());
    inner.child = Some(child);

    if !wait_for_port(
        &ctx.bootstrap.host,
        ctx.bootstrap.api_port,
        Duration::from_secs(8),
    ) {
        inner.last_error = Some(
            "CPA process started but configured port did not become reachable in time".to_string(),
        );
    }

    refresh_child_state(&mut inner);
    Ok(build_cpa_state(&ctx, &inner))
}

pub fn stop_cpa(
    app: &AppHandle,
    state: &tauri::State<'_, CpaRuntimeState>,
) -> Result<CpaState, String> {
    let ctx = load_runtime_context(app)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "failed to lock runtime state".to_string())?;
    stop_child(&mut inner)?;
    Ok(build_cpa_state(&ctx, &inner))
}

pub fn restart_cpa(
    app: &AppHandle,
    state: &tauri::State<'_, CpaRuntimeState>,
) -> Result<CpaState, String> {
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "failed to lock runtime state".to_string())?;
        stop_child(&mut inner)?;
    }
    start_cpa(app, state)
}

pub fn shutdown_cpa(state: &tauri::State<'_, CpaRuntimeState>) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "failed to lock runtime state".to_string())?;
    stop_child(&mut inner)?;
    Ok(())
}

pub fn get_cpa_recent_logs(app: &AppHandle, max_lines: Option<usize>) -> Result<String, String> {
    let ctx = load_runtime_context(app)?;
    let line_count = max_lines.unwrap_or(120).clamp(10, 1000);
    let stdout = tail_file(&ctx.paths.stdout_log_path, line_count)?;
    let stderr = tail_file(&ctx.paths.stderr_log_path, line_count)?;

    Ok(format!(
        "== STDOUT ==\n{}\n\n== STDERR ==\n{}",
        if stdout.is_empty() {
            "<empty>".to_string()
        } else {
            stdout
        },
        if stderr.is_empty() {
            "<empty>".to_string()
        } else {
            stderr
        }
    ))
}

pub fn save_bootstrap_settings(
    app: &AppHandle,
    state: &tauri::State<'_, CpaRuntimeState>,
    settings: BootstrapSettings,
) -> Result<CpaState, String> {
    let paths = resolve_paths(app)?;
    ensure_directories(&paths)?;

    let mut normalized = settings;
    normalized.host = normalize_host(&normalized.host);
    if normalized.api_port == 0 {
        normalized.api_port = 8317;
    }
    if normalized.management_key.trim().is_empty() {
        normalized.management_key =
            load_existing_management_key(&paths).unwrap_or_else(default_management_key);
    }
    if normalized.binary_mode.trim().is_empty() {
        normalized.binary_mode = "development".to_string();
    }

    let content = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("failed to serialize bootstrap settings: {error}"))?;
    fs::write(&paths.bootstrap_path, content)
        .map_err(|error| format!("failed to write bootstrap settings: {error}"))?;

    let ctx = RuntimeContext {
        paths,
        bootstrap: normalized,
    };
    write_runtime_config(&ctx)?;

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "failed to lock runtime state".to_string())?;
    refresh_child_state(&mut inner);
    Ok(build_cpa_state(&ctx, &inner))
}

pub fn get_cpa_management_info(app: &AppHandle) -> Result<CpaManagementInfo, String> {
    let ctx = load_runtime_context(app)?;
    Ok(CpaManagementInfo {
        management_key: ctx.bootstrap.management_key,
    })
}

pub fn open_cpa_config_dir(app: &AppHandle) -> Result<(), String> {
    let ctx = load_runtime_context(app)?;
    open_path(&ctx.paths.config_dir)
}

pub fn open_cpa_log_dir(app: &AppHandle) -> Result<(), String> {
    let ctx = load_runtime_context(app)?;
    open_path(&ctx.paths.logs_dir)
}

pub fn proxy_management_request(
    app: &AppHandle,
    request: ManagementProxyRequest,
) -> Result<JsonValue, String> {
    let ctx = load_runtime_context(app)?;

    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|error| format!("invalid method: {error}"))?;

    let path = request.path.trim_start_matches('/');
    let url = format!(
        "http://{}:{}/v0/management/{}",
        ctx.bootstrap.host, ctx.bootstrap.api_port, path
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("failed to create management client: {error}"))?;

    let mut builder = client
        .request(method, &url)
        .bearer_auth(&ctx.bootstrap.management_key);

    if let Some(query) = request.query {
        builder = builder.query(&query);
    }

    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = builder
        .send()
        .map_err(|error| format!("management request failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read management response: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "management request failed with {}: {}",
            status, text
        ));
    }

    if text.trim().is_empty() {
        return Ok(JsonValue::Null);
    }

    Ok(serde_json::from_str::<JsonValue>(&text).unwrap_or(JsonValue::String(text)))
}

pub fn proxy_cloud_request(request: CloudProxyRequest) -> Result<JsonValue, String> {
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|error| format!("invalid cloud request method: {error}"))?;
    let url = cloud_url(&request.path);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("failed to create cloud client: {error}"))?;

    let mut builder = client.request(method, url);
    if let Some(token) = request
        .token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        builder = builder.bearer_auth(token);
    }

    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = builder
        .send()
        .map_err(|error| format!("cloud request failed: {error}"))?;
    parse_cloud_json_response(response)
}

pub fn proxy_cloud_upload(request: CloudUploadRequest) -> Result<JsonValue, String> {
    let url = cloud_url(&request.path);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to create cloud upload client: {error}"))?;

    let mime_type = request
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("application/octet-stream");

    let part = reqwest::blocking::multipart::Part::bytes(request.bytes)
        .file_name(request.file_name)
        .mime_str(mime_type)
        .map_err(|error| format!("failed to build upload part: {error}"))?;
    let mut form = reqwest::blocking::multipart::Form::new().part("file", part);
    if let Some(fields) = request.fields {
        for (key, value) in fields {
            form = form.text(key, value);
        }
    }

    let response = client
        .post(url)
        .bearer_auth(request.token)
        .multipart(form)
        .send()
        .map_err(|error| format!("cloud upload failed: {error}"))?;
    parse_cloud_json_response(response)
}

pub fn proxy_cloud_download(request: CloudDownloadRequest) -> Result<CloudDownloadResult, String> {
    let url = cloud_url(&request.path);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to create cloud download client: {error}"))?;

    let response = client
        .get(url)
        .bearer_auth(request.token)
        .send()
        .map_err(|error| format!("cloud download failed: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .map_err(|error| format!("failed to read cloud error response: {error}"))?;
        let message = serde_json::from_str::<JsonValue>(&text)
            .ok()
            .and_then(|payload| {
                payload
                    .get("error")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
            })
            .unwrap_or(text);
        return Err(if message.trim().is_empty() {
            format!("cloud download failed with {status}")
        } else {
            message
        });
    }

    let file_name = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_disposition_filename)
        .unwrap_or_else(|| "auth.json".to_string());
    let bytes = response
        .bytes()
        .map_err(|error| format!("failed to read cloud download bytes: {error}"))?
        .to_vec();

    Ok(CloudDownloadResult { file_name, bytes })
}

pub fn check_app_update(app: &AppHandle) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let checked_at = chrono_like_now_string();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to create update client: {error}"))?;
    let payload = fetch_update_manifest(&client)?;
    let latest_version = payload
        .get("version")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "update manifest missing version".to_string())?
        .to_string();

    let download_url = select_update_download_url(&payload)?;
    let notes = payload
        .get("notes")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let published_at = payload
        .get("publishedAt")
        .or_else(|| payload.get("published_at"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Ok(AppUpdateInfo {
        has_update: compare_versions(&latest_version, &current_version).is_gt(),
        current_version,
        latest_version,
        download_url,
        notes,
        published_at,
        checked_at,
    })
}

pub fn import_auth_files(
    app: &AppHandle,
    files: Vec<ImportAuthInputFile>,
) -> Result<ImportAuthFilesResult, String> {
    let ctx = load_runtime_context(app)?;
    if !wait_for_port(
        &ctx.bootstrap.host,
        ctx.bootstrap.api_port,
        Duration::from_millis(800),
    ) {
        return Err("CPA is not reachable. Start it before importing auth files.".to_string());
    }

    let mut extracted_files = Vec::new();
    let mut skipped = Vec::new();
    let mut used_names = HashSet::new();

    for file in files {
        let original_name = file.name.trim();
        if original_name.is_empty() {
            skipped.push("Skipped an unnamed file.".to_string());
            continue;
        }

        let lower_name = original_name.to_ascii_lowercase();
        if lower_name.ends_with(".json") {
            let file_name = unique_auth_file_name(original_name, &mut used_names);
            extracted_files.push((file_name, file.bytes));
            continue;
        }

        if lower_name.ends_with(".zip") {
            let nested_files =
                extract_auth_files_from_zip(&file.bytes, original_name, &mut used_names)?;
            if nested_files.is_empty() {
                skipped.push(format!(
                    "{original_name}: no .json auth files found in archive"
                ));
            } else {
                extracted_files.extend(nested_files);
            }
            continue;
        }

        skipped.push(format!("{original_name}: unsupported file type"));
    }

    if extracted_files.is_empty() {
        return Err(if skipped.is_empty() {
            "No auth files were selected.".to_string()
        } else {
            format!("No importable auth files found. {}", skipped.join("; "))
        });
    }

    let url = format!(
        "http://{}:{}/v0/management/auth-files",
        ctx.bootstrap.host, ctx.bootstrap.api_port
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to create management client: {error}"))?;

    let extracted_count = extracted_files.len();
    let mut form = reqwest::blocking::multipart::Form::new();
    for (index, (name, bytes)) in extracted_files.into_iter().enumerate() {
        let part = reqwest::blocking::multipart::Part::bytes(bytes)
            .file_name(name)
            .mime_str("application/json")
            .map_err(|error| format!("failed to create multipart part: {error}"))?;
        form = form.part(format!("file{index}"), part);
    }

    let response = client
        .post(url)
        .bearer_auth(&ctx.bootstrap.management_key)
        .multipart(form)
        .send()
        .map_err(|error| format!("failed to upload auth files: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read upload response: {error}"))?;

    if !status.is_success() {
        return Err(format!("auth file import failed with {status}: {text}"));
    }

    let response_json =
        serde_json::from_str::<JsonValue>(&text).unwrap_or(JsonValue::String(text.clone()));
    let imported_count = response_json
        .get("uploaded")
        .and_then(JsonValue::as_u64)
        .map(|value| value as usize)
        .unwrap_or(extracted_count);

    Ok(ImportAuthFilesResult {
        imported_count,
        extracted_count,
        skipped,
        response: response_json,
    })
}

pub fn export_auth_files_archive(app: &AppHandle) -> Result<ExportAuthArchiveResult, String> {
    let ctx = load_runtime_context(app)?;
    let auth_dir = resolve_auth_dir(&ctx.paths)?;
    if !auth_dir.exists() {
        return Err(format!(
            "auth directory does not exist: {}",
            auth_dir.display()
        ));
    }

    let mut auth_files = Vec::new();
    collect_auth_files(&auth_dir, &mut auth_files)?;
    auth_files.sort();

    if auth_files.is_empty() {
        return Err(format!(
            "no auth .json files found in {}",
            auth_dir.display()
        ));
    }

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut archive = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        for path in &auth_files {
            let relative = path
                .strip_prefix(&auth_dir)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let data = fs::read(path)
                .map_err(|error| format!("failed to read auth file {}: {error}", path.display()))?;
            archive
                .start_file(relative, options)
                .map_err(|error| format!("failed to add auth file to archive: {error}"))?;
            archive
                .write_all(&data)
                .map_err(|error| format!("failed to write auth archive entry: {error}"))?;
        }

        archive
            .finish()
            .map_err(|error| format!("failed to finalize auth archive: {error}"))?;
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let file_name = format!("auth-files-{timestamp}.zip");
    let Some(save_path) = rfd::FileDialog::new()
        .add_filter("ZIP archive", &["zip"])
        .set_file_name(&file_name)
        .save_file()
    else {
        return Ok(ExportAuthArchiveResult {
            file_name,
            file_count: auth_files.len(),
            saved_path: None,
        });
    };

    fs::write(&save_path, cursor.into_inner()).map_err(|error| {
        format!(
            "failed to save auth archive {}: {error}",
            save_path.display()
        )
    })?;

    Ok(ExportAuthArchiveResult {
        file_name,
        file_count: auth_files.len(),
        saved_path: Some(save_path.display().to_string()),
    })
}

pub fn get_local_auth_files(app: &AppHandle) -> Result<Vec<LocalAuthFile>, String> {
    let ctx = load_runtime_context(app)?;
    let auth_dir = resolve_auth_dir(&ctx.paths)?;
    if !auth_dir.exists() {
        return Ok(Vec::new());
    }

    let mut auth_files = Vec::new();
    collect_auth_files(&auth_dir, &mut auth_files)?;
    auth_files.sort();

    let mut result = Vec::with_capacity(auth_files.len());
    for path in auth_files {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("invalid auth file name: {}", path.display()))?
            .to_string();
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        result.push(LocalAuthFile { name, bytes });
    }

    Ok(result)
}

pub fn pick_local_auth_files(app: &AppHandle) -> Result<Vec<LocalAuthFile>, String> {
    let ctx = load_runtime_context(app)?;
    let auth_dir = resolve_auth_dir(&ctx.paths)?;

    let files = rfd::FileDialog::new()
        .set_directory(&auth_dir)
        .add_filter("JSON", &["json"])
        .pick_files();

    let Some(files) = files else {
        return Ok(Vec::new());
    };

    let mut result = Vec::new();
    for path in files {
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("json"));
        if !is_json {
            continue;
        }

        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("invalid auth file name: {}", path.display()))?
            .to_string();
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        result.push(LocalAuthFile { name, bytes });
    }

    Ok(result)
}

pub fn open_external_target(target: &str) -> Result<(), String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("target is required".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command.arg(trimmed);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("failed to open external target {trimmed}: {error}"))?;
    Ok(())
}

pub fn import_vertex_credential(
    app: &AppHandle,
    file: ImportAuthInputFile,
    location: Option<String>,
) -> Result<JsonValue, String> {
    let ctx = load_runtime_context(app)?;
    if !wait_for_port(
        &ctx.bootstrap.host,
        ctx.bootstrap.api_port,
        Duration::from_millis(800),
    ) {
        return Err(
            "CPA is not reachable. Start it before importing Vertex credentials.".to_string(),
        );
    }

    let file_name = file.name.trim();
    if file_name.is_empty() {
        return Err("Vertex credential file is required.".to_string());
    }

    let url = format!(
        "http://{}:{}/v0/management/vertex/import",
        ctx.bootstrap.host, ctx.bootstrap.api_port
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to create management client: {error}"))?;

    let part = reqwest::blocking::multipart::Part::bytes(file.bytes)
        .file_name(file_name.to_string())
        .mime_str("application/json")
        .map_err(|error| format!("failed to create vertex upload part: {error}"))?;

    let mut form = reqwest::blocking::multipart::Form::new().part("file", part);
    if let Some(location) = location
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        form = form.text("location", location);
    }

    let response = client
        .post(url)
        .bearer_auth(&ctx.bootstrap.management_key)
        .multipart(form)
        .send()
        .map_err(|error| format!("failed to import Vertex credential: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read Vertex import response: {error}"))?;

    if !status.is_success() {
        return Err(format!("vertex import failed with {status}: {text}"));
    }

    Ok(serde_json::from_str::<JsonValue>(&text).unwrap_or(JsonValue::String(text)))
}

pub fn get_openclaw_config_state(app: &AppHandle) -> Result<OpenClawConfigState, String> {
    let ctx = load_runtime_context(app)?;
    let api_host = if ctx.bootstrap.host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        ctx.bootstrap.host.clone()
    };
    let base_url = format!("http://{}:{}/v1", api_host, ctx.bootstrap.api_port);
    let available_models = fetch_openclaw_models(&base_url, &ctx.bootstrap.management_key)?;
    let recommended_primary_model = select_openclaw_primary_model(&available_models);

    Ok(OpenClawConfigState {
        available_models,
        recommended_primary_model,
    })
}

pub fn setup_openclaw_provider(
    app: &AppHandle,
    input: OpenClawSetupInput,
) -> Result<OpenClawSetupResult, String> {
    let ctx = load_runtime_context(app)?;
    let mut logs = Vec::new();

    log_openclaw(app, &mut logs, "开始接入 OpenClaw...");
    let openclaw_cmd = resolve_openclaw_command(app, &mut logs)?;
    log_openclaw(
        app,
        &mut logs,
        &format!("检测 OpenClaw CLI: {}", openclaw_cmd.display),
    );
    let config_path = resolve_openclaw_config_path(&openclaw_cmd, app, &mut logs)?;

    let api_host = if ctx.bootstrap.host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        ctx.bootstrap.host.clone()
    };
    let base_url = format!("http://{}:{}/v1", api_host, ctx.bootstrap.api_port);
    log_openclaw(app, &mut logs, &format!("探测代理接口: {base_url}/models"));

    let available_models = fetch_openclaw_models(&base_url, &ctx.bootstrap.management_key)?;
    if available_models.is_empty() {
        return Err("OpenClaw 接入失败：/v1/models 未返回任何模型".to_string());
    }
    let models = resolve_openclaw_selected_models(&input, &available_models)?;
    let primary_model = resolve_openclaw_primary_model(&input, &models)?;
    let fallback_models =
        resolve_openclaw_fallback_models(&input, &models, primary_model.as_deref())?;
    log_openclaw(
        app,
        &mut logs,
        &format!("已发现 {} 个模型，准备写入配置", models.len()),
    );

    let mut root = load_or_create_openclaw_config(&config_path, app, &mut logs)?;
    apply_openclaw_provider_config(
        &mut root,
        &base_url,
        &ctx.bootstrap.management_key,
        &models,
        &input.mode,
        primary_model.as_deref(),
        &fallback_models,
        input.clear_other_models,
    );
    write_openclaw_config(&config_path, &root, app, &mut logs)?;
    validate_openclaw_config(&openclaw_cmd, app, &mut logs)?;

    log_openclaw(
        app,
        &mut logs,
        &format!(
            "OpenClaw 接入完成。mode={:?}, provider=cliproxy, alias=cliproxy, models={}",
            input.mode,
            models.len()
        ),
    );

    Ok(OpenClawSetupResult {
        config_path: config_path.display().to_string(),
        provider_id: "cliproxy".to_string(),
        model_count: models.len(),
        alias: "cliproxy".to_string(),
    })
}

pub fn get_codex_config_state(app: &AppHandle) -> Result<CodexConfigState, String> {
    let ctx = load_runtime_context(app)?;
    let config_path = resolve_codex_config_path()?;
    let exists = config_path.exists();
    let (current_model, current_base_url) = if exists {
        read_codex_config_values(&config_path)?
    } else {
        (None, None)
    };
    let api_host = if ctx.bootstrap.host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        ctx.bootstrap.host.clone()
    };
    let base_url = format!("http://{}:{}/v1", api_host, ctx.bootstrap.api_port);
    let available_models = fetch_openclaw_models(&base_url, &ctx.bootstrap.management_key)?;

    Ok(CodexConfigState {
        config_path: config_path.display().to_string(),
        exists,
        current_model,
        current_base_url,
        available_models,
        can_restore_default: codex_backup_path(app)?.exists(),
    })
}

pub fn set_codex_config_model(
    app: &AppHandle,
    model: String,
) -> Result<CodexConfigUpdateResult, String> {
    let trimmed_model = model.trim();
    if trimmed_model.is_empty() {
        return Err("模型不能为空".to_string());
    }

    let ctx = load_runtime_context(app)?;
    let api_host = if ctx.bootstrap.host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        ctx.bootstrap.host.clone()
    };
    let base_url = format!("http://{}:{}/v1", api_host, ctx.bootstrap.api_port);
    let available_models = fetch_openclaw_models(&base_url, &ctx.bootstrap.management_key)?;
    if !available_models.iter().any(|item| item == trimmed_model) {
        return Err(format!("当前代理未提供模型：{trimmed_model}"));
    }

    let config_path = resolve_codex_config_path()?;
    ensure_codex_backup(app, &config_path)?;
    write_codex_config_values(&config_path, trimmed_model, &base_url)?;

    Ok(CodexConfigUpdateResult {
        config_path: config_path.display().to_string(),
        model: trimmed_model.to_string(),
        base_url,
    })
}

pub fn restore_codex_config_default(app: &AppHandle) -> Result<CodexConfigRestoreResult, String> {
    let config_path = resolve_codex_config_path()?;
    let backup_path = codex_backup_path(app)?;
    let backup_raw = fs::read_to_string(&backup_path)
        .map_err(|error| format!("读取 Codex 备份失败 {}: {error}", backup_path.display()))?;
    let backup = serde_json::from_str::<FileConfigBackup>(&backup_raw)
        .map_err(|error| format!("解析 Codex 备份失败 {}: {error}", backup_path.display()))?;

    if backup.existed {
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建 Codex 配置目录失败 {}: {error}", parent.display())
            })?;
        }
        fs::write(&config_path, backup.content)
            .map_err(|error| format!("恢复 Codex 配置失败 {}: {error}", config_path.display()))?;
    } else if config_path.exists() {
        fs::remove_file(&config_path)
            .map_err(|error| format!("删除 Codex 配置失败 {}: {error}", config_path.display()))?;
    }

    fs::remove_file(&backup_path)
        .map_err(|error| format!("清理 Codex 备份失败 {}: {error}", backup_path.display()))?;

    Ok(CodexConfigRestoreResult {
        config_path: config_path.display().to_string(),
        restored: true,
    })
}

pub fn get_continue_config_state(app: &AppHandle) -> Result<ContinueConfigState, String> {
    let ctx = load_runtime_context(app)?;
    let config_path = resolve_continue_config_path()?;
    let exists = config_path.exists();
    let (current_base_url, chat_model, autocomplete_model) = if exists {
        read_continue_config_values(&config_path)?
    } else {
        (None, None, None)
    };
    let api_host = if ctx.bootstrap.host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        ctx.bootstrap.host.clone()
    };
    let base_url = format!("http://{}:{}/v1", api_host, ctx.bootstrap.api_port);
    let available_models = fetch_openclaw_models(&base_url, &ctx.bootstrap.management_key)?;
    let recommended_chat_model = select_continue_chat_model(&available_models);
    let recommended_autocomplete_model = recommended_chat_model
        .as_ref()
        .and_then(|chat_model| select_continue_autocomplete_model(&available_models, chat_model));

    Ok(ContinueConfigState {
        config_path: config_path.display().to_string(),
        exists,
        current_base_url,
        chat_model,
        autocomplete_model,
        recommended_chat_model,
        recommended_autocomplete_model,
        available_models,
        can_restore_default: continue_backup_path(app)?.exists(),
    })
}

pub fn setup_continue_config(
    app: &AppHandle,
    input: ContinueConfigSetupInput,
) -> Result<ContinueConfigSetupResult, String> {
    let ctx = load_runtime_context(app)?;
    let api_host = if ctx.bootstrap.host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        ctx.bootstrap.host.clone()
    };
    let base_url = format!("http://{}:{}/v1", api_host, ctx.bootstrap.api_port);
    let available_models = fetch_openclaw_models(&base_url, &ctx.bootstrap.management_key)?;
    if available_models.is_empty() {
        return Err("Continue 配置失败：/v1/models 未返回任何模型".to_string());
    }

    let chat_model = input.chat_model.trim().to_string();
    if chat_model.is_empty() {
        return Err("Continue 配置失败：聊天模型不能为空".to_string());
    }
    if !available_models.iter().any(|model| model == &chat_model) {
        return Err(format!(
            "Continue 配置失败：聊天模型 `{chat_model}` 不在当前代理返回的模型列表中"
        ));
    }

    let autocomplete_model = input.autocomplete_model.trim().to_string();
    if autocomplete_model.is_empty() {
        return Err("Continue 配置失败：补全模型不能为空".to_string());
    }
    if !available_models
        .iter()
        .any(|model| model == &autocomplete_model)
    {
        return Err(format!(
            "Continue 配置失败：补全模型 `{autocomplete_model}` 不在当前代理返回的模型列表中"
        ));
    }

    let config_path = resolve_continue_config_path()?;
    ensure_continue_backup(app, &config_path)?;
    write_continue_config_values(
        &config_path,
        &base_url,
        &ctx.bootstrap.management_key,
        &chat_model,
        &autocomplete_model,
    )?;

    Ok(ContinueConfigSetupResult {
        config_path: config_path.display().to_string(),
        base_url,
        chat_model,
        autocomplete_model,
    })
}

pub fn restore_continue_config_default(
    app: &AppHandle,
) -> Result<ContinueConfigRestoreResult, String> {
    let config_path = resolve_continue_config_path()?;
    let backup_path = continue_backup_path(app)?;
    let backup_raw = fs::read_to_string(&backup_path)
        .map_err(|error| format!("读取 Continue 备份失败 {}: {error}", backup_path.display()))?;
    let backup = serde_json::from_str::<FileConfigBackup>(&backup_raw)
        .map_err(|error| format!("解析 Continue 备份失败 {}: {error}", backup_path.display()))?;

    if backup.existed {
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建 Continue 配置目录失败 {}: {error}", parent.display())
            })?;
        }
        fs::write(&config_path, backup.content).map_err(|error| {
            format!("恢复 Continue 配置失败 {}: {error}", config_path.display())
        })?;
    } else if config_path.exists() {
        fs::remove_file(&config_path).map_err(|error| {
            format!("删除 Continue 配置失败 {}: {error}", config_path.display())
        })?;
    }

    fs::remove_file(&backup_path)
        .map_err(|error| format!("清理 Continue 备份失败 {}: {error}", backup_path.display()))?;

    Ok(ContinueConfigRestoreResult {
        config_path: config_path.display().to_string(),
        restored: true,
    })
}

fn extract_auth_files_from_zip(
    archive_bytes: &[u8],
    archive_name: &str,
    used_names: &mut HashSet<String>,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let cursor = Cursor::new(archive_bytes.to_vec());
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("failed to open zip archive {archive_name}: {error}"))?;
    let mut files = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read zip entry from {archive_name}: {error}"))?;
        if entry.is_dir() {
            continue;
        }

        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }

        let file_name = unique_auth_file_name(&entry_name, used_names);
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|error| {
            format!("failed to extract {entry_name} from {archive_name}: {error}")
        })?;
        files.push((file_name, bytes));
    }

    Ok(files)
}

fn unique_auth_file_name(name: &str, used_names: &mut HashSet<String>) -> String {
    let base_name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auth.json");

    let mut sanitized = base_name.replace(['/', '\\'], "_");
    if !sanitized.to_ascii_lowercase().ends_with(".json") {
        sanitized.push_str(".json");
    }

    if used_names.insert(sanitized.clone()) {
        return sanitized;
    }

    let stem = sanitized
        .strip_suffix(".json")
        .unwrap_or(&sanitized)
        .to_string();
    let mut counter = 2usize;
    loop {
        let candidate = format!("{stem}-{counter}.json");
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
        counter += 1;
    }
}

fn resolve_openclaw_command(
    app: &AppHandle,
    logs: &mut Vec<String>,
) -> Result<CommandSpec, String> {
    let mut candidates = Vec::new();
    if let Some(cached) = load_cached_openclaw_command(app, logs) {
        candidates.push(cached);
    }
    candidates.extend(openclaw_command_candidates());
    if let Some(discovered) = resolve_openclaw_command_via_shell(app, logs) {
        candidates.push(discovered);
    }
    let mut errors = Vec::new();

    for candidate in candidates {
        log_openclaw(
            app,
            logs,
            &format!("尝试检测 OpenClaw CLI: {}", candidate.display),
        );
        match execute_command(&candidate, &["--help"]) {
            Ok(output) if output.status.success() => {
                log_openclaw(app, logs, "OpenClaw CLI 检测通过");
                if let Err(error) = store_openclaw_command(app, &candidate) {
                    log_openclaw(app, logs, &format!("写入 OpenClaw CLI 缓存失败: {error}"));
                }
                return Ok(candidate);
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let detail = if !stderr.is_empty() { stderr } else { stdout };
                errors.push(format!("{} => {}", candidate.display, detail));
            }
            Err(error) => errors.push(format!("{} => {}", candidate.display, error)),
        }
    }

    Err(format!(
        "未检测到 OpenClaw CLI，请先安装 openclaw。已尝试：{}",
        errors.join(" | ")
    ))
}

fn resolve_openclaw_config_path(
    command: &CommandSpec,
    app: &AppHandle,
    logs: &mut Vec<String>,
) -> Result<PathBuf, String> {
    let output = execute_command(command, &["config", "file"])
        .map_err(|error| format!("执行 openclaw config file 失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取 OpenClaw 配置路径失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stdout.is_empty() {
        log_openclaw(app, logs, &format!("openclaw config file 输出: {stdout}"));
    }
    if !stderr.is_empty() {
        log_openclaw(app, logs, &format!("openclaw config file 警告: {stderr}"));
    }
    let Some(raw) = extract_openclaw_config_path(&stdout) else {
        return Err("openclaw config file 未返回有效路径".to_string());
    };
    let resolved = expand_user_path(&raw)?;
    log_openclaw(
        app,
        logs,
        &format!("OpenClaw 配置文件: {}", resolved.display()),
    );
    Ok(resolved)
}

fn expand_user_path(raw: &str) -> Result<PathBuf, String> {
    if let Some(rest) = raw.strip_prefix("~/") {
        let home = user_home_dir()?;
        return Ok(home.join(rest));
    }
    if let Some(rest) = raw.strip_prefix("~\\") {
        let home = user_home_dir()?;
        return Ok(home.join(rest.replace('\\', "/")));
    }
    Ok(PathBuf::from(raw))
}

fn extract_openclaw_config_path(raw: &str) -> Option<String> {
    for line in raw.lines().rev() {
        let cleaned = line.trim().trim_matches(|ch: char| ch == '"' || ch == '\'');
        if cleaned.is_empty() {
            continue;
        }
        if is_path_like(cleaned) {
            return Some(cleaned.to_string());
        }
        for token in cleaned.split_whitespace().rev() {
            let candidate = token
                .trim()
                .trim_matches(|ch: char| ch == '"' || ch == '\'');
            if is_path_like(candidate) {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn is_path_like(value: &str) -> bool {
    if value.starts_with("~/")
        || value.starts_with("~\\")
        || value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with(".\\")
        || value.starts_with("..\\")
        || value.starts_with("\\\\")
    {
        return true;
    }

    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn openclaw_command_candidates() -> Vec<CommandSpec> {
    let mut candidates = Vec::new();

    if cfg!(target_os = "windows") {
        candidates.push(CommandSpec {
            program: PathBuf::from("openclaw.cmd"),
            args: Vec::new(),
            display: "openclaw.cmd".to_string(),
        });
        candidates.push(CommandSpec {
            program: PathBuf::from("openclaw.exe"),
            args: Vec::new(),
            display: "openclaw.exe".to_string(),
        });

        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            candidates.push(CommandSpec {
                program: PathBuf::from(local_app_data)
                    .join("npm")
                    .join("openclaw.cmd"),
                args: Vec::new(),
                display: "%LOCALAPPDATA%\\npm\\openclaw.cmd".to_string(),
            });
        }

        if let Ok(app_data) = env::var("APPDATA") {
            candidates.push(CommandSpec {
                program: PathBuf::from(app_data).join("npm").join("openclaw.cmd"),
                args: Vec::new(),
                display: "%APPDATA%\\npm\\openclaw.cmd".to_string(),
            });
        }

        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            candidates.push(CommandSpec {
                program: PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("OpenClaw")
                    .join("openclaw.exe"),
                args: Vec::new(),
                display: "%LOCALAPPDATA%\\Programs\\OpenClaw\\openclaw.exe".to_string(),
            });
        }

        candidates.push(CommandSpec {
            program: PathBuf::from("npm.cmd"),
            args: vec!["exec".to_string(), "--".to_string(), "openclaw".to_string()],
            display: "npm exec -- openclaw".to_string(),
        });
        candidates.push(CommandSpec {
            program: PathBuf::from("npx.cmd"),
            args: vec!["openclaw".to_string()],
            display: "npx openclaw".to_string(),
        });
    } else {
        candidates.push(CommandSpec {
            program: PathBuf::from("openclaw"),
            args: Vec::new(),
            display: "openclaw".to_string(),
        });
        candidates.push(CommandSpec {
            program: PathBuf::from("/opt/homebrew/bin/openclaw"),
            args: Vec::new(),
            display: "/opt/homebrew/bin/openclaw".to_string(),
        });
        candidates.push(CommandSpec {
            program: PathBuf::from("/usr/local/bin/openclaw"),
            args: Vec::new(),
            display: "/usr/local/bin/openclaw".to_string(),
        });
        if let Ok(home) = user_home_dir() {
            candidates.push(CommandSpec {
                program: home.join(".local").join("bin").join("openclaw"),
                args: Vec::new(),
                display: "~/.local/bin/openclaw".to_string(),
            });
        }
        candidates.push(CommandSpec {
            program: PathBuf::from("npm"),
            args: vec!["exec".to_string(), "--".to_string(), "openclaw".to_string()],
            display: "npm exec -- openclaw".to_string(),
        });
        candidates.push(CommandSpec {
            program: PathBuf::from("npx"),
            args: vec!["openclaw".to_string()],
            display: "npx openclaw".to_string(),
        });
    }

    candidates
}

fn execute_command(
    command: &CommandSpec,
    extra_args: &[&str],
) -> Result<std::process::Output, String> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.args(extra_args);
    augment_process_path(&mut process);
    process
        .output()
        .map_err(|error| format!("{}: {error}", command.display))
}

fn resolve_openclaw_command_via_shell(
    app: &AppHandle,
    logs: &mut Vec<String>,
) -> Option<CommandSpec> {
    let shell_candidates: Vec<(&str, Vec<&str>, &str)> = if cfg!(target_os = "windows") {
        vec![
            ("where.exe", vec!["openclaw"], "where openclaw"),
            (
                "cmd.exe",
                vec!["/C", "where openclaw"],
                "cmd /C where openclaw",
            ),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            (
                "/bin/zsh",
                vec!["-lc", "command -v openclaw"],
                "zsh -lc command -v openclaw",
            ),
            (
                "/bin/bash",
                vec!["-lc", "command -v openclaw"],
                "bash -lc command -v openclaw",
            ),
        ]
    } else {
        vec![
            (
                "/bin/bash",
                vec!["-lc", "command -v openclaw"],
                "bash -lc command -v openclaw",
            ),
            (
                "/bin/sh",
                vec!["-lc", "command -v openclaw"],
                "sh -lc command -v openclaw",
            ),
        ]
    };

    for (program, args, display) in shell_candidates {
        log_openclaw(
            app,
            logs,
            &format!("尝试通过 Shell 查询 OpenClaw CLI: {display}"),
        );
        let mut process = Command::new(program);
        process.args(args);
        augment_process_path(&mut process);
        let output = match process.output() {
            Ok(output) => output,
            Err(error) => {
                log_openclaw(app, logs, &format!("{display} 失败: {error}"));
                continue;
            }
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !stderr.is_empty() {
                log_openclaw(app, logs, &format!("{display} 未命中: {stderr}"));
            }
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let candidate_path = line.trim();
            if candidate_path.is_empty() {
                continue;
            }
            let path = PathBuf::from(candidate_path);
            if path.exists() {
                log_openclaw(
                    app,
                    logs,
                    &format!("Shell 已解析到 OpenClaw CLI: {}", path.display()),
                );
                return Some(CommandSpec {
                    display: path.display().to_string(),
                    program: path,
                    args: Vec::new(),
                });
            }
        }
    }
    None
}

fn openclaw_cli_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_paths(app)?.config_dir.join(OPENCLAW_CLI_CACHE_FILE))
}

fn load_cached_openclaw_command(app: &AppHandle, logs: &mut Vec<String>) -> Option<CommandSpec> {
    let cache_path = match openclaw_cli_cache_path(app) {
        Ok(path) => path,
        Err(error) => {
            log_openclaw(
                app,
                logs,
                &format!("解析 OpenClaw CLI 缓存路径失败: {error}"),
            );
            return None;
        }
    };
    let raw = match fs::read_to_string(&cache_path) {
        Ok(value) => value,
        Err(_) => return None,
    };
    let program = PathBuf::from(raw.trim());
    if !program.exists() {
        return None;
    }
    log_openclaw(
        app,
        logs,
        &format!("命中 OpenClaw CLI 缓存: {}", program.display()),
    );
    Some(CommandSpec {
        display: program.display().to_string(),
        program,
        args: Vec::new(),
    })
}

fn store_openclaw_command(app: &AppHandle, command: &CommandSpec) -> Result<(), String> {
    if !command.program.is_absolute() {
        return Ok(());
    }
    let cache_path = openclaw_cli_cache_path(app)?;
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 OpenClaw CLI 缓存目录失败 {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(&cache_path, command.program.display().to_string()).map_err(|error| {
        format!(
            "写入 OpenClaw CLI 缓存失败 {}: {error}",
            cache_path.display()
        )
    })
}

fn augment_process_path(process: &mut Command) {
    let mut parts = Vec::new();
    let separator = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };

    if let Some(current) = env::var_os("PATH") {
        let current = current.to_string_lossy().trim().to_string();
        if !current.is_empty() {
            parts.push(current);
        }
    }

    if cfg!(target_os = "windows") {
        for key in [
            "LOCALAPPDATA",
            "APPDATA",
            "ProgramFiles",
            "ProgramFiles(x86)",
        ] {
            if let Ok(value) = env::var(key) {
                match key {
                    "LOCALAPPDATA" | "APPDATA" => parts.push(format!("{value}\\npm")),
                    "ProgramFiles" | "ProgramFiles(x86)" => parts.push(format!("{value}\\nodejs")),
                    _ => {}
                }
            }
        }
    } else {
        parts.push("/opt/homebrew/bin".to_string());
        parts.push("/usr/local/bin".to_string());
        parts.push("/usr/bin".to_string());
        parts.push("/bin".to_string());
        if let Ok(home) = user_home_dir() {
            parts.push(home.join(".local").join("bin").display().to_string());
        }
    }

    let mut deduped = Vec::new();
    for part in parts {
        let normalized = part.trim().to_string();
        if normalized.is_empty() || deduped.iter().any(|existing| existing == &normalized) {
            continue;
        }
        deduped.push(normalized);
    }

    process.env("PATH", deduped.join(&separator.to_string()));
}

fn user_home_dir() -> Result<PathBuf, String> {
    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        return Ok(PathBuf::from(home));
    }
    match (env::var_os("HOMEDRIVE"), env::var_os("HOMEPATH")) {
        (Some(drive), Some(path)) => Ok(PathBuf::from(format!(
            "{}{}",
            PathBuf::from(drive).display(),
            PathBuf::from(path).display()
        ))),
        _ => Err("无法解析用户主目录".to_string()),
    }
}

fn fetch_openclaw_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to create OpenClaw probe client: {error}"))?;
    let response = client
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
        .send()
        .map_err(|error| format!("探测 /v1/models 失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("读取 /v1/models 响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("探测 /v1/models 失败: {status} {text}"));
    }
    let root = serde_json::from_str::<JsonValue>(&text)
        .map_err(|error| format!("解析 /v1/models 响应失败: {error}"))?;
    let mut ids = Vec::new();
    if let Some(data) = root.get("data").and_then(JsonValue::as_array) {
        for item in data {
            if let Some(id) = item.get("id").and_then(JsonValue::as_str) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn select_openclaw_primary_model(models: &[String]) -> Option<String> {
    const PREFERRED: [&str; 5] = [
        "gpt-5.4",
        "gpt-5.3-codex",
        "gpt-5.2-codex",
        "gpt-5",
        "claude",
    ];
    for needle in PREFERRED {
        if let Some(model) = models
            .iter()
            .find(|model| model.to_ascii_lowercase().contains(needle))
        {
            return Some(model.clone());
        }
    }
    models.first().cloned()
}

fn resolve_openclaw_selected_models(
    input: &OpenClawSetupInput,
    available_models: &[String],
) -> Result<Vec<String>, String> {
    if input.mode == OpenClawConfigMode::Legacy || input.selected_models.is_empty() {
        return Ok(available_models.to_vec());
    }

    let mut selected = Vec::new();
    for model in &input.selected_models {
        let trimmed = model.trim();
        if trimmed.is_empty() || selected.iter().any(|item| item == trimmed) {
            continue;
        }
        if !available_models.iter().any(|item| item == trimmed) {
            return Err(format!(
                "OpenClaw 接入失败：模型 `{trimmed}` 不在当前代理返回的模型列表中"
            ));
        }
        selected.push(trimmed.to_string());
    }

    if selected.is_empty() {
        return Err("OpenClaw 接入失败：新版配置至少需要选择一个模型".to_string());
    }
    Ok(selected)
}

fn resolve_openclaw_primary_model(
    input: &OpenClawSetupInput,
    selected_models: &[String],
) -> Result<Option<String>, String> {
    if input.mode != OpenClawConfigMode::Modern {
        return Ok(None);
    }

    let primary = input
        .primary_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| select_openclaw_primary_model(selected_models));

    if let Some(model) = &primary {
        if !selected_models.iter().any(|item| item == model) {
            return Err(format!(
                "OpenClaw 接入失败：默认模型 `{model}` 必须在已选择模型中"
            ));
        }
    }

    Ok(primary)
}

fn resolve_openclaw_fallback_models(
    input: &OpenClawSetupInput,
    selected_models: &[String],
    primary_model: Option<&str>,
) -> Result<Vec<String>, String> {
    if input.mode != OpenClawConfigMode::Modern {
        return Ok(Vec::new());
    }

    let source = if input.fallback_models.is_empty() {
        selected_models.to_vec()
    } else {
        input.fallback_models.clone()
    };

    let mut fallbacks = Vec::new();
    for model in source {
        let trimmed = model.trim();
        if trimmed.is_empty()
            || Some(trimmed) == primary_model
            || fallbacks.iter().any(|item| item == trimmed)
        {
            continue;
        }
        if !selected_models.iter().any(|item| item == trimmed) {
            return Err(format!(
                "OpenClaw 接入失败：备选模型 `{trimmed}` 必须在已选择模型中"
            ));
        }
        fallbacks.push(trimmed.to_string());
    }
    Ok(fallbacks)
}

fn resolve_codex_config_path() -> Result<PathBuf, String> {
    if let Ok(codex_home) = env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.extension().and_then(|value| value.to_str()) == Some("toml") {
                return Ok(path);
            }
            return Ok(path.join("config.toml"));
        }
    }

    let home = user_home_dir()?;
    let default_dir = home.join(".codex");
    let config_path = default_dir.join("config.toml");
    if config_path.exists() {
        return Ok(config_path);
    }

    let legacy_path = default_dir.join("codex.toml");
    if legacy_path.exists() {
        return Ok(legacy_path);
    }

    Ok(config_path)
}

fn codex_backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_paths(app)?
        .config_dir
        .join(CODEX_CONFIG_BACKUP_FILE))
}

fn ensure_codex_backup(app: &AppHandle, config_path: &Path) -> Result<(), String> {
    let backup_path = codex_backup_path(app)?;
    if backup_path.exists() {
        return Ok(());
    }

    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Codex 备份目录失败 {}: {error}", parent.display()))?;
    }

    let backup = if config_path.exists() {
        FileConfigBackup {
            existed: true,
            content: fs::read_to_string(config_path).map_err(|error| {
                format!("读取 Codex 配置失败 {}: {error}", config_path.display())
            })?,
        }
    } else {
        FileConfigBackup {
            existed: false,
            content: String::new(),
        }
    };

    let content = serde_json::to_string_pretty(&backup)
        .map_err(|error| format!("序列化 Codex 备份失败: {error}"))?;
    fs::write(&backup_path, content)
        .map_err(|error| format!("写入 Codex 备份失败 {}: {error}", backup_path.display()))
}

fn read_codex_config_values(path: &Path) -> Result<(Option<String>, Option<String>), String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 Codex 配置失败 {}: {error}", path.display()))?;
    let mut model = None;
    let mut base_url = None;

    for line in content.lines() {
        if model.is_none() {
            model = parse_codex_string_line(line, "model");
        }
        if base_url.is_none() {
            base_url = parse_codex_string_line(line, "openai_base_url");
        }
    }

    Ok((model, base_url))
}

fn parse_codex_string_line(line: &str, key_name: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let (key, value) = trimmed.split_once('=')?;
    if key.trim() != key_name {
        return None;
    }

    let raw_value = value.split('#').next()?.trim();
    let unquoted = raw_value
        .strip_prefix('"')
        .and_then(|item| item.strip_suffix('"'))
        .or_else(|| {
            raw_value
                .strip_prefix('\'')
                .and_then(|item| item.strip_suffix('\''))
        })
        .unwrap_or(raw_value)
        .trim();
    if unquoted.is_empty() {
        return None;
    }
    Some(unquoted.to_string())
}

fn write_codex_config_values(path: &Path, model: &str, base_url: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Codex 配置目录失败 {}: {error}", parent.display()))?;
    }

    let existing = if path.exists() {
        fs::read_to_string(path)
            .map_err(|error| format!("读取 Codex 配置失败 {}: {error}", path.display()))?
    } else {
        String::new()
    };

    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut replaced_model = false;
    let mut replaced_base_url = false;
    let mut lines = Vec::new();

    for line in existing.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('#') {
            if let Some((key, _)) = trimmed.split_once('=') {
                if !replaced_model && key.trim() == "model" {
                    lines.push(format!("model = \"{model}\""));
                    replaced_model = true;
                    continue;
                }
                if !replaced_base_url && key.trim() == "openai_base_url" {
                    lines.push(format!("openai_base_url = \"{base_url}\""));
                    replaced_base_url = true;
                    continue;
                }
            }
        }
        lines.push(line.to_string());
    }

    let mut insert_lines = Vec::new();
    if !replaced_model {
        insert_lines.push(format!("model = \"{model}\""));
    }
    if !replaced_base_url {
        insert_lines.push(format!("openai_base_url = \"{base_url}\""));
    }

    if !insert_lines.is_empty() {
        if !lines.is_empty() {
            insert_lines.push(String::new());
            insert_lines.extend(lines);
            lines = insert_lines;
        } else {
            lines = insert_lines;
        }
    }

    let mut output = lines.join(newline);
    if !output.ends_with(newline) {
        output.push_str(newline);
    }

    fs::write(path, output)
        .map_err(|error| format!("写入 Codex 配置失败 {}: {error}", path.display()))
}

fn resolve_continue_config_path() -> Result<PathBuf, String> {
    let home = user_home_dir()?;
    Ok(home.join(".continue").join("config.yaml"))
}

fn continue_backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_paths(app)?
        .config_dir
        .join(CONTINUE_CONFIG_BACKUP_FILE))
}

fn ensure_continue_backup(app: &AppHandle, config_path: &Path) -> Result<(), String> {
    let backup_path = continue_backup_path(app)?;
    if backup_path.exists() {
        return Ok(());
    }

    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Continue 备份目录失败 {}: {error}", parent.display()))?;
    }

    let backup = if config_path.exists() {
        FileConfigBackup {
            existed: true,
            content: fs::read_to_string(config_path).map_err(|error| {
                format!("读取 Continue 配置失败 {}: {error}", config_path.display())
            })?,
        }
    } else {
        FileConfigBackup {
            existed: false,
            content: String::new(),
        }
    };

    let content = serde_json::to_string_pretty(&backup)
        .map_err(|error| format!("序列化 Continue 备份失败: {error}"))?;
    fs::write(&backup_path, content)
        .map_err(|error| format!("写入 Continue 备份失败 {}: {error}", backup_path.display()))
}

fn read_continue_config_values(
    path: &Path,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 Continue 配置失败 {}: {error}", path.display()))?;
    let root = serde_yaml::from_str::<YamlValue>(&content)
        .map_err(|error| format!("解析 Continue 配置失败 {}: {error}", path.display()))?;
    let Some(map) = root.as_mapping() else {
        return Ok((None, None, None));
    };
    let Some(models) = map.get(yaml_key("models")).and_then(YamlValue::as_sequence) else {
        return Ok((None, None, None));
    };

    let mut current_base_url = None;
    let mut chat_model = None;
    let mut autocomplete_model = None;

    for entry in models {
        let Some(model_map) = entry.as_mapping() else {
            continue;
        };
        let Some(name) = yaml_mapping_string(model_map, "name") else {
            continue;
        };
        if name != CONTINUE_CHAT_MODEL_NAME && name != CONTINUE_AUTOCOMPLETE_MODEL_NAME {
            continue;
        }

        if current_base_url.is_none() {
            current_base_url = yaml_mapping_string(model_map, "apiBase");
        }
        let model_id = yaml_mapping_string(model_map, "model");
        if name == CONTINUE_CHAT_MODEL_NAME {
            chat_model = model_id;
        } else if name == CONTINUE_AUTOCOMPLETE_MODEL_NAME {
            autocomplete_model = model_id;
        }
    }

    Ok((current_base_url, chat_model, autocomplete_model))
}

fn write_continue_config_values(
    path: &Path,
    base_url: &str,
    api_key: &str,
    chat_model: &str,
    autocomplete_model: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Continue 配置目录失败 {}: {error}", parent.display()))?;
    }

    let mut root = if path.exists() {
        let existing = fs::read_to_string(path)
            .map_err(|error| format!("读取 Continue 配置失败 {}: {error}", path.display()))?;
        serde_yaml::from_str::<YamlValue>(&existing).unwrap_or(YamlValue::Mapping(Mapping::new()))
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    let Some(map) = root.as_mapping_mut() else {
        return Err("Continue 配置根节点必须是 YAML 对象".to_string());
    };

    if !map.contains_key(yaml_key("name")) {
        map.insert(
            yaml_key("name"),
            YamlValue::String("CLIProxy Continue".to_string()),
        );
    }
    if !map.contains_key(yaml_key("version")) {
        map.insert(yaml_key("version"), YamlValue::String("0.0.1".to_string()));
    }
    if !map.contains_key(yaml_key("schema")) {
        map.insert(yaml_key("schema"), YamlValue::String("v1".to_string()));
    }

    let models = get_or_create_sequence(map, "models");
    upsert_continue_model(
        models,
        build_continue_model_entry(
            CONTINUE_CHAT_MODEL_NAME,
            chat_model,
            base_url,
            api_key,
            &["chat", "edit", "apply"],
            true,
        ),
    );
    upsert_continue_model(
        models,
        build_continue_model_entry(
            CONTINUE_AUTOCOMPLETE_MODEL_NAME,
            autocomplete_model,
            base_url,
            api_key,
            &["autocomplete"],
            false,
        ),
    );

    let yaml = serde_yaml::to_string(&root)
        .map_err(|error| format!("序列化 Continue 配置失败: {error}"))?;
    fs::write(path, yaml)
        .map_err(|error| format!("写入 Continue 配置失败 {}: {error}", path.display()))
}

fn build_continue_model_entry(
    name: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
    roles: &[&str],
    force_chat_completions: bool,
) -> YamlValue {
    let mut map = Mapping::new();
    map.insert(yaml_key("name"), YamlValue::String(name.to_string()));
    map.insert(
        yaml_key("provider"),
        YamlValue::String("openai".to_string()),
    );
    map.insert(yaml_key("model"), YamlValue::String(model.to_string()));
    map.insert(yaml_key("apiBase"), YamlValue::String(base_url.to_string()));
    map.insert(yaml_key("apiKey"), YamlValue::String(api_key.to_string()));
    map.insert(
        yaml_key("roles"),
        YamlValue::Sequence(
            roles
                .iter()
                .map(|role| YamlValue::String((*role).to_string()))
                .collect(),
        ),
    );
    if force_chat_completions {
        map.insert(yaml_key("useResponsesApi"), YamlValue::Bool(false));
        map.insert(
            yaml_key("capabilities"),
            YamlValue::Sequence(vec![YamlValue::String("tool_use".to_string())]),
        );
    }
    YamlValue::Mapping(map)
}

fn upsert_continue_model(models: &mut Vec<YamlValue>, new_entry: YamlValue) {
    let new_name = new_entry
        .as_mapping()
        .and_then(|mapping| yaml_mapping_string(mapping, "name"));
    let Some(new_name) = new_name else {
        models.push(new_entry);
        return;
    };

    if let Some(existing) = models.iter_mut().find(|entry| {
        entry
            .as_mapping()
            .and_then(|mapping| yaml_mapping_string(mapping, "name"))
            .is_some_and(|name| name == new_name)
    }) {
        *existing = new_entry;
    } else {
        models.push(new_entry);
    }
}

fn select_continue_chat_model(models: &[String]) -> Option<String> {
    let preferred = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.4-mini"];
    select_preferred_model(models, &preferred).or_else(|| models.first().cloned())
}

fn select_continue_autocomplete_model(models: &[String], fallback: &str) -> Option<String> {
    let preferred = [
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
        "gpt-5.3-codex",
        "gpt-5.2",
    ];
    select_preferred_model(models, &preferred).or_else(|| {
        models
            .iter()
            .find(|model| model.as_str() == fallback)
            .cloned()
    })
}

fn select_preferred_model(models: &[String], preferred: &[&str]) -> Option<String> {
    preferred.iter().find_map(|candidate| {
        models
            .iter()
            .find(|model| model.as_str() == *candidate)
            .cloned()
    })
}

fn load_or_create_openclaw_config(
    path: &Path,
    app: &AppHandle,
    logs: &mut Vec<String>,
) -> Result<JsonValue, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 OpenClaw 配置目录失败 {}: {error}", parent.display()))?;
    }
    if !path.exists() {
        log_openclaw(app, logs, "OpenClaw 配置不存在，创建新配置文件");
        return Ok(JsonValue::Object(JsonMap::new()));
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 OpenClaw 配置失败 {}: {error}", path.display()))?;
    let root = serde_json::from_str::<JsonValue>(&content)
        .map_err(|error| format!("解析 OpenClaw 配置失败 {}: {error}", path.display()))?;
    log_openclaw(app, logs, "已读取现有 OpenClaw 配置");
    Ok(root)
}

fn apply_openclaw_provider_config(
    root: &mut JsonValue,
    base_url: &str,
    api_key: &str,
    models: &[String],
    mode: &OpenClawConfigMode,
    primary_model: Option<&str>,
    fallback_models: &[String],
    clear_other_models: bool,
) {
    let root_obj = ensure_json_object(root);
    let models_node = ensure_json_object_entry(root_obj, "models");
    if mode == &OpenClawConfigMode::Modern {
        models_node.insert("mode".to_string(), JsonValue::String("merge".to_string()));
    }
    let providers_node = ensure_json_object_entry(models_node, "providers");
    let cliproxy = ensure_json_object_entry(providers_node, "cliproxy");
    cliproxy.insert(
        "baseUrl".to_string(),
        JsonValue::String(base_url.to_string()),
    );
    cliproxy.insert("apiKey".to_string(), JsonValue::String(api_key.to_string()));
    if mode == &OpenClawConfigMode::Modern {
        cliproxy.insert("auth".to_string(), JsonValue::String("api-key".to_string()));
    }
    cliproxy.insert(
        "api".to_string(),
        JsonValue::String("openai-completions".to_string()),
    );
    cliproxy.insert(
        "models".to_string(),
        JsonValue::Array(
            models
                .iter()
                .map(|id| build_openclaw_model_definition(id, mode == &OpenClawConfigMode::Modern))
                .collect(),
        ),
    );

    let agents_node = ensure_json_object_entry(root_obj, "agents");
    let defaults_node = ensure_json_object_entry(agents_node, "defaults");
    let defaults_models_node = ensure_json_object_entry(defaults_node, "models");
    if clear_other_models {
        let keep: HashSet<String> = models
            .iter()
            .map(|model_id| format!("cliproxy/{model_id}"))
            .collect();
        defaults_models_node.retain(|key, _| !key.starts_with("cliproxy/") || keep.contains(key));
    }
    for model_id in models {
        let mut entry = JsonMap::new();
        if model_id == "gpt-5.4" {
            entry.insert(
                "alias".to_string(),
                JsonValue::String("cliproxy".to_string()),
            );
        }
        defaults_models_node.insert(format!("cliproxy/{model_id}"), JsonValue::Object(entry));
    }

    if mode == &OpenClawConfigMode::Modern {
        let model_node = ensure_json_object_entry(defaults_node, "model");
        if let Some(primary) = primary_model {
            model_node.insert(
                "primary".to_string(),
                JsonValue::String(format!("cliproxy/{primary}")),
            );
        }
        model_node.insert(
            "fallbacks".to_string(),
            JsonValue::Array(
                fallback_models
                    .iter()
                    .map(|model| JsonValue::String(format!("cliproxy/{model}")))
                    .collect(),
            ),
        );
    }
}

fn write_openclaw_config(
    path: &Path,
    root: &JsonValue,
    app: &AppHandle,
    logs: &mut Vec<String>,
) -> Result<(), String> {
    let content = serde_json::to_string_pretty(root)
        .map_err(|error| format!("序列化 OpenClaw 配置失败: {error}"))?;
    fs::write(path, content)
        .map_err(|error| format!("写入 OpenClaw 配置失败 {}: {error}", path.display()))?;
    log_openclaw(app, logs, "已写入 OpenClaw 配置");
    Ok(())
}

fn validate_openclaw_config(
    command: &CommandSpec,
    app: &AppHandle,
    logs: &mut Vec<String>,
) -> Result<(), String> {
    log_openclaw(app, logs, "执行 openclaw config validate ...");
    let output = execute_command(command, &["config", "validate"])
        .map_err(|error| format!("执行 openclaw config validate 失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "OpenClaw 配置校验失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        log_openclaw(app, logs, &stdout);
    }
    log_openclaw(app, logs, "OpenClaw 配置校验通过");
    Ok(())
}

fn build_openclaw_model_definition(id: &str, modern: bool) -> JsonValue {
    let lower = id.to_ascii_lowercase();
    let supports_image = ["vision", "image", "gemini", "gpt-4o", "gpt-5", "claude"]
        .iter()
        .any(|needle| lower.contains(needle));
    let reasoning = ["reason", "thinking", "gpt-5", "o1", "o3", "o4"]
        .iter()
        .any(|needle| lower.contains(needle));

    let mut obj = JsonMap::new();
    obj.insert("id".to_string(), JsonValue::String(id.to_string()));
    obj.insert("name".to_string(), JsonValue::String(id.to_string()));
    obj.insert(
        "api".to_string(),
        JsonValue::String("openai-completions".to_string()),
    );
    obj.insert("reasoning".to_string(), JsonValue::Bool(reasoning));
    obj.insert(
        "input".to_string(),
        JsonValue::Array(if supports_image {
            vec![
                JsonValue::String("text".to_string()),
                JsonValue::String("image".to_string()),
            ]
        } else {
            vec![JsonValue::String("text".to_string())]
        }),
    );
    obj.insert(
        "cost".to_string(),
        serde_json::json!({
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
        }),
    );
    obj.insert("contextWindow".to_string(), JsonValue::from(266000));
    if modern {
        obj.insert("contextTokens".to_string(), JsonValue::from(266000));
        obj.insert("maxTokens".to_string(), JsonValue::from(8192));
    } else {
        obj.insert("maxTokens".to_string(), JsonValue::from(4096));
    }
    JsonValue::Object(obj)
}

fn ensure_json_object(value: &mut JsonValue) -> &mut JsonMap<String, JsonValue> {
    if !value.is_object() {
        *value = JsonValue::Object(JsonMap::new());
    }
    value.as_object_mut().expect("object ensured above")
}

fn cloud_url(path: &str) -> String {
    let normalized_path = path.trim().trim_start_matches('/');
    format!(
        "{}/{}",
        cloud_base_url().trim_end_matches('/'),
        normalized_path
    )
}

fn app_update_origin() -> Result<String, String> {
    let base = reqwest::Url::parse(cloud_base_url())
        .map_err(|error| format!("invalid cloud base url: {error}"))?;
    let host = base
        .host_str()
        .ok_or_else(|| "cloud base url missing host".to_string())?;
    let mut origin = format!("{}://{}", base.scheme(), host);
    if let Some(port) = base.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    Ok(origin)
}

fn cloud_base_url() -> &'static str {
    if cfg!(debug_assertions) {
        CLOUD_BASE_URL_DEV
    } else {
        CLOUD_BASE_URL_RELEASE
    }
}

fn select_update_download_url(payload: &JsonValue) -> Result<Option<String>, String> {
    let origin = app_update_origin()?;
    let direct = payload
        .get("downloadUrl")
        .or_else(|| payload.get("download_url"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| resolve_download_url(value, &origin));
    if direct.is_some() {
        return Ok(direct);
    }

    let downloads = payload.get("downloads").and_then(JsonValue::as_object);
    let Some(downloads) = downloads else {
        return Ok(None);
    };

    let keys = if cfg!(target_os = "windows") {
        vec!["windows", "windows-x64"]
    } else if cfg!(target_os = "macos") {
        vec!["macos", "darwin-aarch64", "darwin-x64"]
    } else {
        vec!["linux", "linux-x64"]
    };

    for key in keys {
        if let Some(url) = downloads.get(key).and_then(JsonValue::as_str) {
            let trimmed = url.trim();
            if !trimmed.is_empty() {
                return Ok(Some(resolve_download_url(trimmed, &origin)));
            }
        }
    }
    Ok(None)
}

fn resolve_download_url(value: &str, origin: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        return value.to_string();
    }
    format!("{origin}/{}", value.trim_start_matches('/'))
}

fn app_update_manifest_urls() -> Result<Vec<String>, String> {
    let origin = app_update_origin()?;
    Ok(APP_UPDATE_MANIFEST_PATHS
        .iter()
        .map(|path| format!("{origin}{path}"))
        .collect())
}

fn fetch_update_manifest(client: &reqwest::blocking::Client) -> Result<JsonValue, String> {
    let mut failures = Vec::new();

    for url in app_update_manifest_urls()? {
        match client.get(&url).send() {
            Ok(response) => {
                let status = response.status();
                let text = response
                    .text()
                    .map_err(|error| format!("failed to read update manifest: {error}"))?;
                if status.is_success() {
                    return serde_json::from_str::<JsonValue>(&text)
                        .map_err(|error| format!("failed to parse update manifest: {error}"));
                }
                failures.push(format!("{url} -> {status}"));
            }
            Err(error) => failures.push(format!("{url} -> {error}")),
        }
    }

    fetch_github_latest_release(client).map_err(|github_error| {
        format!(
            "未找到可用的更新清单。服务器返回：{}；GitHub 回退失败：{}",
            failures.join(" | "),
            github_error
        )
    })
}

fn fetch_github_latest_release(client: &reqwest::blocking::Client) -> Result<JsonValue, String> {
    let response = client
        .get(GITHUB_LATEST_RELEASE_API)
        .header(reqwest::header::USER_AGENT, "CLIProxyApp")
        .send()
        .map_err(|error| format!("failed to request latest GitHub release: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read latest GitHub release: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "GitHub latest release request failed with {status}: {text}"
        ));
    }
    let payload = serde_json::from_str::<JsonValue>(&text)
        .map_err(|error| format!("failed to parse latest GitHub release: {error}"))?;

    let version = payload
        .get("tag_name")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().trim_start_matches('v').to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "GitHub release missing tag_name".to_string())?;

    let download_url = payload
        .get("assets")
        .and_then(JsonValue::as_array)
        .and_then(|assets| {
            assets.iter().find_map(|asset| {
                let name = asset
                    .get("name")
                    .and_then(JsonValue::as_str)?
                    .to_ascii_lowercase();
                if cfg!(target_os = "windows") {
                    if !name.ends_with(".exe") {
                        return None;
                    }
                } else if cfg!(target_os = "macos") {
                    if !(name.ends_with(".dmg") || name.ends_with(".app.zip")) {
                        return None;
                    }
                }
                asset
                    .get("browser_download_url")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
            })
        });

    let notes = payload
        .get("body")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let published_at = payload
        .get("published_at")
        .and_then(JsonValue::as_str)
        .map(str::to_string);

    Ok(serde_json::json!({
        "version": version,
        "downloadUrl": download_url,
        "notes": notes,
        "publishedAt": published_at
    }))
}

fn chrono_like_now_string() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    format!("{}", now.as_secs())
}

fn parse_version_numbers(input: &str) -> Vec<u64> {
    input
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|char| char.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = parse_version_numbers(left);
    let right_parts = parse_version_numbers(right);
    let max_len = left_parts.len().max(right_parts.len());
    for index in 0..max_len {
        let left_part = *left_parts.get(index).unwrap_or(&0);
        let right_part = *right_parts.get(index).unwrap_or(&0);
        match left_part.cmp(&right_part) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn parse_cloud_json_response(response: reqwest::blocking::Response) -> Result<JsonValue, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read cloud response: {error}"))?;

    if !status.is_success() {
        let message = serde_json::from_str::<JsonValue>(&text)
            .ok()
            .and_then(|payload| {
                payload
                    .get("error")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| {
                if text.trim().is_empty() {
                    format!("{status}")
                } else {
                    text.clone()
                }
            });
        return Err(message);
    }

    if text.trim().is_empty() {
        return Ok(JsonValue::Null);
    }

    serde_json::from_str::<JsonValue>(&text)
        .map_err(|error| format!("failed to parse cloud json response: {error}"))
}

fn parse_content_disposition_filename(value: &str) -> Option<String> {
    value.split(';').find_map(|segment| {
        let trimmed = segment.trim();
        let file_name = trimmed
            .strip_prefix("filename=")
            .or_else(|| trimmed.strip_prefix("filename*="))?;
        let cleaned = file_name
            .trim()
            .trim_matches('"')
            .strip_prefix("UTF-8''")
            .unwrap_or(file_name)
            .trim_matches('"')
            .to_string();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    })
}

fn ensure_json_object_entry<'a>(
    parent: &'a mut JsonMap<String, JsonValue>,
    key: &str,
) -> &'a mut JsonMap<String, JsonValue> {
    let value = parent
        .entry(key.to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if !value.is_object() {
        *value = JsonValue::Object(JsonMap::new());
    }
    value.as_object_mut().expect("object ensured above")
}

fn log_openclaw(app: &AppHandle, logs: &mut Vec<String>, message: &str) {
    let line = message.to_string();
    logs.push(line.clone());
    let _ = app.emit(OPENCLAW_SETUP_LOG_EVENT, line);
}

fn resolve_auth_dir(paths: &ResolvedPaths) -> Result<PathBuf, String> {
    let default_auth_dir = paths.config_dir.join("auths");
    if !paths.config_path.exists() {
        return Ok(default_auth_dir);
    }

    let content = fs::read_to_string(&paths.config_path)
        .map_err(|error| format!("failed to read runtime config: {error}"))?;
    let root =
        serde_yaml::from_str::<YamlValue>(&content).unwrap_or(YamlValue::Mapping(Mapping::new()));

    let Some(raw_path) = root
        .as_mapping()
        .and_then(|mapping| mapping.get(yaml_key("auth-dir")))
        .and_then(YamlValue::as_str)
    else {
        return Ok(default_auth_dir);
    };

    let auth_dir = PathBuf::from(raw_path);
    if auth_dir.is_absolute() {
        Ok(auth_dir)
    } else {
        Ok(paths.config_dir.join(auth_dir))
    }
}

fn collect_auth_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|error| format!("failed to read auth directory {}: {error}", dir.display()))?;

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to inspect auth directory entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;

        if file_type.is_dir() {
            collect_auth_files(&path, files)?;
            continue;
        }

        if file_type.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("json"))
        {
            files.push(path);
        }
    }

    Ok(())
}

fn load_runtime_context(app: &AppHandle) -> Result<RuntimeContext, String> {
    let paths = resolve_paths(app)?;
    ensure_directories(&paths)?;
    let bootstrap = load_or_create_bootstrap(&paths)?;
    Ok(RuntimeContext { paths, bootstrap })
}

fn resolve_paths(app: &AppHandle) -> Result<ResolvedPaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let runtime_dir = app_data_dir.join("runtime");
    let static_dir = runtime_dir.join("static");
    let config_dir = runtime_dir.join("config");
    let logs_dir = runtime_dir.join("logs");

    Ok(ResolvedPaths {
        app_data_dir,
        runtime_dir: runtime_dir.clone(),
        static_dir: static_dir.clone(),
        config_dir: config_dir.clone(),
        logs_dir: logs_dir.clone(),
        bootstrap_path: config_dir.join("bootstrap.json"),
        config_path: config_dir.join("config.yaml"),
        stdout_log_path: logs_dir.join("cpa.stdout.log"),
        stderr_log_path: logs_dir.join("cpa.stderr.log"),
    })
}

fn ensure_directories(paths: &ResolvedPaths) -> Result<(), String> {
    for path in [
        &paths.runtime_dir,
        &paths.static_dir,
        &paths.config_dir,
        &paths.logs_dir,
    ] {
        fs::create_dir_all(path).map_err(|error| {
            format!(
                "failed to create runtime directory {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn load_or_create_bootstrap(paths: &ResolvedPaths) -> Result<BootstrapSettings, String> {
    if paths.bootstrap_path.exists() {
        let content = fs::read_to_string(&paths.bootstrap_path)
            .map_err(|error| format!("failed to read bootstrap settings: {error}"))?;
        let mut settings = serde_json::from_str::<BootstrapSettings>(&content)
            .map_err(|error| format!("failed to parse bootstrap settings: {error}"))?;
        let mut needs_persist = false;
        settings.host = normalize_host(&settings.host);
        if !content.contains("\"host\"") {
            needs_persist = true;
        }
        if settings.management_key.trim().is_empty() {
            settings.management_key = default_management_key();
            needs_persist = true;
        }
        if !content.contains("\"managementKey\"") {
            needs_persist = true;
        }
        if needs_persist {
            let next_content = serde_json::to_string_pretty(&settings)
                .map_err(|error| format!("failed to serialize bootstrap settings: {error}"))?;
            fs::write(&paths.bootstrap_path, next_content)
                .map_err(|error| format!("failed to update bootstrap settings: {error}"))?;
        }
        return Ok(settings);
    }

    let settings = BootstrapSettings::default();
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("failed to serialize bootstrap settings: {error}"))?;
    fs::write(&paths.bootstrap_path, content)
        .map_err(|error| format!("failed to create bootstrap settings: {error}"))?;
    Ok(settings)
}

fn write_runtime_config(ctx: &RuntimeContext) -> Result<(), String> {
    let mut root = if ctx.paths.config_path.exists() {
        let current = fs::read_to_string(&ctx.paths.config_path)
            .map_err(|error| format!("failed to read runtime config: {error}"))?;
        serde_yaml::from_str::<YamlValue>(&current).unwrap_or(YamlValue::Mapping(Mapping::new()))
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    let Some(map) = root.as_mapping_mut() else {
        return Err("runtime config root must be a YAML mapping".to_string());
    };

    map.insert(
        yaml_key("host"),
        YamlValue::String(ctx.bootstrap.host.clone()),
    );
    map.insert(
        yaml_key("port"),
        YamlValue::Number(Number::from(ctx.bootstrap.api_port as u64)),
    );
    map.insert(
        yaml_key("auth-dir"),
        YamlValue::String(ctx.paths.config_dir.join("auths").display().to_string()),
    );
    map.insert(yaml_key("usage-statistics-enabled"), YamlValue::Bool(true));

    let remote_management = get_or_create_mapping(map, "remote-management");
    remote_management.insert(yaml_key("allow-remote"), YamlValue::Bool(false));
    remote_management.insert(
        yaml_key("secret-key"),
        YamlValue::String(ctx.bootstrap.management_key.clone()),
    );
    remote_management.insert(
        yaml_key("disable-control-panel"),
        YamlValue::Bool(browser_management_disabled()),
    );

    let yaml = serde_yaml::to_string(&root)
        .map_err(|error| format!("failed to serialize runtime config: {error}"))?;
    fs::write(&ctx.paths.config_path, yaml)
        .map_err(|error| format!("failed to write runtime config: {error}"))?;
    Ok(())
}

fn get_or_create_mapping<'a>(root: &'a mut Mapping, key: &str) -> &'a mut Mapping {
    let mapping_key = yaml_key(key);
    let needs_reset = !matches!(root.get(&mapping_key), Some(YamlValue::Mapping(_)));
    if needs_reset {
        root.insert(mapping_key.clone(), YamlValue::Mapping(Mapping::new()));
    }
    root.get_mut(&mapping_key)
        .and_then(YamlValue::as_mapping_mut)
        .expect("mapping inserted above")
}

fn build_cpa_command(ctx: &RuntimeContext) -> Result<Command, String> {
    if let Some(binary_path) = &ctx.bootstrap.explicit_binary_path {
        if !binary_path.trim().is_empty() {
            let mut command = Command::new(binary_path);
            command.arg("-config").arg(&ctx.paths.config_path);
            command.env("MANAGEMENT_STATIC_PATH", &ctx.paths.static_dir);
            apply_windows_background_flags(&mut command);
            return Ok(command);
        }
    }

    if let Some(sidecar_path) = resolve_bundled_sidecar_path() {
        let mut command = Command::new(sidecar_path);
        command.arg("-config").arg(&ctx.paths.config_path);
        command.env("MANAGEMENT_STATIC_PATH", &ctx.paths.static_dir);
        apply_windows_background_flags(&mut command);
        return Ok(command);
    }

    let workspace_api_dir = workspace_api_dir()?;
    let mut command = Command::new("go");
    command.current_dir(workspace_api_dir);
    command.arg("run");
    command.arg("./cmd/server");
    command.arg("-config");
    command.arg(&ctx.paths.config_path);
    command.env("MANAGEMENT_STATIC_PATH", &ctx.paths.static_dir);
    apply_windows_background_flags(&mut command);
    Ok(command)
}

#[cfg(target_os = "windows")]
fn apply_windows_background_flags(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn apply_windows_background_flags(_command: &mut Command) {}

fn workspace_api_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let app_dir = manifest_dir
        .parent()
        .ok_or_else(|| "failed to resolve app directory".to_string())?;
    let workspace_dir = app_dir
        .parent()
        .ok_or_else(|| "failed to resolve workspace directory".to_string())?;
    let direct_api_dir = workspace_dir.join("CLIProxyApi");
    if direct_api_dir.exists() {
        return Ok(direct_api_dir);
    }
    let aggregated_api_dir = workspace_dir.join("CLIProxy").join("CLIProxyApi");
    if aggregated_api_dir.exists() {
        return Ok(aggregated_api_dir);
    }
    Err(format!(
        "development workspace CLIProxyApi not found at {} or {}",
        direct_api_dir.display(),
        aggregated_api_dir.display()
    ))
}

fn resolve_runtime_binary_path(settings: &BootstrapSettings) -> Option<String> {
    if let Some(path) = settings
        .explicit_binary_path
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(path);
    }

    resolve_bundled_sidecar_path().map(|path| path.display().to_string())
}

fn resolve_bundled_sidecar_path() -> Option<PathBuf> {
    let dev_sidecar = dev_sidecar_path();
    if dev_sidecar.exists() {
        return Some(dev_sidecar);
    }

    let exe_path = std::env::current_exe().ok()?;
    let resource_dir = if cfg!(target_os = "macos") {
        exe_path
            .parent()
            .and_then(Path::parent)
            .map(|contents| contents.join("Resources"))
    } else {
        exe_path.parent().map(|dir| dir.to_path_buf())
    }?;

    let bundled_sidecar = resource_dir
        .join("sidecar")
        .join(sidecar_folder_name())
        .join(sidecar_binary_name());
    if bundled_sidecar.exists() {
        return Some(bundled_sidecar);
    }

    let nested_resource_sidecar = resource_dir
        .join("resources")
        .join("sidecar")
        .join(sidecar_folder_name())
        .join(sidecar_binary_name());

    if nested_resource_sidecar.exists() {
        Some(nested_resource_sidecar)
    } else {
        None
    }
}

fn dev_sidecar_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("sidecar")
        .join(sidecar_folder_name())
        .join(sidecar_binary_name())
}

fn sidecar_folder_name() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        _ => "unknown",
    }
}

fn sidecar_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "cliproxyapi.exe"
    } else {
        "cliproxyapi"
    }
}

fn build_cpa_state(ctx: &RuntimeContext, inner: &RuntimeInner) -> CpaState {
    let pid = inner.child.as_ref().map(|child| child.id());
    let status = match (inner.child.is_some(), inner.last_error.is_some()) {
        (true, _) => "running",
        (false, true) => "error",
        (false, false) => "stopped",
    }
    .to_string();

    CpaState {
        status,
        pid,
        started_at: inner.started_at.map(format_system_time),
        api_port: ctx.bootstrap.api_port,
        binary_path: resolve_runtime_binary_path(&ctx.bootstrap),
        config_path: ctx.paths.config_path.display().to_string(),
        logs_dir: ctx.paths.logs_dir.display().to_string(),
        last_error: inner.last_error.clone(),
        browser_management_disabled: browser_management_disabled(),
        runtime_mode_label: runtime_mode_label(&ctx.bootstrap).to_string(),
        bootstrap: ctx.bootstrap.clone(),
    }
}

fn refresh_child_state(inner: &mut RuntimeInner) {
    let mut clear_child = false;
    if let Some(child) = inner.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                inner.last_error = if status.success() {
                    None
                } else {
                    Some(format!("CPA exited with status {status}"))
                };
                clear_child = true;
            }
            Ok(None) => {}
            Err(error) => {
                inner.last_error = Some(format!("failed to inspect CPA process: {error}"));
                clear_child = true;
            }
        }
    }

    if clear_child {
        inner.child = None;
        inner.started_at = None;
    }
}

fn stop_child(inner: &mut RuntimeInner) -> Result<(), String> {
    refresh_child_state(inner);
    if let Some(mut child) = inner.child.take() {
        child
            .kill()
            .map_err(|error| format!("failed to stop CPA process: {error}"))?;
        let _ = child.wait();
    }
    inner.started_at = None;
    Ok(())
}

fn cleanup_stale_cpa_processes(paths: &ResolvedPaths, keep_pid: Option<u32>) -> Result<(), String> {
    let config_path = fs::canonicalize(&paths.config_path).unwrap_or(paths.config_path.clone());
    let config_path_text = config_path.display().to_string();

    let mut system = System::new_all();
    system.refresh_all();

    for (pid, process) in system.processes() {
        let pid_u32 = pid.as_u32();
        if keep_pid.is_some_and(|value| value == pid_u32) {
            continue;
        }

        let cmdline = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        if !cmdline.contains(&config_path_text) {
            continue;
        }

        let executable = process
            .exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();

        let looks_like_cpa = executable.contains("cliproxyapi")
            || cmdline.contains("cliproxyapi")
            || cmdline.contains("cmd/server")
            || cmdline.contains("go run");

        if !looks_like_cpa {
            continue;
        }

        let terminated = process
            .kill_with(Signal::Kill)
            .unwrap_or_else(|| process.kill());
        if !terminated {
            return Err(format!(
                "failed to terminate stale CPA process {} ({})",
                pid_u32, cmdline
            ));
        }
    }

    Ok(())
}

fn wait_for_port(host: &str, port: u16, timeout: Duration) -> bool {
    let socket_addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(address) => address,
        Err(_) => return false,
    };

    let started = SystemTime::now();
    loop {
        if TcpStream::connect_timeout(&socket_addr, Duration::from_millis(350)).is_ok() {
            return true;
        }

        match SystemTime::now().duration_since(started) {
            Ok(duration) if duration >= timeout => return false,
            _ => std::thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn tail_file(path: &Path, max_lines: usize) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }

    let file =
        File::open(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut lines = reader
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    if lines.len() > max_lines {
        lines.drain(0..(lines.len() - max_lines));
    }
    Ok(lines.join("\n"))
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    Ok(())
}

fn reset_log_files(paths: &ResolvedPaths) -> Result<(), String> {
    for path in [&paths.stdout_log_path, &paths.stderr_log_path] {
        let mut file = File::create(path)
            .map_err(|error| format!("failed to reset log file {}: {error}", path.display()))?;
        file.write_all(b"")
            .map_err(|error| format!("failed to clear log file {}: {error}", path.display()))?;
    }
    Ok(())
}

fn default_management_key() -> String {
    "api-xuanshukejiapi".to_string()
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn normalize_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        "127.0.0.1".to_string()
    } else {
        trimmed.to_string()
    }
}

fn runtime_mode_label(settings: &BootstrapSettings) -> &'static str {
    if settings
        .explicit_binary_path
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        "显式二进制"
    } else if resolve_bundled_sidecar_path().is_some() {
        "内置 Sidecar"
    } else {
        "开发模式"
    }
}

fn load_existing_management_key(paths: &ResolvedPaths) -> Option<String> {
    let content = fs::read_to_string(&paths.bootstrap_path).ok()?;
    let settings = serde_json::from_str::<BootstrapSettings>(&content).ok()?;
    let key = settings.management_key.trim();
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

fn browser_management_disabled() -> bool {
    true
}

fn format_system_time(time: SystemTime) -> String {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn yaml_key(value: &str) -> YamlValue {
    YamlValue::String(value.to_string())
}

fn yaml_mapping_string(map: &Mapping, key: &str) -> Option<String> {
    map.get(yaml_key(key))
        .and_then(YamlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn get_or_create_sequence<'a>(root: &'a mut Mapping, key: &str) -> &'a mut Vec<YamlValue> {
    let sequence_key = yaml_key(key);
    let needs_reset = !matches!(root.get(&sequence_key), Some(YamlValue::Sequence(_)));
    if needs_reset {
        root.insert(sequence_key.clone(), YamlValue::Sequence(Vec::new()));
    }
    root.get_mut(&sequence_key)
        .and_then(YamlValue::as_sequence_mut)
        .expect("sequence inserted above")
}

fn to_runtime_paths(paths: &ResolvedPaths) -> RuntimePaths {
    RuntimePaths {
        app_data_dir: paths.app_data_dir.display().to_string(),
        runtime_dir: paths.runtime_dir.display().to_string(),
        static_dir: paths.static_dir.display().to_string(),
        config_dir: paths.config_dir.display().to_string(),
        logs_dir: paths.logs_dir.display().to_string(),
        bootstrap_path: paths.bootstrap_path.display().to_string(),
        config_path: paths.config_path.display().to_string(),
        stdout_log_path: paths.stdout_log_path.display().to_string(),
        stderr_log_path: paths.stderr_log_path.display().to_string(),
    }
}
