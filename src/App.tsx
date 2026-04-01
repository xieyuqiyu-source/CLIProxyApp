import { useEffect, useMemo, useState } from 'react'
import { cpaRuntime } from './lib/cpa/runtime'
import type { AppState, BootstrapSettings, CpaState, RuntimePaths } from './lib/cpa/types'

type LoginRole = 'admin' | 'user'

interface LoginSession {
  username: string
  role: LoginRole
}

const SESSION_KEY = 'cpapp-login-session'

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
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null)
  const [cpaState, setCpaState] = useState<CpaState | null>(null)
  const [logs, setLogs] = useState('等待运行日志...')
  const [settings, setSettings] = useState<BootstrapSettings>(createEmptySettings)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

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

  const refresh = async () => {
    try {
      const [nextAppState, nextRuntimePaths, nextCpaState, nextLogs] = await Promise.all([
        cpaRuntime.getAppState(),
        cpaRuntime.getRuntimePaths(),
        cpaRuntime.getState(),
        cpaRuntime.getRecentLogs()
      ])

      setAppState(nextAppState)
      setRuntimePaths(nextRuntimePaths)
      setCpaState(nextCpaState)
      setSettings(nextCpaState.bootstrap)
      setLogs(nextLogs || '当前还没有日志。')
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

  const saveSettings = async () => {
    await runAction('save', async () => {
      await cpaRuntime.saveBootstrapSettings(settings)
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
        <div className="hero min-h-screen">
          <div className="hero-content w-full max-w-6xl flex-col gap-10 lg:flex-row lg:items-stretch">
            <div className="max-w-xl">
              <div className="badge badge-primary badge-outline mb-4">CLIProxyApp 登录入口</div>
              <h1 className="text-5xl font-black leading-tight">统一登录后再分流到 CPM 或 CPAPP</h1>
              <p className="py-6 text-base-content/70">
                当前版本先把入口限制固定下来。`admin / admin` 进入 CPM 管理入口，其他任意非空账号进入 CPAPP
                业务入口。后续页面开发将严格遵守 daisyUI。
              </p>
              <div className="stats stats-vertical shadow lg:stats-horizontal">
                <div className="stat">
                  <div className="stat-title">管理员入口</div>
                  <div className="stat-value text-primary">CPM</div>
                  <div className="stat-desc">admin / admin</div>
                </div>
                <div className="stat">
                  <div className="stat-title">普通入口</div>
                  <div className="stat-value text-secondary">CPAPP</div>
                  <div className="stat-desc">其他非空账号</div>
                </div>
              </div>
            </div>

            <div className="card w-full max-w-md bg-base-100 shadow-2xl">
              <div className="card-body gap-4">
                <div>
                  <h2 className="card-title text-2xl">登录</h2>
                  <p className="text-sm text-base-content/60">
                    先完成入口限制，后续再扩展正式账号体系。
                  </p>
                </div>

                <label className="form-control w-full">
                  <div className="label">
                    <span className="label-text">账号</span>
                  </div>
                  <input
                    className="input input-bordered w-full"
                    placeholder="请输入账号"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitLogin()
                    }}
                  />
                </label>

                <label className="form-control w-full">
                  <div className="label">
                    <span className="label-text">密码</span>
                  </div>
                  <input
                    type="password"
                    className="input input-bordered w-full"
                    placeholder="请输入密码"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitLogin()
                    }}
                  />
                </label>

                {loginError ? <div className="alert alert-error py-3 text-sm">{loginError}</div> : null}

                <button className="btn btn-primary mt-2" onClick={submitLogin}>
                  登录并进入
                </button>
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
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
          <div className="alert alert-info">
            <span>管理员已进入 CPM 入口。当前先提供运行控制面板，后续再逐步补齐完整管理页面。</span>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body gap-5">
                <div>
                  <div className="badge badge-primary badge-outline mb-3">管理员控制台</div>
                  <h2 className="card-title text-3xl font-black">CLIProxyApi 运行控制</h2>
                  <p className="text-base-content/65">
                    这个区域属于 CPM 管理入口。后续和 `CPA` 相关的配置、日志、认证、Provider 管理页面会接在这里。
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    className="btn btn-primary"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction('start', () => cpaRuntime.start())}
                  >
                    启动 CPA
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction('stop', () => cpaRuntime.stop())}
                  >
                    停止
                  </button>
                  <button
                    className="btn btn-accent"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction('restart', () => cpaRuntime.restart())}
                  >
                    重启
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction('refresh', refresh)}
                  >
                    刷新
                  </button>
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

                <div className="stats stats-vertical shadow lg:stats-horizontal">
                  <div className="stat">
                    <div className="stat-title">运行状态</div>
                    <div className="stat-value text-lg">
                      <span className={`badge badge-lg ${statusTone}`}>
                        {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                      </span>
                    </div>
                    <div className="stat-desc">由桌面宿主统一托管</div>
                  </div>
                  <div className="stat">
                    <div className="stat-title">代理端口</div>
                    <div className="stat-value text-primary">{cpaState?.apiPort ?? 8317}</div>
                    <div className="stat-desc">给外部客户端工具使用</div>
                  </div>
                  <div className="stat">
                    <div className="stat-title">运行模式</div>
                    <div className="stat-value text-secondary text-xl">
                      {cpaState?.runtimeModeLabel ?? '未就绪'}
                    </div>
                    <div className="stat-desc">浏览器管理页已禁用</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="card bg-base-100 shadow-xl">
              <div className="card-body gap-4">
                <h3 className="card-title">运行设置</h3>
                <label className="form-control w-full">
                  <div className="label">
                    <span className="label-text">代理服务端口</span>
                  </div>
                  <input
                    type="number"
                    className="input input-bordered w-full"
                    value={settings.apiPort}
                    onChange={(event) =>
                      setSettings({ ...settings, apiPort: Number(event.target.value) || 8317 })
                    }
                  />
                </label>

                <label className="form-control w-full">
                  <div className="label">
                    <span className="label-text">显式二进制路径</span>
                  </div>
                  <input
                    className="input input-bordered w-full"
                    value={settings.explicitBinaryPath ?? ''}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        explicitBinaryPath: event.target.value.trim() || null
                      })
                    }
                  />
                </label>

                <label className="label cursor-pointer justify-start gap-3">
                  <input
                    type="checkbox"
                    className="toggle toggle-primary"
                    checked={settings.autoStart}
                    onChange={(event) =>
                      setSettings({ ...settings, autoStart: event.target.checked })
                    }
                  />
                  <span className="label-text">应用启动后自动拉起 CPA</span>
                </label>

                <div className="card-actions mt-3 flex-wrap">
                  <button
                    className="btn btn-primary"
                    disabled={pendingAction !== null}
                    onClick={() => void saveSettings()}
                  >
                    保存设置
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction('config-dir', () => cpaRuntime.openConfigDir())}
                  >
                    打开配置目录
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={pendingAction !== null}
                    onClick={() => void runAction('logs-dir', () => cpaRuntime.openLogsDir())}
                  >
                    打开日志目录
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <h3 className="card-title">运行详情</h3>
                <div className="overflow-x-auto">
                  <table className="table">
                    <tbody>
                      <tr>
                        <th>配置文件</th>
                        <td>{runtimePaths?.configPath ?? '等待生成'}</td>
                      </tr>
                      <tr>
                        <th>日志目录</th>
                        <td>{runtimePaths?.logsDir ?? '等待生成'}</td>
                      </tr>
                      <tr>
                        <th>Bootstrap 文件</th>
                        <td>{runtimePaths?.bootstrapPath ?? '等待生成'}</td>
                      </tr>
                      <tr>
                        <th>运行二进制</th>
                        <td>{cpaState?.binaryPath ?? '开发模式回退到工作区 CLIProxyApi'}</td>
                      </tr>
                      <tr>
                        <th>浏览器管理入口</th>
                        <td>{cpaState?.browserManagementDisabled ? '已禁用' : '未禁用'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="card bg-base-100 shadow-xl">
              <div className="card-body">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="card-title">最近日志</h3>
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={pendingAction !== null}
                    onClick={() =>
                      void runAction('logs', async () => {
                        setLogs(await cpaRuntime.getRecentLogs())
                      })
                    }
                  >
                    重新载入
                  </button>
                </div>
                <div className="mockup-code min-h-80 overflow-x-auto">
                  <pre className="whitespace-pre-wrap break-all">
                    <code>{logs}</code>
                  </pre>
                </div>
              </div>
            </div>
          </div>
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
