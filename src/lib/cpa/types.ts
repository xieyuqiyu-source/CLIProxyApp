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
