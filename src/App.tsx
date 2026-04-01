import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { cpaRuntime } from './lib/cpa/runtime'
import type { AppState, BootstrapSettings, CpaState, RuntimePaths } from './lib/cpa/types'

const createEmptySettings = (): BootstrapSettings => ({
  host: '127.0.0.1',
  apiPort: 8317,
  managementKey: '',
  autoStart: true,
  binaryMode: 'development',
  explicitBinaryPath: null
})

function App() {
  const [appState, setAppState] = useState<AppState | null>(null)
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null)
  const [cpaState, setCpaState] = useState<CpaState | null>(null)
  const [logs, setLogs] = useState('Waiting for runtime logs...')
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
      setLogs(nextLogs || 'No runtime logs yet.')
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
        <p className="brand-label">Desktop Host</p>
        <h1 className="brand-title">CLIProxyApp</h1>
        <p className="brand-copy">
          Local desktop shell for running CLIProxyApi as a managed background service with its own
          management surface.
        </p>

        <div className="status-card">
          <span className={`status-chip ${statusClass}`}>{cpaState?.status ?? 'loading'}</span>
          <ul className="meta-list">
            <li>
              <span className="meta-label">App</span>
              <span className="meta-value">
                {appState?.appName ?? 'CLIProxyApp'} {appState?.appVersion ?? ''}
              </span>
            </li>
            <li>
              <span className="meta-label">Platform</span>
              <span className="meta-value">{appState?.platform ?? 'Unknown'}</span>
            </li>
            <li>
              <span className="meta-label">PID</span>
              <span className="meta-value">{cpaState?.pid ?? 'Not running'}</span>
            </li>
            <li>
              <span className="meta-label">Started At</span>
              <span className="meta-value">{cpaState?.startedAt ?? 'Not started'}</span>
            </li>
          </ul>
        </div>
      </aside>

      <main className="main-content">
        <section className="hero-panel">
          <div className="panel">
            <p className="eyebrow">Phase 1</p>
            <h2 className="hero-title">CPA Runtime Control</h2>
            <p className="hero-copy">
              This screen owns the desktop side of the contract: resolve runtime paths, store
              bootstrap settings, launch CLIProxyApi, and surface the management connection details
              the rest of CPAPP will use.
            </p>

            <div className="actions">
              <button
                className="btn btn-primary"
                disabled={pendingAction !== null}
                onClick={() => void runAction('start', () => cpaRuntime.start())}
              >
                Start CPA
              </button>
              <button
                className="btn btn-secondary"
                disabled={pendingAction !== null}
                onClick={() => void runAction('stop', () => cpaRuntime.stop())}
              >
                Stop
              </button>
              <button
                className="btn btn-secondary"
                disabled={pendingAction !== null}
                onClick={() => void runAction('restart', () => cpaRuntime.restart())}
              >
                Restart
              </button>
              <button
                className="btn btn-ghost"
                disabled={pendingAction !== null}
                onClick={() => void runAction('refresh', refresh)}
              >
                Refresh
              </button>
            </div>

            {cpaState?.lastError ? (
              <div className="error-banner">Last runtime error: {cpaState.lastError}</div>
            ) : null}

            {loadError ? <div className="error-banner">UI error: {loadError}</div> : null}
          </div>

          <div className="panel stats-grid">
            <div className="stat-card">
              <p className="stat-value">{cpaState?.apiPort ?? 8317}</p>
              <p className="stat-label">Managed API port</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{cpaState?.managementKeyConfigured ? 'Ready' : 'Missing'}</p>
              <p className="stat-label">Management key</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{settings.binaryMode}</p>
              <p className="stat-label">Runtime mode</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{runtimePaths ? 'Prepared' : 'Pending'}</p>
              <p className="stat-label">Runtime paths</p>
            </div>
          </div>
        </section>

        <section className="section-grid">
          <div className="panel">
            <h3 className="panel-title">Bootstrap Settings</h3>
            <div className="field-grid">
              <label>
                <span>Host</span>
                <input
                  value={settings.host}
                  onChange={(event) => setSettings({ ...settings, host: event.target.value })}
                />
              </label>

              <label>
                <span>API Port</span>
                <input
                  type="number"
                  value={settings.apiPort}
                  onChange={(event) =>
                    setSettings({ ...settings, apiPort: Number(event.target.value) || 8317 })
                  }
                />
              </label>

              <label>
                <span>Management Key</span>
                <input
                  value={settings.managementKey}
                  onChange={(event) =>
                    setSettings({ ...settings, managementKey: event.target.value })
                  }
                />
              </label>

              <label>
                <span>Explicit Binary Path</span>
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
                <span>Enable app-level auto start flag</span>
              </label>
            </div>

            <div className="actions" style={{ marginTop: 18 }}>
              <button
                className="btn btn-primary"
                disabled={pendingAction !== null}
                onClick={() => void saveSettings()}
              >
                Save bootstrap
              </button>
              <button
                className="btn btn-ghost"
                disabled={pendingAction !== null}
                onClick={() => void runAction('config-dir', () => cpaRuntime.openConfigDir())}
              >
                Open config dir
              </button>
              <button
                className="btn btn-ghost"
                disabled={pendingAction !== null}
                onClick={() => void runAction('logs-dir', () => cpaRuntime.openLogsDir())}
              >
                Open logs dir
              </button>
            </div>

            <div className="status-note">
              Phase 1 uses development mode by default. If no explicit binary is set, the desktop
              host will try to run the sibling workspace repository at `../CLIProxyApi` with `go run
              ./cmd/server`.
            </div>
          </div>

          <div className="panel">
            <h3 className="panel-title">Runtime Details</h3>
            <div className="detail-grid">
              <div className="detail-item">
                <h4>Management Base URL</h4>
                <p>{cpaState?.managementBaseUrl ?? 'Unavailable'}</p>
              </div>
              <div className="detail-item">
                <h4>Binary Path</h4>
                <p>{cpaState?.binaryPath ?? 'Development mode via go run'}</p>
              </div>
              <div className="detail-item">
                <h4>Config Path</h4>
                <p>{runtimePaths?.configPath ?? 'Pending'}</p>
              </div>
              <div className="detail-item">
                <h4>Logs Directory</h4>
                <p>{runtimePaths?.logsDir ?? 'Pending'}</p>
              </div>
              <div className="detail-item">
                <h4>Bootstrap File</h4>
                <p>{runtimePaths?.bootstrapPath ?? 'Pending'}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="log-panel">
          <div className="log-header">
            <div>
              <h3 className="panel-title" style={{ marginBottom: 0 }}>
                Recent Runtime Logs
              </h3>
              <p>Combined tail of CPA stdout and stderr.</p>
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
              Reload logs
            </button>
          </div>
          <pre className="log-output">{logs}</pre>
        </section>
      </main>
    </div>
  )
}

export default App
