export type CpaStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface BootstrapSettings {
  apiPort: number
  autoStart: boolean
  binaryMode: string
  explicitBinaryPath: string | null
}

export interface RuntimePaths {
  appDataDir: string
  runtimeDir: string
  staticDir: string
  configDir: string
  logsDir: string
  bootstrapPath: string
  configPath: string
  stdoutLogPath: string
  stderrLogPath: string
}

export interface CpaState {
  status: CpaStatus
  pid: number | null
  startedAt: string | null
  apiPort: number
  binaryPath: string | null
  configPath: string
  logsDir: string
  lastError: string | null
  browserManagementDisabled: boolean
  runtimeModeLabel: string
  bootstrap: BootstrapSettings
}

export interface AppState {
  appName: string
  appVersion: string
  platform: string
}

export interface CpaManagementInfo {
  managementKey: string
}

export interface ImportAuthInputFile {
  name: string
  bytes: number[]
}

export interface LocalAuthFile {
  name: string
  bytes: number[]
}

export interface ImportAuthFilesResult {
  importedCount: number
  extractedCount: number
  skipped: string[]
  response: unknown
}

export interface ExportAuthArchiveResult {
  fileName: string
  fileCount: number
  savedPath: string | null
}

export interface OpenClawSetupResult {
  configPath: string
  providerId: string
  modelCount: number
  alias: string
}

export interface CodexConfigState {
  configPath: string
  exists: boolean
  currentModel: string | null
  currentBaseUrl: string | null
  availableModels: string[]
  canRestoreDefault: boolean
}

export interface CodexConfigUpdateResult {
  configPath: string
  model: string
  baseUrl: string
}

export interface CodexConfigRestoreResult {
  configPath: string
  restored: boolean
}

export interface ContinueConfigState {
  configPath: string
  exists: boolean
  currentBaseUrl: string | null
  chatModel: string | null
  autocompleteModel: string | null
  recommendedChatModel: string | null
  recommendedAutocompleteModel: string | null
  availableModels: string[]
  canRestoreDefault: boolean
}

export interface ContinueConfigSetupInput {
  chatModel: string
  autocompleteModel: string
}

export interface ContinueConfigSetupResult {
  configPath: string
  baseUrl: string
  chatModel: string
  autocompleteModel: string
}

export interface ContinueConfigRestoreResult {
  configPath: string
  restored: boolean
}

export interface AppUpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  downloadUrl: string | null
  notes: string | null
  publishedAt: string | null
  checkedAt: string
}
