import { useEffect, useMemo, useRef, useState } from 'react'
import { oauthApi } from './api'
import type {
  IFlowCookieAuthResponse,
  OAuthProvider,
  ProviderDefinition,
  ProviderState,
  VertexImportState
} from './types'
import { cpaRuntime } from '../../lib/cpa/runtime'
import { JiegehaoManager } from './autologin/JiegehaoManager'

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    subtitle: 'OpenAI / Codex OAuth 授权',
    accent: 'from-emerald-400 to-teal-500',
    callbackSupported: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude Code OAuth 授权',
    accent: 'from-orange-400 to-amber-500',
    callbackSupported: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    subtitle: 'Antigravity 浏览器授权',
    accent: 'from-cyan-400 to-sky-500',
    callbackSupported: true
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    subtitle: '支持项目 ID 的 Google 授权',
    accent: 'from-lime-400 to-green-500',
    callbackSupported: true,
    projectIdSupported: true
  },
  {
    id: 'kimi',
    name: 'Kimi',
    subtitle: 'Moonshot Kimi OAuth 授权',
    accent: 'from-pink-400 to-rose-500'
  },
  {
    id: 'qwen',
    name: 'Qwen',
    subtitle: '通义 Qwen OAuth 授权',
    accent: 'from-violet-400 to-fuchsia-500'
  }
]

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getStatusBadgeClass(status?: ProviderState['status']) {
  switch (status) {
    case 'success':
      return 'badge-success'
    case 'error':
      return 'badge-error'
    case 'waiting':
      return 'badge-warning'
    default:
      return 'badge-ghost'
  }
}

function getStatusText(state: ProviderState) {
  switch (state.status) {
    case 'success':
      return '已完成'
    case 'error':
      return state.error ? `失败: ${state.error}` : '失败'
    case 'waiting':
      return state.polling ? '等待回调中' : '已生成链接'
    default:
      return '未开始'
  }
}

function ProviderIcon({ id, className = '' }: { id: string; className?: string }) {
  switch (id) {
    case 'codex':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0462 6.0462 0 0 0 5.45-3.15 6.0557 6.0557 0 0 0 3.572-6.1181zM11.69 22.181a4.1165 4.1165 0 0 1-3.1444-1.464 4.0927 4.0927 0 0 1-1.0425-3.322l7.1517 4.148a4.1032 4.1032 0 0 1-2.9648.638zm-6.208-2.464a4.119 4.119 0 0 1-1.6377-2.9935 4.0945 4.0945 0 0 1 2.2795-2.6186l7.147 4.148-3.5786 2.062a4.105 4.105 0 0 1-4.21-.6zm-2.0326-6.866a4.1175 4.1175 0 0 1 1.5067-3.12 4.0932 4.0932 0 0 1 3.3205-.8844v8.2818l-3.5833-2.091a4.1126 4.1126 0 0 1-1.244-2.1864zm10.5186-6.155a3.9877 3.9877 0 0 1 3.13 1.459 3.9686 3.9686 0 0 1 1.0426 3.317l-7.152-4.144 2.9794-.632zm6.208 2.459a3.9902 3.9902 0 0 1 1.6377 2.9934 3.974 3.974 0 0 1-2.2795 2.619l-7.1518-4.144 3.5834-2.062a3.9877 3.9877 0 0 1 4.21.594zm2.0326 6.867a3.9877 3.9877 0 0 1-1.5067 3.12 3.9686 3.9686 0 0 1-3.325.8795v-8.2818l3.5833 2.0667a4.0044 4.0044 0 0 1 1.2484 2.2156zm-10.5186 1.439v-4.133l-3.5834-2.066L8.1432 10v4.133L11.7266 16.2z" />
        </svg>
      )
    case 'anthropic':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12.923 7h-1.846L3.5 21h2.5l1.9-4h8.2l1.9 4h2.5L12.923 7zm-3.1 9.5l2.177-4.58 2.177 4.58h-4.354z" />
        </svg>
      )
    case 'antigravity':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <circle cx="12" cy="12" r="3" />
          <path fillRule="evenodd" clipRule="evenodd" d="M12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5ZM12 4.5C7.85786 4.5 4.5 7.85786 4.5 12C4.5 16.1421 7.85786 19.5 12 19.5C16.1421 19.5 19.5 16.1421 19.5 12C19.5 7.85786 16.1421 4.5 12 4.5Z" />
        </svg>
      )
    case 'gemini-cli':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 2C12 7.523 16.477 12 22 12C16.477 12 12 16.477 12 22C12 16.477 7.523 12 2 12C7.523 12 12 7.523 12 2Z" />
        </svg>
      )
    case 'kimi':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M20.25 13.51A9 9 0 1 1 10.49 3.75 7.5 7.5 0 0 0 20.25 13.51z" />
        </svg>
      )
    case 'qwen':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="11" cy="11" r="8" />
          <path d="M16.5 16.5L21 21" />
        </svg>
      )
    default:
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <path d="M12 8v8" />
          <path d="M8 12h8" />
        </svg>
      )
  }
}

export interface OAuthPanelProps {
  canManage: boolean
  cpaRunning: boolean
  onNotify: (message: string) => void
  onError: (message: string | null) => void
  visibleProviders?: OAuthProvider[]
  embeddedMode?: boolean
  showExtendedTools?: boolean
}

export function OAuthPanel({
  canManage,
  cpaRunning,
  onNotify,
  onError,
  visibleProviders,
  embeddedMode = false,
  showExtendedTools = true
}: OAuthPanelProps) {
  const [states, setStates] = useState<Record<OAuthProvider, ProviderState>>({} as Record<OAuthProvider, ProviderState>)
  const [showJiegehaoManager, setShowJiegehaoManager] = useState(false)
  const [iflowCookie, setIflowCookie] = useState<{
    cookie: string
    loading: boolean
    result?: IFlowCookieAuthResponse
    error?: string
    warning?: boolean
  }>({ cookie: '', loading: false })
  const [vertexState, setVertexState] = useState<VertexImportState>({
    fileName: '',
    location: '',
    loading: false
  })
  const vertexFileInputRef = useRef<HTMLInputElement | null>(null)
  const timersRef = useRef<Record<string, number>>({})

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((timer) => window.clearInterval(timer))
      timersRef.current = {}
    }
  }, [])

  const unavailableHint = useMemo(
    () => (!cpaRunning ? '请先启动 CPA，再进行 OAuth 或凭证导入。' : null),
    [cpaRunning]
  )

  const filteredProviders = useMemo(() => {
    if (!visibleProviders || visibleProviders.length === 0) {
      return PROVIDERS
    }
    const allowed = new Set(visibleProviders)
    return PROVIDERS.filter((provider) => allowed.has(provider.id))
  }, [visibleProviders])

  const updateProviderState = (provider: OAuthProvider, next: Partial<ProviderState>) => {
    setStates((current) => ({
      ...current,
      [provider]: { ...(current[provider] ?? {}), ...next }
    }))
  }

  const startPolling = (provider: OAuthProvider, state: string) => {
    if (timersRef.current[provider]) {
      window.clearInterval(timersRef.current[provider])
    }

    const timer = window.setInterval(async () => {
      try {
        const result = await oauthApi.getAuthStatus(state)
        if (result.status === 'ok') {
          updateProviderState(provider, { status: 'success', polling: false })
          window.clearInterval(timer)
          delete timersRef.current[provider]
          onNotify(`${provider} 授权成功`)
          return
        }
        if (result.status === 'error') {
          updateProviderState(provider, {
            status: 'error',
            error: result.error,
            polling: false
          })
          window.clearInterval(timer)
          delete timersRef.current[provider]
        }
      } catch (error) {
        updateProviderState(provider, {
          status: 'error',
          error: getErrorMessage(error),
          polling: false
        })
        window.clearInterval(timer)
        delete timersRef.current[provider]
      }
    }, 3000)

    timersRef.current[provider] = timer
  }

  const handleStartAuth = async (provider: ProviderDefinition) => {
    if (!cpaRunning) {
      onError(unavailableHint)
      return
    }

    const projectId = provider.projectIdSupported
      ? (states[provider.id]?.projectId || '').trim() || undefined
      : undefined

    updateProviderState(provider.id, {
      status: 'waiting',
      polling: true,
      error: undefined,
      callbackError: undefined,
      callbackStatus: undefined
    })

    try {
      const result = await oauthApi.startAuth(provider.id, { projectId })
      updateProviderState(provider.id, {
        url: result.url,
        state: result.state,
        status: 'waiting',
        polling: Boolean(result.state)
      })

      await cpaRuntime.openExternalTarget(result.url)
      onNotify(`${provider.name} 授权链接已打开`)

      if (result.state) {
        startPolling(provider.id, result.state)
      }
    } catch (error) {
      updateProviderState(provider.id, {
        status: 'error',
        error: getErrorMessage(error),
        polling: false
      })
    }
  }

  const handleCopy = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text)
    onNotify(message)
  }

  const handleSubmitCallback = async (provider: ProviderDefinition) => {
    const redirectUrl = (states[provider.id]?.callbackUrl || '').trim()
    if (!redirectUrl) {
      onError('请先粘贴回调后的完整 URL。')
      return
    }

    updateProviderState(provider.id, {
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined
    })

    try {
      await oauthApi.submitCallback(provider.id, redirectUrl)
      updateProviderState(provider.id, {
        callbackSubmitting: false,
        callbackStatus: 'success'
      })
      onNotify(`${provider.name} 回调已提交`)
    } catch (error) {
      updateProviderState(provider.id, {
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: getErrorMessage(error)
      })
    }
  }

  const handleSubmitIflowCookie = async () => {
    if (!cpaRunning) {
      onError(unavailableHint)
      return
    }

    const cookie = iflowCookie.cookie.trim()
    if (!cookie) {
      onError('请先填写 iFlow Cookie。')
      return
    }

    setIflowCookie((current) => ({
      ...current,
      loading: true,
      error: undefined,
      warning: false,
      result: undefined
    }))

    try {
      const result = await oauthApi.iflowCookieAuth(cookie)
      if (result.status === 'ok') {
        setIflowCookie((current) => ({ ...current, loading: false, result }))
        onNotify('iFlow Cookie 已成功导入')
        return
      }

      setIflowCookie((current) => ({
        ...current,
        loading: false,
        error: result.error || '导入失败'
      }))
    } catch (error) {
      const message = getErrorMessage(error)
      const warning = message.includes('409')
      setIflowCookie((current) => ({
        ...current,
        loading: false,
        error: warning ? '检测到重复配置，请确认是否已导入。' : message,
        warning
      }))
    }
  }

  const handleVertexImport = async () => {
    if (!cpaRunning) {
      onError(unavailableHint)
      return
    }

    if (!vertexState.file) {
      onError('请先选择 Vertex 服务账号 JSON 文件。')
      return
    }

    setVertexState((current) => ({
      ...current,
      loading: true,
      error: undefined,
      result: undefined
    }))

    try {
      const result = await oauthApi.importVertexCredential(
        vertexState.file,
        vertexState.location.trim() || undefined
      )

      setVertexState((current) => ({
        ...current,
        loading: false,
        result: {
          projectId: result.project_id,
          email: result.email,
          location: result.location,
          authFile: result.auth_file ?? result['auth-file']
        }
      }))
      onNotify('Vertex 凭证已导入')
    } catch (error) {
      setVertexState((current) => ({
        ...current,
        loading: false,
        error: getErrorMessage(error)
      }))
    }
  }

  return (
    <div className={`${embeddedMode ? 'mt-0 flex flex-col gap-3' : 'mt-4 flex flex-col gap-6'}`}>
      {!embeddedMode ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black">OAuth 工作台</h2>
            <p className="text-sm text-base-content/60">
              复用 CPA 现有 OAuth 接口，但界面独立于 CPM。当前 {canManage ? 'admin' : '普通用户'} 可见。
            </p>
          </div>
          <div className={`badge badge-lg ${cpaRunning ? 'badge-success' : 'badge-warning'}`}>
            {cpaRunning ? 'CPA 已就绪' : '等待启动 CPA'}
          </div>
        </div>
      ) : null}

      {!cpaRunning && (
        <div className="alert alert-warning">
          <span>{unavailableHint}</span>
        </div>
      )}

      <div className={`grid gap-3 ${embeddedMode ? 'grid-cols-1' : 'xl:grid-cols-2'}`}>
        {filteredProviders.map((provider) => {
          const state = states[provider.id] || {}

          return (
            <div
              key={provider.id}
              className={embeddedMode ? 'rounded-[20px] border border-base-300 bg-base-100 shadow-sm' : 'card border border-base-300 bg-base-100 shadow-sm'}
            >
              <div className={`${embeddedMode ? 'p-3' : 'card-body gap-4'}`}>
                <div className={`flex ${embeddedMode ? 'items-center justify-between gap-3' : 'items-start justify-between gap-4'}`}>
                  <div className={`flex items-center ${embeddedMode ? 'gap-3 min-w-0' : 'gap-4'}`}>
                    <div className={`${embeddedMode ? 'h-10 w-10 rounded-xl' : 'h-14 w-14 rounded-2xl'} bg-gradient-to-br ${provider.accent} flex shrink-0 items-center justify-center shadow-md`}>
                      <ProviderIcon id={provider.id} className="w-8 h-8 text-white" />
                    </div>
                    <div className="min-w-0">
                      <h3 className={`${embeddedMode ? 'truncate text-base font-bold' : 'card-title'}`}>{provider.name}</h3>
                      <p className={`${embeddedMode ? 'mt-0.5 text-xs text-base-content/60' : 'text-sm text-base-content/60'}`}>{provider.subtitle}</p>
                    </div>
                  </div>
                  <div className={`flex items-center ${embeddedMode ? 'gap-1.5' : 'gap-2'} shrink-0`}>
                    {provider.id === 'codex' && canManage && (
                      <button
                        className="btn btn-xs btn-outline"
                        title="借个号批量自动登录"
                        onClick={() => setShowJiegehaoManager(true)}
                      >
                        借个号批量登录
                      </button>
                    )}
                    <div className={`badge ${getStatusBadgeClass(state.status)}`}>{getStatusText(state)}</div>
                  </div>
                </div>

                {provider.projectIdSupported && (
                  <fieldset className={`fieldset ${embeddedMode ? 'mt-3' : ''}`}>
                    <legend className="fieldset-legend text-xs font-medium">Gemini Project ID</legend>
                    <input
                      type="text"
                      className={`input input-bordered w-full ${embeddedMode ? 'input-sm rounded-xl' : ''}`}
                      placeholder="留空自动选择，或填写 ALL"
                      value={state.projectId || ''}
                      disabled={state.polling}
                      onChange={(event) =>
                        updateProviderState(provider.id, {
                          projectId: event.target.value
                        })
                      }
                    />
                  </fieldset>
                )}

                <div className={`flex flex-wrap ${embeddedMode ? 'mt-3 gap-2' : 'gap-2'}`}>
                  <button
                    className={`btn btn-primary btn-sm ${embeddedMode ? 'flex-1 rounded-xl' : ''}`}
                    disabled={!cpaRunning || state.polling}
                    onClick={() => void handleStartAuth(provider)}
                  >
                    {state.polling && <span className="loading loading-spinner loading-xs"></span>}
                    发起授权
                  </button>
                  <button
                    className={`btn btn-outline btn-sm ${embeddedMode ? 'rounded-xl' : ''}`}
                    disabled={!state.url}
                    onClick={() => state.url && void handleCopy(state.url, `${provider.name} 链接已复制`)}
                  >
                    复制链接
                  </button>
                  <button
                    className={`btn btn-outline btn-sm ${embeddedMode ? 'rounded-xl' : ''}`}
                    disabled={!state.url}
                    onClick={() => state.url && void openExternalHref(state.url)}
                  >
                    打开浏览器
                  </button>
                </div>

                {state.url && (
                  <div className={`rounded-box border border-base-300 bg-base-200/60 ${embeddedMode ? 'mt-3 p-2.5' : 'p-3'}`}>
                    <div className="text-xs uppercase tracking-[0.2em] text-base-content/50">Auth URL</div>
                    <div className="mt-2 break-all font-mono text-xs">{state.url}</div>
                  </div>
                )}

                {provider.callbackSupported && (
                  <div className={`rounded-box border border-dashed border-base-300 ${embeddedMode ? 'mt-3 p-3' : 'p-4'}`}>
                    <div className="mb-2 text-sm font-semibold">回调补提交通道</div>
                    <p className="mb-3 text-xs leading-5 text-base-content/60">
                      某些浏览器流程回跳不到本地时，把完整回调 URL 粘贴到这里。
                    </p>
                    <div className="flex flex-col gap-3">
                      <input
                        type="text"
                        className={`input input-bordered w-full ${embeddedMode ? 'input-sm rounded-xl' : ''}`}
                        placeholder="https://callback?...code=...&state=..."
                        value={state.callbackUrl || ''}
                        onChange={(event) =>
                          updateProviderState(provider.id, {
                            callbackUrl: event.target.value,
                            callbackStatus: undefined,
                            callbackError: undefined
                          })
                        }
                      />
                      <button
                        className={`btn btn-secondary ${embeddedMode ? 'btn-sm rounded-xl' : ''}`}
                        disabled={!cpaRunning || state.callbackSubmitting}
                        onClick={() => void handleSubmitCallback(provider)}
                      >
                        {state.callbackSubmitting && <span className="loading loading-spinner loading-xs"></span>}
                        提交回调
                      </button>
                    </div>
                    {state.callbackStatus === 'success' && (
                      <div className="mt-3 alert alert-success py-2">
                        <span>回调已提交，等待状态轮询完成。</span>
                      </div>
                    )}
                    {state.callbackStatus === 'error' && (
                      <div className="mt-3 alert alert-error py-2">
                        <span>{state.callbackError || '回调提交失败'}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {showExtendedTools ? (
      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="card-title">Vertex JSON 导入</h3>
                <p className="text-sm text-base-content/60">导入 Google Vertex 服务账号 JSON，自动生成认证文件。</p>
              </div>
              <button
                className="btn btn-primary btn-sm"
                disabled={!cpaRunning || vertexState.loading}
                onClick={() => void handleVertexImport()}
              >
                {vertexState.loading && <span className="loading loading-spinner loading-xs"></span>}
                导入 Vertex
              </button>
            </div>

            <fieldset className="fieldset">
              <legend className="fieldset-legend text-sm font-medium">Location</legend>
              <input
                type="text"
                className="input w-full"
                placeholder="例如 us-central1，留空默认"
                value={vertexState.location}
                onChange={(event) =>
                  setVertexState((current) => ({
                    ...current,
                    location: event.target.value
                  }))
                }
              />
            </fieldset>

            <div className="rounded-box border border-dashed border-base-300 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-outline btn-sm" onClick={() => vertexFileInputRef.current?.click()}>
                  选择 JSON 文件
                </button>
                <span className="text-sm text-base-content/70">
                  {vertexState.fileName || '尚未选择文件'}
                </span>
              </div>
              <input
                ref={vertexFileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file) {
                    return
                  }
                  if (!file.name.toLowerCase().endsWith('.json')) {
                    onError('Vertex 只接受 .json 服务账号文件。')
                    event.target.value = ''
                    return
                  }
                  setVertexState((current) => ({
                    ...current,
                    file,
                    fileName: file.name,
                    error: undefined,
                    result: undefined
                  }))
                  event.target.value = ''
                }}
              />
            </div>

            {vertexState.error && (
              <div className="alert alert-error py-2">
                <span>{vertexState.error}</span>
              </div>
            )}

            {vertexState.result && (
              <div className="stats stats-vertical border border-base-300 shadow-sm lg:stats-horizontal">
                <div className="stat">
                  <div className="stat-title">Project</div>
                  <div className="stat-value text-lg">{vertexState.result.projectId || '-'}</div>
                </div>
                <div className="stat">
                  <div className="stat-title">Email</div>
                  <div className="stat-value text-lg">{vertexState.result.email || '-'}</div>
                </div>
                <div className="stat">
                  <div className="stat-title">Auth File</div>
                  <div className="stat-value text-lg">{vertexState.result.authFile || '-'}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="card-title">iFlow Cookie 登录</h3>
                <p className="text-sm text-base-content/60">直接贴入 Cookie，适合无法走浏览器 OAuth 的场景。</p>
              </div>
              <button
                className="btn btn-primary btn-sm"
                disabled={!cpaRunning || iflowCookie.loading}
                onClick={() => void handleSubmitIflowCookie()}
              >
                {iflowCookie.loading && <span className="loading loading-spinner loading-xs"></span>}
                提交 Cookie
              </button>
            </div>

            <textarea
              className="textarea w-full min-h-40 font-mono text-xs"
              placeholder="粘贴完整 Cookie"
              value={iflowCookie.cookie}
              onChange={(event) =>
                setIflowCookie((current) => ({
                  ...current,
                  cookie: event.target.value
                }))
              }
            />

            {iflowCookie.error && (
              <div className={`alert py-2 ${iflowCookie.warning ? 'alert-warning' : 'alert-error'}`}>
                <span>{iflowCookie.error}</span>
              </div>
            )}

            {iflowCookie.result?.status === 'ok' && (
              <div className="rounded-box border border-base-300 bg-base-200/60 p-4 text-sm">
                <div className="mb-2 font-semibold">导入结果</div>
                <div className="grid gap-2">
                  {iflowCookie.result.email && <div>邮箱：{iflowCookie.result.email}</div>}
                  {iflowCookie.result.expired && <div>过期时间：{iflowCookie.result.expired}</div>}
                  {iflowCookie.result.saved_path && <div>保存路径：{iflowCookie.result.saved_path}</div>}
                  {iflowCookie.result.type && <div>类型：{iflowCookie.result.type}</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      ) : null}

      {/* Jiegehao batch auto-login modal */}
      {showJiegehaoManager && (
        <JiegehaoManager
          onClose={() => setShowJiegehaoManager(false)}
          onCodexAuthSuccess={() => {
            onNotify('Codex 批量自动授权完成')
          }}
        />
      )}
    </div>
  )
}

async function openExternalHref(url: string) {
  await cpaRuntime.openExternalTarget(url)
}
