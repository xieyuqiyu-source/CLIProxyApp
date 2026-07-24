export type QuotaProvider = 'claude' | 'antigravity' | 'codex' | 'gemini-cli' | 'xai' | 'kimi'

export interface AuthFileItem {
  name: string
  type?: string
  provider?: string
  authIndex?: string | number | null
  runtimeOnly?: boolean | string
  disabled?: boolean | string | number
  [key: string]: unknown
}

export interface AuthFilesResponse {
  files: AuthFileItem[]
  total?: number
}

export interface ApiCallRequest {
  authIndex?: string
  method: string
  url: string
  header?: Record<string, string>
  data?: string
}

export interface ApiCallResult<T = unknown> {
  statusCode: number
  header: Record<string, string[]>
  bodyText: string
  body: T | null
}

export interface QuotaMetric {
  id: string
  label: string
  value: string
  hint?: string
  tone?: 'success' | 'warning' | 'error' | 'info'
}

export interface QuotaResult {
  provider: QuotaProvider
  headline?: string
  summary?: string
  metrics: QuotaMetric[]
  badges?: string[]
}

export interface FileQuotaState {
  status: 'idle' | 'loading' | 'success' | 'error'
  data?: QuotaResult
  error?: string
}
