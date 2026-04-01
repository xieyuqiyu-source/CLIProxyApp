import { invoke } from '@tauri-apps/api/core'
import type {
  AppState,
  BootstrapSettings,
  CpaManagementInfo,
  CpaState,
  ExportAuthArchiveResult,
  ImportAuthFilesResult,
  ImportAuthInputFile,
  RuntimePaths
} from './types'

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
  openConfigDir: () => invoke('open_cpa_config_dir'),
  openLogsDir: () => invoke('open_cpa_log_dir')
}
