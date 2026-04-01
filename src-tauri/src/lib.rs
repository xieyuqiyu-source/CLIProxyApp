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
            proxy_management_request
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
fn proxy_management_request(
    app: tauri::AppHandle,
    request: cpa::ManagementProxyRequest,
) -> Result<serde_json::Value, String> {
    cpa::proxy_management_request(&app, request)
}
