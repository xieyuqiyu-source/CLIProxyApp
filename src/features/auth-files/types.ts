export type AuthProviderKey =
  | 'claude'
  | 'codex'
  | 'gemini-cli'
  | 'antigravity'
  | 'kimi'
  | 'unknown'

export interface AuthFileItem {
  name: string
  type?: string
  provider?: string
  authIndex?: string | number | null
  auth_index?: string | number | null
  runtimeOnly?: boolean | string
  runtime_only?: boolean | string
  disabled?: boolean | string | number
  email?: string | null
  [key: string]: unknown
}

export interface AuthFilesResponse {
  files: AuthFileItem[]
  total?: number
}

export interface AuthFileModel {
  id: string
  display_name?: string
  type?: string
  owned_by?: string
}
