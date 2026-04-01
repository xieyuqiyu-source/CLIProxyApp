use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Number, Value as YamlValue};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

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
            return Ok(command);
        }
    }

    if let Some(sidecar_path) = resolve_bundled_sidecar_path() {
        let mut command = Command::new(sidecar_path);
        command.arg("-config").arg(&ctx.paths.config_path);
        command.env("MANAGEMENT_STATIC_PATH", &ctx.paths.static_dir);
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
    Ok(command)
}

fn workspace_api_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let app_dir = manifest_dir
        .parent()
        .ok_or_else(|| "failed to resolve app directory".to_string())?;
    let workspace_dir = app_dir
        .parent()
        .ok_or_else(|| "failed to resolve workspace directory".to_string())?;
    let api_dir = workspace_dir.join("CLIProxyApi");
    if !api_dir.exists() {
        return Err(format!(
            "development workspace CLIProxyApi not found at {}",
            api_dir.display()
        ));
    }
    Ok(api_dir)
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
