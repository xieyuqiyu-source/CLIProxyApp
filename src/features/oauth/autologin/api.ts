import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AutoLoginEvent, JiegehaoAccount, JiegehaoLoginResult } from './types'

export const autologinApi = {
  // ── Account CRUD ────────────────────────────────────────────────────────

  loadAccounts: () =>
    invoke<JiegehaoAccount[]>('autologin_load_accounts'),

  saveAccount: (account: JiegehaoAccount) =>
    invoke<JiegehaoAccount[]>('autologin_save_account', { account }),

  deleteAccount: (id: string) =>
    invoke<JiegehaoAccount[]>('autologin_delete_account', { id }),

  // ── Jiegehao.cn API ─────────────────────────────────────────────────────

  /** Login to jiegehao.cn and get the Codex credentials from the active pit */
  getCodexCredentials: (account: string, password: string) =>
    invoke<JiegehaoLoginResult>('autologin_jiegehao_get_codex', { account, password }),

  /** Fetch the Codex verification code (call after 3-second delay) */
  fetchCode: (token: string, userName: string, seatId: number) =>
    invoke<string>('autologin_fetch_code', { token, userName, seatId }),

  // ── Automation window ────────────────────────────────────────────────────

  openWindow: (url: string, codexAccount: string, codexPassword: string) =>
    invoke<void>('autologin_open_window', { url, codexAccount, codexPassword }),

  evalWindow: (js: string) =>
    invoke<void>('autologin_eval_window', { js }),

  closeWindow: () =>
    invoke<void>('autologin_close_window'),

  // ── Event listener ───────────────────────────────────────────────────────

  onEvent: (handler: (event: AutoLoginEvent) => void): Promise<UnlistenFn> =>
    listen<AutoLoginEvent>('autologin-event', (e) => handler(e.payload)),
}
