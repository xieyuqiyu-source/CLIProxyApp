mod cpa;

use cpa::CpaRuntimeState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(CpaRuntimeState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
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
            open_external_target,
            import_vertex_credential
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
