mod autologin;
mod cpa;

use cpa::CpaRuntimeState;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_START_ID: &str = "tray_start_cpa";
const TRAY_STOP_ID: &str = "tray_stop_cpa";
const TRAY_QUIT_ID: &str = "tray_quit";

#[derive(Default)]
struct DesktopShellState {
    quitting: Mutex<bool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(CpaRuntimeState::default())
        .manage(DesktopShellState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if cfg!(target_os = "windows")
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                let shell_state = window.state::<DesktopShellState>();
                let quitting = shell_state
                    .quitting
                    .lock()
                    .map(|flag| *flag)
                    .unwrap_or(false);
                if !quitting {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                    }
                    let _ = window.hide();
                    return;
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == MAIN_WINDOW_LABEL
            {
                let state = window.state::<CpaRuntimeState>();
                if let Err(error) = cpa::shutdown_cpa(&state) {
                    eprintln!("failed to stop CPA on window destroy: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            get_cpa_state,
            start_cpa,
            stop_cpa,
            restart_cpa,
            get_cpa_runtime_paths,
            get_cpa_recent_logs,
            save_bootstrap_settings,
            get_cpa_management_info,
            open_cpa_config_dir,
            open_cpa_log_dir,
            proxy_management_request,
            import_auth_files,
            export_auth_files_archive,
            get_local_auth_files,
            pick_local_auth_files,
            open_external_target,
            import_vertex_credential,
            setup_openclaw_provider,
            get_codex_config_state,
            set_codex_config_model,
            restore_codex_config_default,
            get_continue_config_state,
            setup_continue_config,
            restore_continue_config_default,
            check_app_update,
            proxy_cloud_request,
            proxy_cloud_upload,
            proxy_cloud_download,
            // autologin commands
            autologin::autologin_load_accounts,
            autologin::autologin_save_account,
            autologin::autologin_delete_account,
            autologin::autologin_jiegehao_get_codex,
            autologin::autologin_fetch_code,
            autologin::autologin_open_window,
            autologin::autologin_eval_window,
            autologin::autologin_close_window,
            autologin::autologin_webview_report
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let state = handle.state::<CpaRuntimeState>();
            if let Err(error) = cpa::shutdown_cpa(&state) {
                eprintln!("failed to stop CPA on app exit: {error}");
            }
        }
    });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, "显示主界面", true, None::<&str>)?;
    let start_item = MenuItem::with_id(app, TRAY_START_ID, "启动 CPA", true, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, TRAY_STOP_ID, "停止 CPA", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "退出程序", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&show_item, &start_item, &stop_item, &separator, &quit_item],
    )?;

    let mut tray_builder = TrayIconBuilder::with_id("app-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("failed to show main window: {error}");
                }
            }
            TRAY_START_ID => {
                let state = app.state::<CpaRuntimeState>();
                if let Err(error) = cpa::start_cpa(app, &state) {
                    eprintln!("failed to start CPA from tray: {error}");
                }
                let _ = show_main_window(app);
            }
            TRAY_STOP_ID => {
                let state = app.state::<CpaRuntimeState>();
                if let Err(error) = cpa::stop_cpa(app, &state) {
                    eprintln!("failed to stop CPA from tray: {error}");
                }
            }
            TRAY_QUIT_ID => {
                if let Err(error) = quit_application(app) {
                    eprintln!("failed to quit application from tray: {error}");
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Err(error) = show_main_window(&app) {
                    eprintln!("failed to restore main window from tray click: {error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    tray_builder.build(app)?;

    Ok(())
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = resolve_main_window(app)?;
    window
        .show()
        .map_err(|error| format!("failed to show main window: {error}"))?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

fn resolve_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())
}

fn quit_application(app: &AppHandle) -> Result<(), String> {
    let shell_state = app.state::<DesktopShellState>();
    if let Ok(mut quitting) = shell_state.quitting.lock() {
        *quitting = true;
    }
    let state = app.state::<CpaRuntimeState>();
    cpa::shutdown_cpa(&state)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn get_app_state(app: tauri::AppHandle) -> cpa::AppState {
    cpa::get_app_state(&app)
}

#[tauri::command]
fn get_cpa_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, CpaRuntimeState>,
) -> Result<cpa::CpaState, String> {
    cpa::get_cpa_state(&app, &state)
}

#[tauri::command]
fn start_cpa(
    app: tauri::AppHandle,
    state: tauri::State<'_, CpaRuntimeState>,
) -> Result<cpa::CpaState, String> {
    cpa::start_cpa(&app, &state)
}

#[tauri::command]
fn stop_cpa(
    app: tauri::AppHandle,
    state: tauri::State<'_, CpaRuntimeState>,
) -> Result<cpa::CpaState, String> {
    cpa::stop_cpa(&app, &state)
}

#[tauri::command]
fn restart_cpa(
    app: tauri::AppHandle,
    state: tauri::State<'_, CpaRuntimeState>,
) -> Result<cpa::CpaState, String> {
    cpa::restart_cpa(&app, &state)
}

#[tauri::command]
fn get_cpa_runtime_paths(app: tauri::AppHandle) -> Result<cpa::RuntimePaths, String> {
    cpa::get_runtime_paths(&app)
}

#[tauri::command]
fn get_cpa_recent_logs(app: tauri::AppHandle, max_lines: Option<usize>) -> Result<String, String> {
    cpa::get_cpa_recent_logs(&app, max_lines)
}

#[tauri::command]
fn save_bootstrap_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, CpaRuntimeState>,
    settings: cpa::BootstrapSettings,
) -> Result<cpa::CpaState, String> {
    cpa::save_bootstrap_settings(&app, &state, settings)
}

#[tauri::command]
fn get_cpa_management_info(app: tauri::AppHandle) -> Result<cpa::CpaManagementInfo, String> {
    cpa::get_cpa_management_info(&app)
}

#[tauri::command]
fn open_cpa_config_dir(app: tauri::AppHandle) -> Result<(), String> {
    cpa::open_cpa_config_dir(&app)
}

#[tauri::command]
fn open_cpa_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    cpa::open_cpa_log_dir(&app)
}

#[tauri::command]
async fn proxy_management_request(
    app: tauri::AppHandle,
    request: cpa::ManagementProxyRequest,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::proxy_management_request(&app, request))
        .await
        .map_err(|error| format!("failed to join management proxy task: {error}"))?
}

#[tauri::command]
fn import_auth_files(
    app: tauri::AppHandle,
    files: Vec<cpa::ImportAuthInputFile>,
) -> Result<cpa::ImportAuthFilesResult, String> {
    cpa::import_auth_files(&app, files)
}

#[tauri::command]
fn export_auth_files_archive(
    app: tauri::AppHandle,
) -> Result<cpa::ExportAuthArchiveResult, String> {
    cpa::export_auth_files_archive(&app)
}

#[tauri::command]
fn get_local_auth_files(app: tauri::AppHandle) -> Result<Vec<cpa::LocalAuthFile>, String> {
    cpa::get_local_auth_files(&app)
}

#[tauri::command]
fn pick_local_auth_files(app: tauri::AppHandle) -> Result<Vec<cpa::LocalAuthFile>, String> {
    cpa::pick_local_auth_files(&app)
}

#[tauri::command]
fn open_external_target(target: String) -> Result<(), String> {
    cpa::open_external_target(&target)
}

#[tauri::command]
fn import_vertex_credential(
    app: tauri::AppHandle,
    file: cpa::ImportAuthInputFile,
    location: Option<String>,
) -> Result<serde_json::Value, String> {
    cpa::import_vertex_credential(&app, file, location)
}

#[tauri::command]
async fn setup_openclaw_provider(
    app: tauri::AppHandle,
) -> Result<cpa::OpenClawSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::setup_openclaw_provider(&app))
        .await
        .map_err(|error| format!("failed to join OpenClaw setup task: {error}"))?
}

#[tauri::command]
async fn get_codex_config_state(app: tauri::AppHandle) -> Result<cpa::CodexConfigState, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::get_codex_config_state(&app))
        .await
        .map_err(|error| format!("failed to join Codex config task: {error}"))?
}

#[tauri::command]
async fn set_codex_config_model(
    app: tauri::AppHandle,
    model: String,
) -> Result<cpa::CodexConfigUpdateResult, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::set_codex_config_model(&app, model))
        .await
        .map_err(|error| format!("failed to join Codex config write task: {error}"))?
}

#[tauri::command]
async fn restore_codex_config_default(
    app: tauri::AppHandle,
) -> Result<cpa::CodexConfigRestoreResult, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::restore_codex_config_default(&app))
        .await
        .map_err(|error| format!("failed to join Codex config restore task: {error}"))?
}

#[tauri::command]
async fn get_continue_config_state(
    app: tauri::AppHandle,
) -> Result<cpa::ContinueConfigState, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::get_continue_config_state(&app))
        .await
        .map_err(|error| format!("failed to join Continue config task: {error}"))?
}

#[tauri::command]
async fn setup_continue_config(
    app: tauri::AppHandle,
    input: cpa::ContinueConfigSetupInput,
) -> Result<cpa::ContinueConfigSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::setup_continue_config(&app, input))
        .await
        .map_err(|error| format!("failed to join Continue config write task: {error}"))?
}

#[tauri::command]
async fn restore_continue_config_default(
    app: tauri::AppHandle,
) -> Result<cpa::ContinueConfigRestoreResult, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::restore_continue_config_default(&app))
        .await
        .map_err(|error| format!("failed to join Continue config restore task: {error}"))?
}

#[tauri::command]
async fn check_app_update(app: tauri::AppHandle) -> Result<cpa::AppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::check_app_update(&app))
        .await
        .map_err(|error| format!("failed to join app update task: {error}"))?
}

#[tauri::command]
async fn proxy_cloud_request(request: cpa::CloudProxyRequest) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::proxy_cloud_request(request))
        .await
        .map_err(|error| format!("failed to join cloud proxy task: {error}"))?
}

#[tauri::command]
async fn proxy_cloud_upload(request: cpa::CloudUploadRequest) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::proxy_cloud_upload(request))
        .await
        .map_err(|error| format!("failed to join cloud upload task: {error}"))?
}

#[tauri::command]
async fn proxy_cloud_download(
    request: cpa::CloudDownloadRequest,
) -> Result<cpa::CloudDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || cpa::proxy_cloud_download(request))
        .await
        .map_err(|error| format!("failed to join cloud download task: {error}"))?
}
