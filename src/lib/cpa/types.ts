export type CpaStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface BootstrapSettings {
  host: string
  apiPort: number
  managementKey: string
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
  host: string
  apiPort: number
  managementBaseUrl: string
  managementKeyConfigured: boolean
  binaryPath: string | null
  configPath: string
  logsDir: string
  lastError: string | null
  bootstrap: BootstrapSettings
}

export interface AppState {
  appName: string
  appVersion: string
  platform: string
}
