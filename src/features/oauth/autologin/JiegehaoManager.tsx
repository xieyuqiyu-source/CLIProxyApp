import { useCallback, useEffect, useRef, useState } from 'react'
import { autologinApi } from './api'
import { useAutoLogin } from './useAutoLogin'
import type { AutoLoginAccountStatus, JiegehaoAccount } from './types'
import type { AutoLoginLogEntry } from './useAutoLogin'

function nanoid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function StatusBadge({ status }: { status: AutoLoginAccountStatus['status'] }) {
  const map: Record<string, string> = {
    pending: 'badge-ghost',
    running: 'badge-warning',
    success: 'badge-success',
    error: 'badge-error',
    empty: 'badge-error'
  }
  const labels: Record<string, string> = {
    pending: '待处理',
    running: '进行中',
    success: '已完成',
    error: '失败',
    empty: '无可用账号'
  }
  return (
    <span className={`badge badge-sm ${map[status] ?? 'badge-ghost'}`}>
      {labels[status] ?? status}
    </span>
  )
}

export interface JiegehaoManagerProps {
  onClose: () => void
  /** Called when a Codex auth completes successfully */
  onCodexAuthSuccess?: () => void
}

export function JiegehaoManager({ onClose, onCodexAuthSuccess }: JiegehaoManagerProps) {
  const [accounts, setAccounts] = useState<JiegehaoAccount[]>([])
  const [loading, setLoading] = useState(true)

  // Add-form state
  const [formAccount, setFormAccount] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const { session, logs, clearLogs, startBatch, stopBatch } = useAutoLogin()
  const prevIsRunningRef = useRef(false)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll log panel
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Load accounts on mount
  useEffect(() => {
    autologinApi.loadAccounts().then((list) => {
      setAccounts(list)
      setLoading(false)
    })
  }, [])

  // Detect batch completion → notify parent
  useEffect(() => {
    if (prevIsRunningRef.current && !session.isRunning) {
      // Batch just finished
      const hasSuccess = session.accountStatuses.some((s) => s.status === 'success')
      if (hasSuccess && onCodexAuthSuccess) {
        onCodexAuthSuccess()
      }
    }
    prevIsRunningRef.current = session.isRunning
  }, [session.isRunning, session.accountStatuses, onCodexAuthSuccess])

  const handleAddAccount = useCallback(async () => {
    const acc = formAccount.trim()
    const pwd = formPassword.trim()
    if (!acc || !pwd) {
      setFormError('账号和密码均不能为空')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const newAccount: JiegehaoAccount = {
        id: nanoid(),
        account: acc,
        password: pwd,
        status: 'pending'
      }
      const updated = await autologinApi.saveAccount(newAccount)
      setAccounts(updated)
      setFormAccount('')
      setFormPassword('')
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [formAccount, formPassword])

  const handleDelete = useCallback(async (id: string) => {
    try {
      const updated = await autologinApi.deleteAccount(id)
      setAccounts(updated)
    } catch {
      // ignore
    }
  }, [])

  const handleStartBatch = useCallback(() => {
    if (accounts.length === 0) return
    startBatch(accounts)
  }, [accounts, startBatch])

  // Merge stored accounts with live session statuses
  const displayList: Array<JiegehaoAccount & { liveStatus?: AutoLoginAccountStatus }> =
    accounts.map((a) => ({
      ...a,
      liveStatus: session.accountStatuses.find((s) => s.id === a.id)
    }))

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-6">
          <div>
            <h3 className="text-lg font-bold">批量自动登录 — 借个号账号</h3>
            <p className="text-sm text-base-content/60 mt-1">
              存入借个号平台账号，系统将依次为 Codex 发起自动 OAuth 授权。
            </p>
          </div>
          <button className="btn btn-sm btn-ghost btn-circle" onClick={onClose} disabled={session.isRunning}>✕</button>
        </div>

        {/* Add account form */}
        <div className="rounded-box border border-base-300 bg-base-200/50 p-4 mb-4">
          <p className="text-sm font-semibold mb-3">添加借个号账号</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              className="input input-sm flex-1"
              placeholder="借个号账号（邮箱/手机号）"
              value={formAccount}
              disabled={session.isRunning}
              onChange={(e) => setFormAccount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAddAccount()}
            />
            <input
              type="password"
              className="input input-sm flex-1"
              placeholder="借个号密码"
              value={formPassword}
              disabled={session.isRunning}
              onChange={(e) => setFormPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAddAccount()}
            />
            <button
              className="btn btn-sm btn-primary"
              disabled={saving || session.isRunning}
              onClick={() => void handleAddAccount()}
            >
              {saving && <span className="loading loading-spinner loading-xs" />}
              添加
            </button>
          </div>
          {formError && (
            <div className="mt-2 alert alert-error py-2 text-sm">
              <span>{formError}</span>
            </div>
          )}
        </div>

        {/* Account list */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-sm font-semibold">账号列表</span>
            <span className="badge badge-neutral badge-sm">{accounts.length}</span>
          </div>

          {loading && (
            <div className="py-6 text-center text-sm text-base-content/50">
              <span className="loading loading-spinner loading-sm mr-2" />加载中...
            </div>
          )}

          {!loading && accounts.length === 0 && (
            <div className="py-6 text-center rounded-box bg-base-200 text-sm text-base-content/50">
              暂无账号，请先添加
            </div>
          )}

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {displayList.map((item) => {
              const live = item.liveStatus
              const displayStatus = live?.status ?? (item.status as AutoLoginAccountStatus['status'])
              const isCurrentlyRunning = live?.status === 'running'

              return (
                <div
                  key={item.id}
                  className={`rounded-box border px-3 py-2 text-sm transition-colors ${
                    live?.status === 'error' || live?.status === 'empty'
                      ? 'border-error/40 bg-error/5'
                      : live?.status === 'success'
                      ? 'border-success/40 bg-success/5'
                      : live?.status === 'running'
                      ? 'border-warning/40 bg-warning/5'
                      : 'border-base-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isCurrentlyRunning && (
                      <span className="loading loading-spinner loading-xs shrink-0" />
                    )}
                    <span className="flex-1 truncate font-mono text-xs">{item.account}</span>
                    <StatusBadge status={displayStatus} />
                    <button
                      className="btn btn-xs btn-ghost text-error"
                      disabled={session.isRunning}
                      onClick={() => void handleDelete(item.id)}
                    >
                      删除
                    </button>
                  </div>

                  {/* Progress / error message */}
                  {live?.progressMsg && (
                    <p className="mt-1 text-xs text-base-content/60 truncate">{live.progressMsg}</p>
                  )}
                  {live?.error && (
                    <p className="mt-1 text-xs text-error truncate">{live.error}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Session summary bar */}
        {session.accountStatuses.length > 0 && (
          <div className="rounded-box bg-base-200 px-3 py-2 text-xs flex flex-wrap gap-3 mb-4">
            <span>
              总计：<strong>{session.accountStatuses.length}</strong>
            </span>
            <span className="text-success">
              成功：<strong>{session.accountStatuses.filter((s) => s.status === 'success').length}</strong>
            </span>
            <span className="text-error">
              错误：<strong>
                {session.accountStatuses.filter((s) => s.status === 'error' || s.status === 'empty').length}
              </strong>
            </span>
            {session.currentIndex >= 0 && (
              <span className="text-warning">
                当前：{session.currentIndex + 1} / {session.accountStatuses.length}
              </span>
            )}
          </div>
        )}

        {/* Console log panel */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-base-content/50">执行日志</span>
            <button
              className="btn btn-xs btn-ghost"
              onClick={clearLogs}
              disabled={session.isRunning}
            >
              清空
            </button>
          </div>
          <div className="rounded-box bg-neutral text-neutral-content font-mono text-xs p-3 h-48 overflow-y-auto">
            {logs.length === 0 ? (
              <span className="opacity-40">等待运行...</span>
            ) : (
              logs.map((entry: AutoLoginLogEntry, i: number) => (
                <div
                  key={i}
                  className={`leading-5 whitespace-pre-wrap break-all ${
                    entry.level === 'error'
                      ? 'text-error'
                      : entry.level === 'success'
                      ? 'text-success'
                      : entry.level === 'warn'
                      ? 'text-warning'
                      : 'opacity-80'
                  }`}
                >
                  <span className="opacity-40 select-none mr-2">{entry.ts}</span>{entry.msg}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Action buttons */}
        <div className="modal-action flex flex-wrap gap-2 justify-end mt-0">
          {session.isRunning ? (
            <button className="btn btn-error btn-sm" onClick={stopBatch}>
              停止批量登录
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              disabled={accounts.length === 0}
              onClick={handleStartBatch}
            >
              开始批量自动登录
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={session.isRunning}
          >
            关闭
          </button>
        </div>
      </div>

      {/* Backdrop */}
      <div className="modal-backdrop" onClick={() => !session.isRunning && onClose()} />
    </div>
  )
}
