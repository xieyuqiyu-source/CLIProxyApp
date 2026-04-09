import { useCallback, useRef, useState } from 'react'
import { autologinApi } from './api'
import type {
  AutoLoginAccountStatus,
  AutoLoginEvent,
  AutoLoginSession,
  JiegehaoAccount
} from './types'
import { oauthApi } from '../api'

const ACCOUNT_TIMEOUT_MS = 90_000  // per-account timeout
const CODE_FETCH_DELAY_MS = 3_000  // wait before calling jiegehao code API
const OAUTH_POLL_INTERVAL_MS = 3_000
const OAUTH_POLL_MAX_ATTEMPTS = 20

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function escapeJsString(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '')
}

export interface AutoLoginLogEntry {
  ts: string
  level: 'info' | 'warn' | 'error' | 'success'
  msg: string
}

function nowTs() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

export function useAutoLogin() {
  const [session, setSession] = useState<AutoLoginSession>({
    isRunning: false,
    currentIndex: -1,
    accountStatuses: []
  })
  const [logs, setLogs] = useState<AutoLoginLogEntry[]>([])

  // Use a ref so the async loop always has the latest abort signal
  const abortRef = useRef(false)

  const addLog = useCallback(
    (msg: string, level: AutoLoginLogEntry['level'] = 'info') => {
      setLogs((prev) => [...prev, { ts: nowTs(), level, msg }])
    },
    []
  )

  const clearLogs = useCallback(() => setLogs([]), [])

  const updateStatus = useCallback(
    (id: string, update: Partial<AutoLoginAccountStatus>) => {
      setSession((prev) => ({
        ...prev,
        accountStatuses: prev.accountStatuses.map((s) =>
          s.id === id ? { ...s, ...update } : s
        )
      }))
    },
    []
  )

  /**
   * Run auto-login for ONE jiegehao account.
   * Returns 'success', 'error', or 'empty'.
   */
  const runSingleAccount = useCallback(
    async (
      jiegehaoAccount: JiegehaoAccount,
      onProgress: (msg: string) => void
    ): Promise<'success' | 'error' | 'empty'> => {
      const log = (msg: string, level: AutoLoginLogEntry['level'] = 'info') => {
        onProgress(msg)
        addLog(`[${jiegehaoAccount.account}] ${msg}`, level)
      }

      // Step 1 – Get Codex credentials from jiegehao
      log('▶ Step 1: 向借个号登录，获取 Codex 账号...')
      let loginResult
      try {
        loginResult = await autologinApi.getCodexCredentials(
          jiegehaoAccount.account,
          jiegehaoAccount.password
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        // "pit 为空" means no available accounts
        if (msg.includes('pit 为空') || msg.includes('没有可用')) {
          log('⚠ pit 为空，跳过该账号', 'warn')
          return 'empty'
        }
        log(`✗ 借个号登录失败: ${msg}`, 'error')
        throw new Error(`借个号登录失败: ${msg}`)
      }

      const { token, codexAccount, codexPassword, seatId } = loginResult
      log(`✓ 获取 Codex 账号: ${codexAccount}  seat_id=${seatId}`, 'success')

      // Step 2 – Start Codex OAuth and get URL
      log('▶ Step 2: 生成 Codex OAuth 链接...')
      const oauthResult = await oauthApi.startAuth('codex')
      log(`✓ OAuth URL 已生成  state=${oauthResult.state ?? '无'}`, 'success')

      if (!oauthResult.url) {
        log('✗ OAuth URL 为空', 'error')
        throw new Error('OAuth URL 为空')
      }

      // Step 3 – Open automation webview
      log('▶ Step 3: 打开授权浏览器窗口...')
      await autologinApi.openWindow(oauthResult.url, codexAccount, codexPassword)
      log('✓ 浏览器窗口已打开', 'success')

      // Step 4 – Handle automation events with timeout
      const outcome = await new Promise<'success' | 'error'>(
        (resolve, reject) => {
          let unlisten: (() => void) | null = null
          let codeAlreadyFetched = false

          const timer = setTimeout(() => {
            cleanup()
            reject(new Error('自动登录超时'))
          }, ACCOUNT_TIMEOUT_MS)

          function cleanup() {
            clearTimeout(timer)
            if (unlisten) {
              unlisten()
              unlisten = null
            }
          }

          autologinApi.onEvent(async (event: AutoLoginEvent) => {
            if (abortRef.current) {
              cleanup()
              reject(new Error('已中止'))
              return
            }

            switch (event.type) {
              case 'progress': {
                const msg = typeof event.payload === 'string' ? event.payload : ''
                log(`  🌐 ${msg}`)
                break
              }

              case 'need_code': {
                if (codeAlreadyFetched) break
                codeAlreadyFetched = true

                const codeType =
                  event.payload &&
                  typeof event.payload === 'object' &&
                  'type' in event.payload
                    ? (event.payload as { type: string }).type
                    : 'email'

                log(
                  codeType === 'device'
                    ? '▶ Step 4: 检测到设备授权模式，已点击发送 OTP，等待 3 秒...'
                    : '▶ Step 4: 检测到检查收件箱页面，等待 3 秒后获取验证码...'
                )

                try {
                  await sleep(CODE_FETCH_DELAY_MS)

                  log('▶ Step 5: 向借个号获取验证码...')
                  const code = await autologinApi.fetchCode(token, codexAccount, seatId)
                  log(`✓ 验证码已获取: ${code}，正在填入...`, 'success')

                  await autologinApi.evalWindow(
                    `window.__CODEX_FILL_CODE__ && window.__CODEX_FILL_CODE__('${escapeJsString(code)}')`
                  )
                  log('✓ 验证码已填入并提交', 'success')
                } catch (codeErr: unknown) {
                  const errMsg = codeErr instanceof Error ? codeErr.message : String(codeErr)
                  log(`✗ 获取验证码失败: ${errMsg}`, 'error')
                  cleanup()
                  reject(new Error(`获取验证码失败: ${errMsg}`))
                }
                break
              }

              case 'error': {
                const msg = typeof event.payload === 'string' ? event.payload : '未知错误'
                log(`✗ 浏览器自动化错误: ${msg}`, 'error')
                cleanup()
                reject(new Error(`浏览器自动化失败: ${msg}`))
                break
              }

              case 'completed': {
                log('✓ 浏览器流程已完成，等待 OAuth 回调确认...', 'success')
                // If there's no state to poll, resolve immediately
                if (!oauthResult.state) {
                  cleanup()
                  resolve('success')
                }
                break
              }
            }
          }).then((fn) => {
            unlisten = fn
          })

          // Always poll OAuth callback status (Codex always returns a state)
          if (oauthResult.state) {
            ;(async () => {
              let attempts = 0
              while (attempts < OAUTH_POLL_MAX_ATTEMPTS && !abortRef.current) {
                await sleep(OAUTH_POLL_INTERVAL_MS)
                attempts++
                try {
                  const status = await oauthApi.getAuthStatus(oauthResult.state!)
                  if (status.status === 'ok') {
                    log('✓✓ OAuth 回调状态：成功！授权完成', 'success')
                    cleanup()
                    resolve('success')
                    return
                  }
                  if (status.status === 'error') {
                    log(`✗ OAuth 回调状态：错误 — ${status.error ?? '未知'}`, 'error')
                    cleanup()
                    reject(new Error(status.error || 'OAuth 回调返回错误'))
                    return
                  }
                  log(`  ⏳ OAuth 轮询中... (${attempts}/${OAUTH_POLL_MAX_ATTEMPTS})`)
                } catch {
                  // Ignore transient poll errors
                }
              }
              if (!abortRef.current) {
                log('✗ OAuth 状态轮询超时', 'error')
                cleanup()
                reject(new Error('OAuth 状态轮询超时'))
              }
            })()
          }
        }
      )

      return outcome
    },
    [updateStatus, addLog]
  )

  /** Start the full batch auto-login sequence */
  const startBatch = useCallback(
    async (accounts: JiegehaoAccount[]) => {
      if (accounts.length === 0) return

      abortRef.current = false
      clearLogs()
      addLog(`━━ 开始批量登录，共 ${accounts.length} 个账号 ━━`, 'info')

      const initialStatuses: AutoLoginAccountStatus[] = accounts.map((a) => ({
        id: a.id,
        account: a.account,
        status: 'pending',
        error: undefined,
        progressMsg: undefined
      }))

      setSession({
        isRunning: true,
        currentIndex: 0,
        accountStatuses: initialStatuses
      })

      for (let i = 0; i < accounts.length; i++) {
        if (abortRef.current) break

        const acc = accounts[i]

        setSession((prev) => ({ ...prev, currentIndex: i }))
        addLog(`
── 账号 ${i + 1}/${accounts.length}: ${acc.account} ──`, 'info')
        updateStatus(acc.id, { status: 'running', error: undefined, progressMsg: '正在处理...' })

        try {
          const result = await runSingleAccount(acc, (msg) =>
            updateStatus(acc.id, { progressMsg: msg })
          )

          if (result === 'empty') {
            addLog(`⚠ ${acc.account} — 无可用 pit，已跳过`, 'warn')
            updateStatus(acc.id, {
              status: 'empty',
              error: '该账号没有可用的 Codex pit，已跳过',
              progressMsg: undefined
            })
          } else {
            addLog(`✓✓ ${acc.account} — 授权成功 🎉`, 'success')
            updateStatus(acc.id, { status: 'success', error: undefined, progressMsg: undefined })
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          addLog(`✗ ${acc.account} — 失败: ${msg}`, 'error')
          updateStatus(acc.id, { status: 'error', error: msg, progressMsg: undefined })
        } finally {
          // Always try to close the automation window before next account
          await autologinApi.closeWindow().catch(() => {})
          await sleep(1000)
        }
      }

      addLog('━━ 批量登录结束 ━━', 'info')
      setSession((prev) => ({ ...prev, isRunning: false, currentIndex: -1 }))
    },
    [runSingleAccount, updateStatus, addLog, clearLogs]
  )

  const stopBatch = useCallback(() => {
    abortRef.current = true
    autologinApi.closeWindow().catch(() => {})
    setSession((prev) => ({
      ...prev,
      isRunning: false,
      currentIndex: -1
    }))
  }, [])

  return { session, logs, clearLogs, startBatch, stopBatch }
}
