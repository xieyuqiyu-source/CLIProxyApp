export type OAuthProvider =
  | 'codex'
  | 'anthropic'
  | 'antigravity'
  | 'gemini-cli'
  | 'xai'
  | 'kimi'
  | 'qwen'

export interface OAuthStartResponse {
  url: string
  state?: string
}

export interface OAuthStatusResponse {
  status: 'ok' | 'wait' | 'error'
  error?: string
}

export interface IFlowCookieAuthResponse {
  status: 'ok' | 'error'
  error?: string
  saved_path?: string
  email?: string
  expired?: string
  type?: string
}

export interface VertexImportResponse {
  status?: 'ok'
  project_id?: string
  email?: string
  location?: string
  auth_file?: string
  'auth-file'?: string
}

export interface ProviderDefinition {
  id: OAuthProvider
  name: string
  subtitle: string
  accent: string
  callbackSupported?: boolean
  projectIdSupported?: boolean
}

export interface ProviderState {
  url?: string
  state?: string
  status?: 'idle' | 'waiting' | 'success' | 'error'
  error?: string
  polling?: boolean
  projectId?: string
  callbackUrl?: string
  callbackSubmitting?: boolean
  callbackStatus?: 'success' | 'error'
  callbackError?: string
}

export interface VertexImportState {
  file?: File
  fileName: string
  location: string
  loading: boolean
  error?: string
  result?: {
    projectId?: string
    email?: string
    location?: string
    authFile?: string
  }
}
