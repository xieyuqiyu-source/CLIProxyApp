package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
static const cliproxy_host_api* stored_host;
static void store_host_api(const cliproxy_host_api* host) { stored_host = host; }
static int call_host_api(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
	if (stored_host == NULL || stored_host->call == NULL) { return 1; }
	return stored_host->call(stored_host->host_ctx, method, request, request_len, response);
}
static void free_host_buffer(void* ptr, size_t len) {
	if (stored_host != NULL && stored_host->free_buffer != NULL && ptr != NULL) { stored_host->free_buffer(ptr, len); }
}
*/
import "C"

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"unsafe"
)

const (
	abiVersion        uint32 = 1
	pluginID                 = "cloud-quota-card"
	localKeyMaterial         = "cliproxy-cloud-quota-card-local-v1"
	baseTokensPerUSD  int64  = 500000
	minChargeUSDMicro int64  = 1
)

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

type quotaCardPackage struct {
	Kind                     string `json:"kind"`
	Type                     string `json:"type"`
	CloudFileID              string `json:"cloud_file_id"`
	Provider                 string `json:"provider"`
	DisplayName              string `json:"display_name"`
	FileName                 string `json:"file_name"`
	DistributionMode         string `json:"distribution_mode"`
	QuotaLimit               int64  `json:"quota_limit"`
	QuotaUsed                int64  `json:"quota_used"`
	BillingMultiplier        int64  `json:"billing_multiplier"`
	QuotaUnit                string `json:"quota_unit"`
	QuotaBaseTokensPerDollar int64  `json:"quota_base_tokens_per_dollar"`
	Cipher                   string `json:"cipher"`
	QuotaToken               string `json:"quota_token"`
	CloudBaseURL             string `json:"cloud_base_url"`
}

type authParseRequest struct {
	FileName string          `json:"FileName"`
	RawJSON  json.RawMessage `json:"RawJSON"`
}

type authData struct {
	Provider    string            `json:"Provider"`
	ID          string            `json:"ID"`
	FileName    string            `json:"FileName"`
	Label       string            `json:"Label"`
	StorageJSON []byte            `json:"StorageJSON"`
	Metadata    map[string]any    `json:"Metadata"`
	Attributes  map[string]string `json:"Attributes"`
}

type executorHTTPRequest struct {
	Method      string              `json:"Method"`
	URL         string              `json:"URL"`
	Headers     map[string][]string `json:"Headers"`
	Body        []byte              `json:"Body"`
	StorageJSON []byte              `json:"StorageJSON"`
}

type hostHTTPRequest struct {
	Method  string              `json:"method"`
	URL     string              `json:"url"`
	Headers map[string][]string `json:"headers,omitempty"`
	Body    []byte              `json:"body,omitempty"`
}

type hostHTTPResponse struct {
	StatusCode int                 `json:"StatusCode"`
	Headers    map[string][]string `json:"Headers"`
	Body       []byte              `json:"Body"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	C.store_host_api(host)
	plugin.abi_version = C.uint32_t(abiVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required", 0))
		return 1
	}
	raw, err := handleMethod(C.GoString(method), cBytes(request, requestLen))
	if err != nil {
		writeResponse(response, errorEnvelope("plugin_error", err.Error(), http.StatusBadGateway))
		return 1
	}
	writeResponse(response, raw)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, len C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
	_ = len
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

func handleMethod(method string, rawReq []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		return okEnvelope(map[string]any{
			"schema_version": 1,
			"metadata": map[string]any{
				"Name":         pluginID,
				"Version":      "0.1.0",
				"Author":       "CLIProxyApp",
				"ConfigFields": []any{},
			},
			"capabilities": map[string]any{
				"auth_provider":           true,
				"executor":                true,
				"executor_model_scope":    "both",
				"executor_input_formats":  []string{"chat-completions", "responses", "codex", "openai"},
				"executor_output_formats": []string{"chat-completions", "responses", "codex", "openai"},
			},
		})
	case "auth.identifier", "executor.identifier":
		return okEnvelope(map[string]string{"identifier": pluginID})
	case "auth.parse":
		return handleAuthParse(rawReq)
	case "auth.refresh":
		return handleAuthRefresh(rawReq)
	case "executor.http_request":
		return handleHTTPRequest(rawReq)
	case "executor.execute", "executor.execute_stream", "executor.count_tokens":
		return errorEnvelope("unsupported_execution", "cloud quota card currently supports HTTP request execution", http.StatusBadRequest), nil
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method, 0), nil
	}
}

func handleAuthParse(rawReq []byte) ([]byte, error) {
	var req authParseRequest
	if err := json.Unmarshal(rawReq, &req); err != nil {
		return nil, fmt.Errorf("decode auth parse request: %w", err)
	}
	card, ok := parseQuotaCard(req.RawJSON)
	if !ok {
		return okEnvelope(map[string]any{"Handled": false})
	}
	fileName := firstNonEmpty(card.FileName, req.FileName, "cloud-quota-card.json")
	id := firstNonEmpty(card.CloudFileID, hashID(req.RawJSON))
	return okEnvelope(map[string]any{
		"Handled": true,
		"Auth": authData{
			Provider:    pluginID,
			ID:          "quota-card-" + id,
			FileName:    fileName,
			Label:       firstNonEmpty(card.DisplayName, "Cloud quota card"),
			StorageJSON: []byte(req.RawJSON),
			Metadata: map[string]any{
				"type":          pluginID,
				"provider":      card.Provider,
				"cloud_file_id": card.CloudFileID,
				"quota_limit":   card.QuotaLimit,
				"quota_used":    card.QuotaUsed,
			},
			Attributes: map[string]string{
				"auth_kind":     "cloud_quota_card",
				"card_provider": card.Provider,
				"cloud_file_id": card.CloudFileID,
			},
		},
	})
}

func handleAuthRefresh(rawReq []byte) ([]byte, error) {
	var req struct {
		AuthID      string          `json:"AuthID"`
		StorageJSON json.RawMessage `json:"StorageJSON"`
	}
	if err := json.Unmarshal(rawReq, &req); err != nil {
		return nil, fmt.Errorf("decode auth refresh request: %w", err)
	}
	card, ok := parseQuotaCard(req.StorageJSON)
	if !ok {
		return errorEnvelope("invalid_quota_card", "stored auth is not a cloud quota card", http.StatusBadRequest), nil
	}
	return okEnvelope(map[string]any{
		"Auth": authData{
			Provider:    pluginID,
			ID:          firstNonEmpty(req.AuthID, "quota-card-"+card.CloudFileID),
			FileName:    firstNonEmpty(card.FileName, "cloud-quota-card.json"),
			Label:       firstNonEmpty(card.DisplayName, "Cloud quota card"),
			StorageJSON: []byte(req.StorageJSON),
			Metadata: map[string]any{
				"type":          pluginID,
				"provider":      card.Provider,
				"cloud_file_id": card.CloudFileID,
				"quota_limit":   card.QuotaLimit,
				"quota_used":    card.QuotaUsed,
			},
			Attributes: map[string]string{
				"auth_kind":     "cloud_quota_card",
				"card_provider": card.Provider,
				"cloud_file_id": card.CloudFileID,
			},
		},
	})
}

func handleHTTPRequest(rawReq []byte) ([]byte, error) {
	var req executorHTTPRequest
	if err := json.Unmarshal(rawReq, &req); err != nil {
		return nil, fmt.Errorf("decode executor http request: %w", err)
	}
	card, ok := parseQuotaCard(req.StorageJSON)
	if !ok {
		return errorEnvelope("invalid_quota_card", "selected auth is not a cloud quota card", http.StatusUnauthorized), nil
	}
	if err := checkQuota(card, minChargeUSDMicro); err != nil {
		return errorEnvelope("quota_limited", err.Error(), http.StatusPaymentRequired), nil
	}
	decrypted, err := decryptCard(card)
	if err != nil {
		return errorEnvelope("decrypt_failed", err.Error(), http.StatusUnauthorized), nil
	}
	headers := cloneHeaders(req.Headers)
	applyCredentialHeaders(headers, card.Provider, decrypted, req.URL)
	resp, err := callHostHTTP(hostHTTPRequest{Method: req.Method, URL: req.URL, Headers: headers, Body: req.Body})
	clearBytes(decrypted)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 500 {
		charge := chargeUSDMicro(card, resp.Body)
		_ = reportUsage(card, charge)
	}
	return okEnvelope(resp)
}

func parseQuotaCard(raw []byte) (quotaCardPackage, bool) {
	var card quotaCardPackage
	if len(bytes.TrimSpace(raw)) == 0 || json.Unmarshal(raw, &card) != nil {
		return card, false
	}
	if card.Kind != "cloud_quota_card" && card.Type != "cloud-quota-card" {
		return card, false
	}
	return card, strings.TrimSpace(card.CloudFileID) != "" && strings.TrimSpace(card.Cipher) != ""
}

func decryptCard(card quotaCardPackage) ([]byte, error) {
	sealed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(card.Cipher))
	if err != nil {
		return nil, fmt.Errorf("decode card cipher: %w", err)
	}
	keyHash := sha256.Sum256([]byte(localKeyMaterial))
	block, err := aes.NewCipher(keyHash[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
}

func applyCredentialHeaders(headers map[string][]string, provider string, decrypted []byte, targetURL string) {
	credential := map[string]any{}
	_ = json.Unmarshal(decrypted, &credential)
	attrs := nestedStringMap(credential, "attributes")
	meta := nestedAnyMap(credential, "metadata")
	for key, value := range attrs {
		if strings.HasPrefix(strings.ToLower(key), "header:") {
			setHeader(headers, strings.TrimSpace(key[len("header:"):]), value)
		}
	}
	if apiKey := firstStringFromMaps(credential, attrs, meta, "api_key", "apiKey", "key"); apiKey != "" {
		if strings.EqualFold(provider, "claude") && isAnthropicURL(targetURL) {
			delHeader(headers, "Authorization")
			setHeader(headers, "x-api-key", apiKey)
		} else {
			setHeader(headers, "Authorization", "Bearer "+apiKey)
		}
	}
	if token := firstStringFromMaps(credential, attrs, meta, "access_token", "accessToken", "token"); token != "" {
		setHeader(headers, "Authorization", "Bearer "+token)
	}
	if accountID := firstStringFromMaps(credential, attrs, meta, "account_id", "accountID", "account"); accountID != "" {
		setHeader(headers, "Chatgpt-Account-Id", accountID)
	}
}

func checkQuota(card quotaCardPackage, units int64) error {
	base := strings.TrimRight(card.CloudBaseURL, "/")
	if base == "" {
		return fmt.Errorf("missing cloud base url")
	}
	body, _ := json.Marshal(map[string]any{"quotaToken": card.QuotaToken, "units": units})
	resp, err := callHostHTTP(hostHTTPRequest{
		Method:  http.MethodPost,
		URL:     fmt.Sprintf("%s/quota-cards/%s/check", base, url.PathEscape(strings.TrimSpace(card.CloudFileID))),
		Headers: map[string][]string{"Content-Type": {"application/json"}},
		Body:    body,
	})
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("cloud quota check failed: %d", resp.StatusCode)
	}
	var out struct {
		Allowed bool `json:"allowed"`
	}
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return fmt.Errorf("decode quota check: %w", err)
	}
	if !out.Allowed {
		return fmt.Errorf("quota card limit reached")
	}
	return nil
}

func reportUsage(card quotaCardPackage, units int64) error {
	base := strings.TrimRight(card.CloudBaseURL, "/")
	if base == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]any{"quotaToken": card.QuotaToken, "units": units})
	_, err := callHostHTTP(hostHTTPRequest{
		Method:  http.MethodPost,
		URL:     fmt.Sprintf("%s/quota-cards/%s/usage", base, url.PathEscape(strings.TrimSpace(card.CloudFileID))),
		Headers: map[string][]string{"Content-Type": {"application/json"}},
		Body:    body,
	})
	return err
}

func chargeUSDMicro(card quotaCardPackage, body []byte) int64 {
	input, output, total := usageTokens(body)
	if total <= 0 {
		total = input + output
	}
	if total <= 0 {
		return minChargeUSDMicro
	}
	multiplier := card.BillingMultiplier
	if multiplier <= 0 {
		multiplier = 1000
	}
	base := card.QuotaBaseTokensPerDollar
	if base <= 0 {
		base = baseTokensPerUSD
	}
	charge := math.Ceil(float64(total) * float64(multiplier) * 1000 / float64(base))
	if charge < float64(minChargeUSDMicro) {
		return minChargeUSDMicro
	}
	return int64(charge)
}

func usageTokens(body []byte) (input int64, output int64, total int64) {
	var root any
	if json.Unmarshal(body, &root) != nil {
		return 0, 0, 0
	}
	findUsage(root, &input, &output, &total)
	return input, output, total
}

func findUsage(value any, input *int64, output *int64, total *int64) {
	switch typed := value.(type) {
	case map[string]any:
		if usage, ok := typed["usage"]; ok {
			applyUsageMap(usage, input, output, total)
		}
		applyUsageMap(typed, input, output, total)
		for _, child := range typed {
			findUsage(child, input, output, total)
		}
	case []any:
		for _, child := range typed {
			findUsage(child, input, output, total)
		}
	}
}

func applyUsageMap(value any, input *int64, output *int64, total *int64) {
	typed, ok := value.(map[string]any)
	if !ok {
		return
	}
	if *input <= 0 {
		*input = firstInt64(typed, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
	}
	if *output <= 0 {
		*output = firstInt64(typed, "completion_tokens", "output_tokens", "completionTokens", "outputTokens")
	}
	if *total <= 0 {
		*total = firstInt64(typed, "total_tokens", "totalTokens")
	}
}

func firstInt64(values map[string]any, keys ...string) int64 {
	for _, key := range keys {
		switch value := values[key].(type) {
		case float64:
			if value > 0 {
				return int64(value)
			}
		case int64:
			if value > 0 {
				return value
			}
		case int:
			if value > 0 {
				return int64(value)
			}
		case json.Number:
			parsed, _ := value.Int64()
			if parsed > 0 {
				return parsed
			}
		}
	}
	return 0
}

func callHostHTTP(req hostHTTPRequest) (hostHTTPResponse, error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return hostHTTPResponse{}, err
	}
	respRaw, err := callHost("host.http.do", raw)
	if err != nil {
		return hostHTTPResponse{}, err
	}
	var resp hostHTTPResponse
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		return hostHTTPResponse{}, fmt.Errorf("decode host http response: %w", err)
	}
	return resp, nil
}

func callHost(method string, payload []byte) ([]byte, error) {
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))
	var response C.cliproxy_buffer
	var req *C.uint8_t
	if len(payload) > 0 {
		req = (*C.uint8_t)(C.CBytes(payload))
		defer C.free(unsafe.Pointer(req))
	}
	if C.call_host_api(cMethod, req, C.size_t(len(payload)), &response) != 0 {
		return nil, fmt.Errorf("host callback failed: %s", method)
	}
	if response.ptr == nil || response.len == 0 {
		return nil, fmt.Errorf("empty host callback response: %s", method)
	}
	defer C.free_host_buffer(response.ptr, response.len)
	raw := C.GoBytes(response.ptr, C.int(response.len))
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("decode host callback envelope: %w", err)
	}
	if !env.OK {
		if env.Error != nil {
			return nil, fmt.Errorf("%s", env.Error.Message)
		}
		return nil, fmt.Errorf("host callback returned error")
	}
	return env.Result, nil
}

func okEnvelope(result any) ([]byte, error) {
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string, status int) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message, HTTPStatus: status}})
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}

func cBytes(ptr *C.uint8_t, length C.size_t) []byte {
	if ptr == nil || length == 0 {
		return nil
	}
	return C.GoBytes(unsafe.Pointer(ptr), C.int(length))
}

func cloneHeaders(in map[string][]string) map[string][]string {
	out := make(map[string][]string, len(in)+2)
	for key, values := range in {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func setHeader(headers map[string][]string, key, value string) {
	key = strings.TrimSpace(key)
	value = strings.TrimSpace(value)
	if key == "" || value == "" {
		return
	}
	delHeader(headers, key)
	headers[key] = []string{value}
}

func delHeader(headers map[string][]string, key string) {
	for existing := range headers {
		if strings.EqualFold(existing, key) {
			delete(headers, existing)
		}
	}
}

func firstStringFromMaps(credential map[string]any, attrs map[string]string, meta map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(attrs[key]); value != "" {
			return value
		}
		if value := anyString(meta[key]); value != "" {
			return value
		}
		if value := anyString(credential[key]); value != "" {
			return value
		}
	}
	return ""
}

func nestedStringMap(root map[string]any, key string) map[string]string {
	out := make(map[string]string)
	raw := root[key]
	if raw == nil {
		raw = root[strings.ToUpper(key[:1])+key[1:]]
	}
	if typed, ok := raw.(map[string]any); ok {
		for k, v := range typed {
			if s := anyString(v); s != "" {
				out[k] = s
			}
		}
	}
	return out
}

func nestedAnyMap(root map[string]any, key string) map[string]any {
	if raw, ok := root[key].(map[string]any); ok {
		return raw
	}
	if raw, ok := root[strings.ToUpper(key[:1])+key[1:]].(map[string]any); ok {
		return raw
	}
	return map[string]any{}
}

func anyString(value any) string {
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func isAnthropicURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && strings.EqualFold(parsed.Host, "api.anthropic.com")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func hashID(raw []byte) string {
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x", sum[:8])
}

func clearBytes(data []byte) {
	for i := range data {
		data[i] = 0
	}
}
