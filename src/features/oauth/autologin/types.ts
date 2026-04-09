// Types for the "借个号" (Jiegehao) auto-login feature

export interface JiegehaoAccount {
  id: string
  account: string
  password: string
  /** "pending" | "running" | "success" | "error" | "empty" */
  status: string
  error?: string
}

export interface JiegehaoLoginResult {
  token: string
  codexAccount: string
  codexPassword: string
  seatId: number
}

/** Event emitted from the automation webview → relayed to main window */
export interface AutoLoginEvent {
  type: 'progress' | 'need_code' | 'error' | 'completed'
  payload: string | { type: 'email' | 'device' } | null
}

export interface AutoLoginAccountStatus {
  id: string
  account: string
  status: 'pending' | 'running' | 'success' | 'error' | 'empty'
  error?: string
  progressMsg?: string
}

export interface AutoLoginSession {
  isRunning: boolean
  currentIndex: number
  accountStatuses: AutoLoginAccountStatus[]
}
