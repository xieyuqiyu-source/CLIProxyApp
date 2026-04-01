import { useEffect, useMemo, useState } from 'react'
import { cpaRuntime } from './lib/cpa/runtime'
import type { AppState, BootstrapSettings, CpaManagementInfo, CpaState } from './lib/cpa/types'

type LoginRole = 'admin' | 'user'
type AdminTab = 'overview' | 'cpm'
type UserTab = 'overview' | 'oauth' | 'providers' | 'quota' | 'stats'

interface LoginSession {
  username: string
  role: LoginRole
}

const SESSION_KEY = 'cpapp-login-session'
const THEME_KEY = 'cpapp-theme'
const THEMES = ['light', 'dark', 'synthwave', 'cyberpunk'] as const
type Theme = typeof THEMES[number]

const createEmptySettings = (): BootstrapSettings => ({
  apiPort: 8317,
  autoStart: true,
  binaryMode: 'development',
  explicitBinaryPath: null
})

const statusLabelMap: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '异常'
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const raw = window.localStorage.getItem(THEME_KEY)
    if (THEMES.includes(raw as Theme)) {
      return raw as Theme
    }
    return 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    window.localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const [session, setSession] = useState<LoginSession | null>(() => {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as LoginSession
    } catch {
      return null
    }
  })

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [cpaState, setCpaState] = useState<CpaState | null>(null)
  const [managementInfo, setManagementInfo] = useState<CpaManagementInfo | null>(null)
  const [recentLogs, setRecentLogs] = useState('等待运行日志...')
  const [settings, setSettings] = useState<BootstrapSettings>(createEmptySettings)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [adminTab, setAdminTab] = useState<AdminTab>('overview')
  const [userTab, setUserTab] = useState<UserTab>('overview')

  const statusTone = useMemo(() => {
    switch (cpaState?.status) {
      case 'running':
        return 'badge-success'
      case 'starting':
      case 'stopping':
        return 'badge-warning'
      case 'error':
        return 'badge-error'
      default:
        return 'badge-ghost'
    }
  }, [cpaState?.status])

  const cpmUrl = useMemo(() => {
    const apiBase = `http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}`
    const managementKey = managementInfo?.managementKey ?? ''
    const query = new URLSearchParams({
      apiBase,
      managementKey,
      target: '/cpm/index.html#/'
    })
    return `/cpm-bridge.html?${query.toString()}`
  }, [cpaState?.apiPort, managementInfo?.managementKey, settings.apiPort])

  const refresh = async () => {
    try {
      const [nextAppState, nextCpaState, nextManagementInfo, nextRecentLogs] = await Promise.all([
        cpaRuntime.getAppState(),
        cpaRuntime.getState(),
        cpaRuntime.getManagementInfo(),
        cpaRuntime.getRecentLogs(),
      ])

      setAppState(nextAppState)
      setCpaState(nextCpaState)
      setManagementInfo(nextManagementInfo)
      setRecentLogs(nextRecentLogs || '当前还没有日志。')
      setSettings(nextCpaState.bootstrap)
      setLoadError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(message)
    }
  }

  useEffect(() => {
    if (!session) return

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 3000)

    return () => window.clearInterval(timer)
  }, [session])

  const runAction = async (name: string, action: () => Promise<unknown>, successMsg?: string) => {
    try {
      setPendingAction(name)
      await action()
      await refresh()
      if (successMsg) {
        setToastMessage(successMsg)
        setTimeout(() => setToastMessage(null), 2000)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const savePort = async () => {
    const normalizedPort = Number(settings.apiPort)
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setLoadError('端口必须是 1 到 65535 之间的整数。')
      return
    }

    await runAction('save-port', async () => {
      await cpaRuntime.saveBootstrapSettings({
        ...settings,
        apiPort: normalizedPort
      })

      if (cpaState?.status === 'running') {
        await cpaRuntime.restart()
      }
    })
  }

  const submitLogin = () => {
    if (!username.trim() || !password.trim()) {
      setLoginError('请输入账号和密码。')
      return
    }

    const nextSession: LoginSession =
      username === 'admin' && password === 'admin'
        ? { username: 'admin', role: 'admin' }
        : { username: username.trim(), role: 'user' }

    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
    setSession(nextSession)
    setPassword('')
    setLoginError(null)
  }

  const logout = () => {
    window.sessionStorage.removeItem(SESSION_KEY)
    setSession(null)
    setUsername('')
    setPassword('')
    setLoginError(null)
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-base-200">
        <div className="absolute top-4 right-4 z-[1]">
          <div className="dropdown dropdown-end">
            <div tabIndex={0} role="button" className="btn m-1">
              主题 / Theme
              <svg width="12px" height="12px" className="inline-block h-2 w-2 fill-current opacity-60" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048">
                <path d="M1799 349l242 241-1017 1017L7 590l242-241 775 775 775-775z"></path>
              </svg>
            </div>
            <ul tabIndex={0} className="dropdown-content menu bg-base-200 rounded-box z-[1] w-52 p-2 shadow">
              {THEMES.map((t) => (
                <li key={t}>
                  <input
                    type="radio"
                    name="theme-dropdown"
                    className="theme-controller btn btn-sm btn-block btn-ghost justify-start"
                    aria-label={t}
                    value={t}
                    checked={theme === t}
                    onChange={() => setTheme(t)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="hero min-h-screen">
          <div className="hero-content flex-col lg:flex-row-reverse gap-10 lg:gap-20">
            <div className="text-center lg:text-left max-w-lg">
              <h1 className="text-5xl font-bold">CLIProxyApp</h1>
              <p className="py-6">
                统一入口已重构。管理员使用 admin 凭据进入 CPM，或使用任意其他账号进入专属的业务面板。完全按照 DaisyUI 原生规范实现。
              </p>
              <div className="stats shadow bg-base-100">
                <div className="stat text-center">
                  <div className="stat-title">管理员</div>
                  <div className="stat-value text-primary">Admin</div>
                  <div className="stat-desc">CPM 控制台</div>
                </div>
                <div className="stat text-center">
                  <div className="stat-title">普通用户</div>
                  <div className="stat-value text-secondary">Guest</div>
                  <div className="stat-desc">CPAPP 业务面</div>
                </div>
              </div>
            </div>

            <div className="card bg-base-100 w-full max-w-sm shrink-0 shadow-2xl">
              <div className="card-body">
                <h2 className="card-title text-2xl mb-4">登录</h2>

                <div className="form-control mb-4">
                  <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z" />
                    </svg>
                    <input
                      type="text"
                      className="grow"
                      placeholder="Username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitLogin()
                      }}
                    />
                  </label>
                </div>

                <div className="form-control mb-6">
                  <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                      <path fillRule="evenodd" d="M14 6a4 4 0 0 1-4.899 3.899l-1.955 1.955a.5.5 0 0 1-.353.146H5v1.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2.293a.5.5 0 0 1 .146-.353l3.955-3.955A4 4 0 1 1 14 6Zm-4-2a.75.75 0 0 0 0 1.5.5.5 0 0 1 .5.5.75.75 0 0 0 1.5 0 2 2 0 0 0-2-2Z" clipRule="evenodd" />
                    </svg>
                    <input
                      type="password"
                      className="grow"
                      placeholder="Password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitLogin()
                      }}
                    />
                  </label>
                </div>

                {loginError && (
                  <div className="alert alert-error mb-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 shrink-0 stroke-current" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span>{loginError}</span>
                  </div>
                )}

                <div className="form-control mt-2">
                  <button className="btn btn-primary w-full" onClick={submitLogin}>
                    登录
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-base-200">
      <div className="navbar border-b border-base-300 bg-base-100 px-6 shadow-sm">
        <div className="flex-1">
          <div>
            <div className="text-xs uppercase tracking-[0.3em] text-primary">CLIProxyApp</div>
            <div className="text-2xl font-black">
              {session.role === 'admin' ? 'CPM 管理入口' : 'CPAPP 业务入口'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden text-right text-xs text-base-content/50 md:block">
            <div>{appState?.appName ?? 'CLIProxyApp'}</div>
            <div>{appState?.appVersion ?? '0.1.0'}</div>
          </div>
          <div className="badge badge-outline badge-lg">
            {session.role === 'admin' ? '管理员' : '普通用户'} / {session.username}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            退出登录
          </button>
        </div>
      </div>

      {session.role === 'admin' ? (
        <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4">
          <div role="tablist" className="tabs tabs-lift">
            <button
              role="tab"
              className={`tab ${adminTab === 'overview' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('overview')}
            >
              概览
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'cpm' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('cpm')}
            >
              CPM
            </button>
          </div>

          <div className="flex flex-col gap-4 bg-base-100 p-4 rounded-box shadow-sm mt-1">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="badge badge-primary badge-outline">
                  {adminTab === 'overview' ? '桌面宿主概览' : '原始 CPM 管理页'}
                </div>
                <div className={`badge badge-lg ${statusTone}`}>
                  {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">端口</div>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    className="join-item input input-bordered input-sm w-20 px-2 font-mono text-center"
                    value={settings.apiPort}
                    onChange={(event) => {
                      setSettings((current) => ({
                        ...current,
                        apiPort: Number(event.target.value || 0)
                      }))
                    }}
                  />
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void savePort()}>
                    保存
                  </button>
                </div>

                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">密钥</div>
                  <input
                    type="text"
                    readOnly
                    className="join-item input input-bordered input-sm w-24 sm:w-32 px-2 font-mono text-xs opacity-60"
                    value={managementInfo?.managementKey ?? '等待生成...'}
                  />
                  <button
                    className="join-item btn btn-outline btn-sm font-normal"
                    disabled={!managementInfo?.managementKey}
                    onClick={() => void navigator.clipboard.writeText(managementInfo?.managementKey ?? '')}
                  >
                    复制
                  </button>
                </div>

                <div className="join shadow-sm">
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('start', () => cpaRuntime.start())}>启动</button>
                  <button className="join-item btn btn-secondary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('restart', () => cpaRuntime.restart())}>重启</button>
                  <button className="join-item btn btn-warning btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('stop', () => cpaRuntime.stop())}>停止</button>
                </div>

                <button className="btn btn-outline btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('refresh', refresh)}>刷新状态</button>
              </div>
            </div>
          </div>

          {cpaState?.lastError ? (
            <div className="alert alert-error mt-4">
              <span>最近一次运行错误：{cpaState.lastError}</span>
            </div>
          ) : null}

          {loadError ? (
            <div className="alert alert-error mt-4">
              <span>界面错误：{loadError}</span>
            </div>
          ) : null}

          {adminTab === 'overview' ? (
            <div className="flex flex-col gap-6 mt-4">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">管理密钥</div>
                    <div className="text-sm text-base-content/50">配置面板</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">AI 提供商</div>
                    <div className="text-sm text-base-content/50">G:0 C:0 Cl:0 O:0</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m11.5 15.5 3-3"/><path d="m5.5 9.5 3-3"/><path d="m15.5 11.5 3-3"/><path d="m9.5 5.5 3-3"/><path d="M21.16 3.84a2 2 0 0 0-2.83 0l-5.3 5.3a2 2 0 0 0-.58 1.41V14a2 2 0 0 1-2 2H7a2 2 0 0 0-1.41.59l-5.3 5.3a2 2 0 1 0 2.83 2.82l5.3-5.3A2 2 0 0 0 9 17v-3.5a2 2 0 0 1 2-2h3.5a2 2 0 0 0 1.41-.59l5.3-5.3a2 2 0 0 0 0-2.82Z"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">16</h2>
                    <div className="text-base font-medium mt-1">可用模型</div>
                    <div className="text-sm text-base-content/50">所有提供商的模型总数</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">2</h2>
                    <div className="text-base font-medium mt-1">认证文件</div>
                    <div className="text-sm text-base-content/50">OAuth 凭证</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4 lg:flex-row">
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">代理地址 (Proxy URL)</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-80" value={`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`} />
                      <button className="join-item btn btn-outline font-normal" onClick={() => { void navigator.clipboard.writeText(`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`); setToastMessage('代理地址已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">外部 API KEY</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-60" value={managementInfo?.managementKey ?? '等待生成...'} />
                      <button className="join-item btn btn-outline font-normal" disabled={!managementInfo?.managementKey} onClick={() => { void navigator.clipboard.writeText(managementInfo?.managementKey ?? ''); setToastMessage('API KEY 已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card bg-base-100 shadow-sm border border-base-200">
                <div className="card-body gap-4">
                  <div className="space-y-2 flex justify-between items-center">
                    <div>
                      <h3 className="card-title text-base">最近日志</h3>
                      <p className="text-sm text-base-content/60">
                        实时查看当前 CPA 守护进程的标准与错误输出
                      </p>
                    </div>
                    <button
                      className="btn btn-outline btn-sm font-normal"
                      disabled={pendingAction !== null}
                      onClick={() =>
                        void runAction('refresh-logs', async () => {
                          const logs = await cpaRuntime.getRecentLogs()
                          setRecentLogs(logs || '当前还没有日志。')
                        }, '日志刷新成功')
                      }
                    >
                      {pendingAction === 'refresh-logs' && <span className="loading loading-spinner loading-xs"></span>}
                      刷新日志
                    </button>
                  </div>

                  <div className="mockup-code w-full h-[28rem] overflow-auto shadow-inner bg-base-300/50 text-base-content/80 text-xs sm:text-sm leading-relaxed">
                    {(!recentLogs || recentLogs === '当前还没有日志。' || recentLogs === '等待运行日志...') ? (
                      <pre data-prefix=">"><code>{recentLogs || '等待运行日志...'}</code></pre>
                    ) : (
                      recentLogs.split('\n').map((line, idx) => {
                        let tagClass = 'whitespace-pre-wrap break-all '
                        const lowerLine = line.toLowerCase()
                        if (lowerLine.includes('error') || lowerLine.includes('fail') || lowerLine.includes('crit')) {
                          tagClass += 'text-error font-bold'
                        } else if (lowerLine.includes('warn')) {
                          tagClass += 'text-warning font-semibold'
                        } else if (lowerLine.includes('info') || lowerLine.includes('success')) {
                          tagClass += 'text-info'
                        } else {
                          tagClass += 'opacity-80'
                        }
                        return (
                          <pre key={idx} data-prefix={idx + 1} className={tagClass}>
                            <code>{line || ' '}</code>
                          </pre>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              {cpaState?.status !== 'running' ? (
                <div className="hero rounded-box bg-base-100 shadow-xl">
                  <div className="hero-content py-16 text-center">
                    <div className="max-w-2xl">
                      <h2 className="text-3xl font-black">先启动 CPA，才能进入原始 CPM 管理页</h2>
                      <p className="py-4 text-base-content/65">
                        当前 `CPA` 还没有处于运行中，所以先启动服务，再加载 `management.html`。
                      </p>
                      <button
                        className="btn btn-primary"
                        disabled={pendingAction !== null}
                        onClick={() => void runAction('start', () => cpaRuntime.start())}
                      >
                        立即启动 CPA
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="card bg-base-100 shadow-xl">
                  <div className="card-body p-2">
                    <iframe
                      key={cpmUrl}
                      src={cpmUrl}
                      title="CPM 管理页面"
                      className="h-[calc(100vh-17rem)] w-full rounded-box border border-base-300 bg-base-100"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      ) : (
        <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4">
          <div role="tablist" className="tabs tabs-lift">
            <button
              role="tab"
              className={`tab ${userTab === 'overview' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('overview')}
            >
              概览
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'oauth' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('oauth')}
            >
              OAuth 登录
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'providers' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('providers')}
            >
              AI 提供商
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'quota' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('quota')}
            >
              配额管理
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'stats' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('stats')}
            >
              使用统计
            </button>
          </div>

          {/* Top Control Bar is shared across roles! */}
          <div className="flex flex-col gap-4 bg-base-100 p-4 rounded-box shadow-sm mt-1">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="badge badge-primary badge-outline">
                  {userTab === 'overview' ? '普通系统概览' : '用户模块'}
                </div>
                <div className={`badge badge-lg ${statusTone}`}>
                  {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">端口</div>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    className="join-item input input-bordered input-sm w-20 px-2 font-mono text-center"
                    value={settings.apiPort}
                    onChange={(event) => {
                      setSettings((current) => ({
                        ...current,
                        apiPort: Number(event.target.value || 0)
                      }))
                    }}
                  />
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void savePort()}>
                    保存
                  </button>
                </div>

                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">密钥</div>
                  <input
                    type="text"
                    readOnly
                    className="join-item input input-bordered input-sm w-24 sm:w-32 px-2 font-mono text-xs opacity-60"
                    value={managementInfo?.managementKey ?? '等待生成...'}
                  />
                  <button
                    className="join-item btn btn-outline btn-sm font-normal"
                    disabled={!managementInfo?.managementKey}
                    onClick={() => { void navigator.clipboard.writeText(managementInfo?.managementKey ?? ''); setToastMessage('密钥已复制'); setTimeout(() => setToastMessage(null), 2000) }}
                  >
                    复制
                  </button>
                </div>

                <div className="join shadow-sm">
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('start', () => cpaRuntime.start(), '启动指令已发送')}>启动</button>
                  <button className="join-item btn btn-secondary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('restart', () => cpaRuntime.restart(), '重启指令已发送')}>重启</button>
                  <button className="join-item btn btn-warning btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('stop', () => cpaRuntime.stop(), '停止指令已发送')}>停止</button>
                </div>

                <button className="btn btn-outline btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('refresh', refresh, '状态刷新完毕')}>
                  {pendingAction === 'refresh' && <span className="loading loading-spinner loading-xs"></span>}
                  刷新状态
                </button>
              </div>
            </div>
          </div>

          {cpaState?.lastError ? (
            <div className="alert alert-error mt-4">
              <span>最近一次运行错误：{cpaState.lastError}</span>
            </div>
          ) : null}

          {loadError ? (
            <div className="alert alert-error mt-4">
              <span>界面错误：{loadError}</span>
            </div>
          ) : null}

          {userTab === 'overview' && (
            <div className="flex flex-col gap-6 mt-4">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">管理密钥</div>
                    <div className="text-sm text-base-content/50">配置面板</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">AI 提供商</div>
                    <div className="text-sm text-base-content/50">G:0 C:0 Cl:0 O:0</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m11.5 15.5 3-3"/><path d="m5.5 9.5 3-3"/><path d="m15.5 11.5 3-3"/><path d="m9.5 5.5 3-3"/><path d="M21.16 3.84a2 2 0 0 0-2.83 0l-5.3 5.3a2 2 0 0 0-.58 1.41V14a2 2 0 0 1-2 2H7a2 2 0 0 0-1.41.59l-5.3 5.3a2 2 0 1 0 2.83 2.82l5.3-5.3A2 2 0 0 0 9 17v-3.5a2 2 0 0 1 2-2h3.5a2 2 0 0 0 1.41-.59l5.3-5.3a2 2 0 0 0 0-2.82Z"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">16</h2>
                    <div className="text-base font-medium mt-1">可用模型</div>
                    <div className="text-sm text-base-content/50">所有提供商的模型总数</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">2</h2>
                    <div className="text-base font-medium mt-1">认证文件</div>
                    <div className="text-sm text-base-content/50">OAuth 凭证</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4 lg:flex-row">
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">代理地址 (Proxy URL)</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-80" value={`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`} />
                      <button className="join-item btn btn-outline font-normal" onClick={() => { void navigator.clipboard.writeText(`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`); setToastMessage('代理地址已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">外部 API KEY</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-60" value={managementInfo?.managementKey ?? '等待生成...'} />
                      <button className="join-item btn btn-outline font-normal" disabled={!managementInfo?.managementKey} onClick={() => { void navigator.clipboard.writeText(managementInfo?.managementKey ?? ''); setToastMessage('API KEY 已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card bg-base-100 shadow-sm border border-base-200">
                <div className="card-body gap-4">
                  <div className="space-y-2 flex justify-between items-center">
                    <div>
                      <h3 className="card-title text-base">最近日志</h3>
                      <p className="text-sm text-base-content/60">
                        实时查看当前 CPA 守护进程的标准与错误输出
                      </p>
                    </div>
                    <button
                      className="btn btn-outline btn-sm font-normal"
                      disabled={pendingAction !== null}
                      onClick={() =>
                        void runAction('refresh-logs', async () => {
                          const logs = await cpaRuntime.getRecentLogs()
                          setRecentLogs(logs || '当前还没有日志。')
                        }, '日志刷新成功')
                      }
                    >
                      {pendingAction === 'refresh-logs' && <span className="loading loading-spinner loading-xs"></span>}
                      刷新日志
                    </button>
                  </div>

                  <div className="mockup-code w-full h-[28rem] overflow-auto shadow-inner bg-base-300/50 text-base-content/80 text-xs sm:text-sm leading-relaxed">
                    {(!recentLogs || recentLogs === '当前还没有日志。' || recentLogs === '等待运行日志...') ? (
                      <pre data-prefix=">"><code>{recentLogs || '等待运行日志...'}</code></pre>
                    ) : (
                      recentLogs.split('\n').map((line, idx) => {
                        let tagClass = 'whitespace-pre-wrap break-all '
                        const lowerLine = line.toLowerCase()
                        if (lowerLine.includes('error') || lowerLine.includes('fail') || lowerLine.includes('crit')) {
                          tagClass += 'text-error font-bold'
                        } else if (lowerLine.includes('warn')) {
                          tagClass += 'text-warning font-semibold'
                        } else if (lowerLine.includes('info') || lowerLine.includes('success')) {
                          tagClass += 'text-info'
                        } else {
                          tagClass += 'opacity-80'
                        }
                        return (
                          <pre key={idx} data-prefix={idx + 1} className={tagClass}>
                            <code>{line || ' '}</code>
                          </pre>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {userTab === 'oauth' && (
            <div className="hero rounded-box bg-base-100 shadow-sm py-28 mt-1 border border-dashed border-base-300">
              <div className="hero-content text-center">
                <div className="max-w-md">
                  <h2 className="text-3xl font-black opacity-40">OAuth 登录配置</h2>
                  <p className="py-4 text-base-content/50">模块开发中：未来提供社交账号与企业 SSO 整合接入能力</p>
                </div>
              </div>
            </div>
          )}

          {userTab === 'providers' && (
            <div className="hero rounded-box bg-base-100 shadow-sm py-28 mt-1 border border-dashed border-base-300">
              <div className="hero-content text-center">
                <div className="max-w-md">
                  <h2 className="text-3xl font-black opacity-40">AI 提供商管理</h2>
                  <p className="py-4 text-base-content/50">模块开发中：汇聚并配置多源或自建的模型端点</p>
                </div>
              </div>
            </div>
          )}

          {userTab === 'quota' && (
            <div className="hero rounded-box bg-base-100 shadow-sm py-28 mt-1 border border-dashed border-base-300">
              <div className="hero-content text-center">
                <div className="max-w-md">
                  <h2 className="text-3xl font-black opacity-40">配额管理</h2>
                  <p className="py-4 text-base-content/50">模块开发中：精确分析成本、设置并发限制、管控与告警策略</p>
                </div>
              </div>
            </div>
          )}

          {userTab === 'stats' && (
            <div className="hero rounded-box bg-base-100 shadow-sm py-28 mt-1 border border-dashed border-base-300">
              <div className="hero-content text-center">
                <div className="max-w-md">
                  <h2 className="text-3xl font-black opacity-40">使用统计</h2>
                  <p className="py-4 text-base-content/50">模块开发中：聚合呈现分时账单与实时调用流水图表</p>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* GLOBAL TOAST HANDLER */}
      {toastMessage && (
        <div className="toast toast-top toast-center z-[100]">
          <div className="alert alert-success shadow-lg">
            <span>{toastMessage}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
