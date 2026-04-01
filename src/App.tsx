import { useEffect, useMemo, useState } from 'react'
import { cpaRuntime } from './lib/cpa/runtime'
import type { AppState, BootstrapSettings, CpaManagementInfo, CpaState, RuntimePaths } from './lib/cpa/types'

type LoginRole = 'admin' | 'user'
type AdminTab = 'overview' | 'cpm'

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
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null)
  const [recentLogs, setRecentLogs] = useState('等待运行日志...')
  const [settings, setSettings] = useState<BootstrapSettings>(createEmptySettings)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adminTab, setAdminTab] = useState<AdminTab>('overview')

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
    return `http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/management.html`
  }, [cpaState?.apiPort, settings.apiPort])

  const refresh = async () => {
    try {
      const [nextAppState, nextCpaState, nextManagementInfo, nextRuntimePaths, nextRecentLogs] = await Promise.all([
        cpaRuntime.getAppState(),
        cpaRuntime.getState(),
        cpaRuntime.getManagementInfo(),
        cpaRuntime.getRuntimePaths(),
        cpaRuntime.getRecentLogs(),
      ])

      setAppState(nextAppState)
      setCpaState(nextCpaState)
      setManagementInfo(nextManagementInfo)
      setRuntimePaths(nextRuntimePaths)
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

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    try {
      setPendingAction(name)
      await action()
      await refresh()
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
          <div role="tablist" className="tabs tabs-box bg-base-100 shadow-sm w-fit">
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

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="badge badge-primary badge-outline">
                {adminTab === 'overview' ? '桌面宿主概览' : '原始 CPM 管理页'}
              </div>
              <div className={`badge badge-lg ${statusTone}`}>
                {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
              </div>
              <div className="text-sm text-base-content/60">端口 {cpaState?.apiPort ?? settings.apiPort ?? 8317}</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary btn-sm"
                disabled={pendingAction !== null}
                onClick={() => void runAction('start', () => cpaRuntime.start())}
              >
                启动 CPA
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={pendingAction !== null}
                onClick={() => void runAction('restart', () => cpaRuntime.restart())}
              >
                重启 CPA
              </button>
              <button
                className="btn btn-warning btn-sm"
                disabled={pendingAction !== null}
                onClick={() => void runAction('stop', () => cpaRuntime.stop())}
              >
                停止 CPA
              </button>
              <button
                className="btn btn-outline btn-sm"
                disabled={pendingAction !== null}
                onClick={() => void runAction('refresh', refresh)}
              >
                刷新状态
              </button>
              <a className="btn btn-outline btn-sm" href={cpmUrl} target="_blank" rel="noreferrer">
                新窗口打开 CPM
              </a>
            </div>
          </div>

          {cpaState?.lastError ? (
            <div className="alert alert-error">
              <span>最近一次运行错误：{cpaState.lastError}</span>
            </div>
          ) : null}

          {loadError ? (
            <div className="alert alert-error">
              <span>界面错误：{loadError}</span>
            </div>
          ) : null}

          {adminTab === 'overview' ? (
            <>
              <div className="stats stats-vertical gap-4 bg-transparent shadow-none lg:stats-horizontal">
                <div className="stat rounded-box bg-base-100 shadow-sm">
                  <div className="stat-title">运行状态</div>
                  <div className="stat-value text-2xl">
                    {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                  </div>
                  <div className="stat-desc">PID {cpaState?.pid ?? '-'}</div>
                </div>
                <div className="stat rounded-box bg-base-100 shadow-sm">
                  <div className="stat-title">当前端口</div>
                  <div className="stat-value text-2xl">{cpaState?.apiPort ?? settings.apiPort ?? 8317}</div>
                  <div className="stat-desc">{cpaState?.runtimeModeLabel ?? '开发模式'}</div>
                </div>
                <div className="stat rounded-box bg-base-100 shadow-sm">
                  <div className="stat-title">浏览器入口</div>
                  <div className="stat-value text-lg">management.html</div>
                  <div className="stat-desc truncate">{cpmUrl}</div>
                </div>
                <div className="stat rounded-box bg-base-100 shadow-sm">
                  <div className="stat-title">配置文件</div>
                  <div className="stat-value text-lg">config.yaml</div>
                  <div className="stat-desc truncate">{cpaState?.configPath ?? '-'}</div>
                </div>
              </div>

              <div className="card bg-base-100 shadow-sm">
                <div className="card-body gap-4 md:flex-row md:items-end md:justify-between">
                  <div className="space-y-2">
                    <h3 className="card-title text-base">本地监听端口</h3>
                    <p className="text-sm text-base-content/60">
                      这里改的是 CPA 本地服务端口。保存后如果服务正在运行，会自动重启并切到新端口。
                    </p>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <label className="form-control w-40">
                      <div className="label pb-1">
                        <span className="label-text">CPA 端口</span>
                      </div>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        className="input input-bordered"
                        value={settings.apiPort}
                        onChange={(event) => {
                          setSettings((current) => ({
                            ...current,
                            apiPort: Number(event.target.value || 0)
                          }))
                        }}
                      />
                    </label>

                    <button
                      className="btn btn-primary"
                      disabled={pendingAction !== null}
                      onClick={() => void savePort()}
                    >
                      保存端口
                    </button>
                  </div>
                </div>
              </div>

              <div className="card bg-base-100 shadow-sm">
                <div className="card-body gap-4">
                  <div className="space-y-2">
                    <h3 className="card-title text-base">管理密钥</h3>
                    <p className="text-sm text-base-content/60">
                      这里显示的是当前 CPM 登录要用的管理密钥。你可以复制后手动粘贴到原始 CPM 登录页。
                    </p>
                  </div>

                  <label className="form-control">
                    <textarea
                      className="textarea textarea-bordered h-24 font-mono text-xs"
                      readOnly
                      value={managementInfo?.managementKey ?? ''}
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={!managementInfo?.managementKey}
                      onClick={() => {
                        void navigator.clipboard.writeText(managementInfo?.managementKey ?? '')
                      }}
                    >
                      复制管理密钥
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => setAdminTab('cpm')}
                    >
                      进入 CPM
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="card bg-base-100 shadow-sm">
                  <div className="card-body gap-4">
                    <div className="space-y-2">
                      <h3 className="card-title text-base">运行路径</h3>
                      <p className="text-sm text-base-content/60">
                        这里是当前桌面宿主为 CPA 管理的配置目录、日志目录和运行文件位置。
                      </p>
                    </div>

                    <div className="space-y-3 text-sm">
                      <div>
                        <div className="font-semibold">运行目录</div>
                        <div className="font-mono text-xs text-base-content/70 break-all">
                          {runtimePaths?.runtimeDir ?? '-'}
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold">配置目录</div>
                        <div className="font-mono text-xs text-base-content/70 break-all">
                          {runtimePaths?.configDir ?? '-'}
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold">日志目录</div>
                        <div className="font-mono text-xs text-base-content/70 break-all">
                          {runtimePaths?.logsDir ?? '-'}
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold">标准输出日志</div>
                        <div className="font-mono text-xs text-base-content/70 break-all">
                          {runtimePaths?.stdoutLogPath ?? '-'}
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold">错误日志</div>
                        <div className="font-mono text-xs text-base-content/70 break-all">
                          {runtimePaths?.stderrLogPath ?? '-'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          void cpaRuntime.openConfigDir()
                        }}
                      >
                        打开配置目录
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          void cpaRuntime.openLogsDir()
                        }}
                      >
                        打开日志目录
                      </button>
                    </div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm">
                  <div className="card-body gap-4">
                    <div className="space-y-2">
                      <h3 className="card-title text-base">最近日志</h3>
                      <p className="text-sm text-base-content/60">
                        展示当前 CPA 进程最近的标准输出和错误输出，方便快速排查。
                      </p>
                    </div>

                    <pre className="max-h-[28rem] overflow-auto rounded-box bg-base-200 p-4 text-xs leading-6 text-base-content/80 whitespace-pre-wrap break-all">
                      {recentLogs}
                    </pre>

                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-outline btn-sm"
                        disabled={pendingAction !== null}
                        onClick={() =>
                          void runAction('refresh-logs', async () => {
                            const logs = await cpaRuntime.getRecentLogs()
                            setRecentLogs(logs || '当前还没有日志。')
                          })
                        }
                      >
                        刷新日志
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
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
              ) : cpaState.browserManagementDisabled ? (
                <div className="hero rounded-box bg-base-100 shadow-xl">
                  <div className="hero-content py-16 text-center">
                    <div className="max-w-2xl">
                      <h2 className="text-3xl font-black">当前模式已关闭浏览器管理入口</h2>
                      <p className="py-4 text-base-content/65">
                        这个入口只在本地开发阶段可直接加载原始 CPM 页面。当前运行模式下浏览器入口被关闭了。
                      </p>
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
                      className="h-[calc(100vh-11rem)] w-full rounded-box border border-base-300 bg-base-100"
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      ) : (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
          <div className="hero rounded-box bg-base-100 shadow-xl">
            <div className="hero-content max-w-4xl flex-col items-start py-14">
              <div className="badge badge-secondary badge-outline">CPAPP 业务入口</div>
              <h2 className="text-4xl font-black">普通账号已进入 CPAPP 页面</h2>
              <p className="max-w-2xl text-base-content/65">
                这里是你后面要逐步开发的 `CPAPP` 正式业务界面。登录分流已经固定好，后续你只需要继续告诉我布局和页面，我会严格按 daisyUI 实现。
              </p>
              <div className="stats stats-vertical shadow md:stats-horizontal">
                <div className="stat">
                  <div className="stat-title">当前账号</div>
                  <div className="stat-value text-secondary text-2xl">{session.username}</div>
                  <div className="stat-desc">非管理员账号</div>
                </div>
                <div className="stat">
                  <div className="stat-title">入口限制</div>
                  <div className="stat-value text-primary text-2xl">已启用</div>
                  <div className="stat-desc">管理员和普通用户已分流</div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h3 className="card-title">当前阶段</h3>
                <ul className="steps steps-vertical">
                  <li className="step step-primary">统一登录页</li>
                  <li className="step step-primary">CPM / CPAPP 入口分流</li>
                  <li className="step">你逐页指定布局</li>
                  <li className="step">我按 daisyUI 实现正式页面</li>
                </ul>
              </div>
            </div>

            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h3 className="card-title">当前占位说明</h3>
                <p className="text-base-content/65">
                  这一页现在只是占位壳，不会显示 CPM 管理能力。你后面告诉我首页、导航、模块卡片、表单或业务流程，我直接在这个入口继续做。
                </p>
                <div className="card-actions justify-end">
                  <button className="btn btn-secondary btn-disabled">等待下一步页面指令</button>
                </div>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  )
}

export default App
