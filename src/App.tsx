import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { cpaRuntime } from './lib/cpa/runtime'
import type { AppState, BootstrapSettings, CpaState, RuntimePaths } from './lib/cpa/types'

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
  const [appState, setAppState] = useState<AppState | null>(null)
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null)
  const [cpaState, setCpaState] = useState<CpaState | null>(null)
  const [logs, setLogs] = useState('等待运行日志...')
  const [settings, setSettings] = useState<BootstrapSettings>(createEmptySettings)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const statusClass = useMemo(() => {
    switch (cpaState?.status) {
      case 'running':
        return 'status-running'
      case 'starting':
      case 'stopping':
        return `status-${cpaState.status}`
      case 'error':
        return 'status-error'
      default:
        return 'status-stopped'
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
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="brand-label">桌面宿主</p>
        <h1 className="brand-title">CLIProxyApp</h1>
        <p className="brand-copy">
          这是 `CLIProxyApi` 的桌面控制台。管理能力后续只通过 App 内部代理访问，不再依赖浏览器打开本地管理页。
        </p>

        <div className="status-card">
          <span className={`status-chip ${statusClass}`}>
            {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知状态'}
          </span>
          <ul className="meta-list">
            <li>
              <span className="meta-label">应用</span>
              <span className="meta-value">
                {appState?.appName ?? 'CLIProxyApp'} {appState?.appVersion ?? ''}
              </span>
            </li>
            <li>
              <span className="meta-label">平台</span>
              <span className="meta-value">{appState?.platform ?? '未知'}</span>
            </li>
            <li>
              <span className="meta-label">进程 PID</span>
              <span className="meta-value">{cpaState?.pid ?? '未运行'}</span>
            </li>
            <li>
              <span className="meta-label">启动时间</span>
              <span className="meta-value">{cpaState?.startedAt ?? '尚未启动'}</span>
            </li>
          </ul>
        </div>
      </aside>

      <main className="main-content">
        <section className="hero-panel">
          <div className="panel">
            <p className="eyebrow">第一阶段</p>
            <h2 className="hero-title">CPA 运行控制</h2>
            <p className="hero-copy">
              当前页面负责桌面侧的基础能力：运行目录、启动参数、进程生命周期、日志查看，以及后续 App 内部管理代理要依赖的运行上下文。
            </p>

            <div className="actions">
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
                className="btn btn-secondary"
                disabled={pendingAction !== null}
                onClick={() => void runAction('restart', () => cpaRuntime.restart())}
              >
                重启
              </button>
              <button
                className="btn btn-ghost"
                disabled={pendingAction !== null}
                onClick={() => void runAction('refresh', refresh)}
              >
                刷新
              </button>
            </div>

            {cpaState?.lastError ? (
              <div className="error-banner">最近一次运行错误：{cpaState.lastError}</div>
            ) : null}

            {loadError ? <div className="error-banner">界面错误：{loadError}</div> : null}
          </div>

          <div className="panel stats-grid">
            <div className="stat-card">
              <p className="stat-value">{cpaState?.apiPort ?? 8317}</p>
              <p className="stat-label">代理服务端口</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{cpaState?.runtimeModeLabel ?? '未就绪'}</p>
              <p className="stat-label">运行模式</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{runtimePaths ? '已准备' : '处理中'}</p>
              <p className="stat-label">运行目录</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">
                {cpaState?.browserManagementDisabled ? '已禁用' : '仍开放'}
              </p>
              <p className="stat-label">浏览器管理入口</p>
            </div>
          </div>
        </section>

        <section className="section-grid">
          <div className="panel">
            <h3 className="panel-title">运行设置</h3>
            <div className="field-grid">
              <label>
                <span>代理服务端口</span>
                <input
                  type="number"
                  value={settings.apiPort}
                  onChange={(event) =>
                    setSettings({ ...settings, apiPort: Number(event.target.value) || 8317 })
                  }
                />
              </label>

              <label>
                <span>显式二进制路径</span>
                <input
                  value={settings.explicitBinaryPath ?? ''}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      explicitBinaryPath: event.target.value.trim() || null
                    })
                  }
                />
              </label>

              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.autoStart}
                  onChange={(event) =>
                    setSettings({ ...settings, autoStart: event.target.checked })
                  }
                />
                <span>应用启动后自动拉起 CPA</span>
              </label>
            </div>

            <div className="actions" style={{ marginTop: 18 }}>
              <button
                className="btn btn-primary"
                disabled={pendingAction !== null}
                onClick={() => void saveSettings()}
              >
                保存设置
              </button>
              <button
                className="btn btn-ghost"
                disabled={pendingAction !== null}
                onClick={() => void runAction('config-dir', () => cpaRuntime.openConfigDir())}
              >
                打开配置目录
              </button>
              <button
                className="btn btn-ghost"
                disabled={pendingAction !== null}
                onClick={() => void runAction('logs-dir', () => cpaRuntime.openLogsDir())}
              >
                打开日志目录
              </button>
            </div>

            <div className="status-note">
              当前默认策略是：禁用浏览器管理页、管理密钥仅保存在桌面宿主内部，后续所有管理操作统一通过 App 内部代理走 Tauri 命令。
            </div>
          </div>

          <div className="panel">
            <h3 className="panel-title">运行详情</h3>
            <div className="detail-grid">
              <div className="detail-item">
                <h4>配置文件路径</h4>
                <p>{runtimePaths?.configPath ?? '等待生成'}</p>
              </div>
              <div className="detail-item">
                <h4>日志目录</h4>
                <p>{runtimePaths?.logsDir ?? '等待生成'}</p>
              </div>
              <div className="detail-item">
                <h4>Bootstrap 文件</h4>
                <p>{runtimePaths?.bootstrapPath ?? '等待生成'}</p>
              </div>
              <div className="detail-item">
                <h4>运行二进制</h4>
                <p>{cpaState?.binaryPath ?? '开发模式回退到工作区 CLIProxyApi'}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="log-panel">
          <div className="log-header">
            <div>
              <h3 className="panel-title" style={{ marginBottom: 0 }}>
                最近日志
              </h3>
              <p>这里显示 CPA 标准输出与错误输出的最新内容。</p>
            </div>
            <button
              className="btn btn-secondary"
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
          <pre className="log-output">{logs}</pre>
        </section>
      </main>
    </div>
  )
}

export default App
