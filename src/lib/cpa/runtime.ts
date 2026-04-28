import { invoke } from '@tauri-apps/api/core'
import type {
  AppState,
  AppUpdateInfo,
  BootstrapSettings,
  CpaManagementInfo,
  CpaState,
  ContinueConfigRestoreResult,
  ContinueConfigSetupInput,
  ContinueConfigSetupResult,
  ContinueConfigState,
  CodexConfigRestoreResult,
  CodexConfigState,
  CodexConfigUpdateResult,
  ExportAuthArchiveResult,
  ImportAuthFilesResult,
  ImportAuthInputFile,
  LocalAuthFile,
  OpenClawConfigState,
  OpenClawSetupInput,
  OpenClawSetupResult,
  RuntimePaths
} from './types'
import { listen } from '@tauri-apps/api/event'

export const cpaRuntime = {
  getAppState: () => invoke<AppState>('get_app_state'),
  getState: () => invoke<CpaState>('get_cpa_state'),
  start: () => invoke<CpaState>('start_cpa'),
  stop: () => invoke<CpaState>('stop_cpa'),
  restart: () => invoke<CpaState>('restart_cpa'),
  getRuntimePaths: () => invoke<RuntimePaths>('get_cpa_runtime_paths'),
  getRecentLogs: (maxLines = 120) => invoke<string>('get_cpa_recent_logs', { maxLines }),
  saveBootstrapSettings: (settings: BootstrapSettings) =>
    invoke<CpaState>('save_bootstrap_settings', { settings }),
  getManagementInfo: () => invoke<CpaManagementInfo>('get_cpa_management_info'),
  importAuthFiles: (files: ImportAuthInputFile[]) =>
    invoke<ImportAuthFilesResult>('import_auth_files', { files }),
  exportAuthFilesArchive: () =>
    invoke<ExportAuthArchiveResult>('export_auth_files_archive'),
  getLocalAuthFiles: () =>
    invoke<LocalAuthFile[]>('get_local_auth_files'),
  getOpenClawConfigState: () =>
    invoke<OpenClawConfigState>('get_openclaw_config_state'),
  setupOpenClawProvider: (input: OpenClawSetupInput) =>
    invoke<OpenClawSetupResult>('setup_openclaw_provider', { input }),
  getCodexConfigState: () =>
    invoke<CodexConfigState>('get_codex_config_state'),
  setCodexConfigModel: (model: string) =>
    invoke<CodexConfigUpdateResult>('set_codex_config_model', { model }),
  restoreCodexConfigDefault: () =>
    invoke<CodexConfigRestoreResult>('restore_codex_config_default'),
  getContinueConfigState: () =>
    invoke<ContinueConfigState>('get_continue_config_state'),
  setupContinueConfig: (input: ContinueConfigSetupInput) =>
    invoke<ContinueConfigSetupResult>('setup_continue_config', { input }),
  restoreContinueConfigDefault: () =>
    invoke<ContinueConfigRestoreResult>('restore_continue_config_default'),
  checkAppUpdate: () =>
    invoke<AppUpdateInfo>('check_app_update'),
  onOpenClawSetupLog: (handler: (line: string) => void) =>
    listen<string>('openclaw-setup-log', (event) => handler(event.payload)),
  pickLocalAuthFiles: () =>
    invoke<LocalAuthFile[]>('pick_local_auth_files'),
  openExternalTarget: (target: string) =>
    invoke('open_external_target', { target }),
  importVertexCredential: (file: ImportAuthInputFile, location?: string) =>
    invoke<unknown>('import_vertex_credential', { file, location }),
  proxyManagementRequest: (request: {
    method: string
    path: string
    query?: Array<[string, string]>
    body?: unknown
  }) => invoke<unknown>('proxy_management_request', { request }),
  proxyCloudRequest: (request: {
    method: string
    path: string
    body?: unknown
    token?: string
  }) => invoke<unknown>('proxy_cloud_request', { request }),
  proxyCloudUpload: (request: {
    path: string
    fileName: string
    bytes: number[]
    mimeType?: string
    fields?: Record<string, string>
    token: string
  }) => invoke<unknown>('proxy_cloud_upload', { request }),
  proxyCloudDownload: (request: {
    path: string
    token: string
  }) => invoke<{ fileName: string; bytes: number[] }>('proxy_cloud_download', { request }),
  openConfigDir: () => invoke('open_cpa_config_dir'),
  openLogsDir: () => invoke('open_cpa_log_dir')
}
