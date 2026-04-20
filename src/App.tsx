import { useEffect, useMemo, useRef, useState } from 'react'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { cpaRuntime } from './lib/cpa/runtime'
import { OAuthPanel } from './features/oauth/OAuthPanel'
import { QuotaPanel } from './features/quota/QuotaPanel'
import { AuthFilesPanel } from './features/auth-files/AuthFilesPanel'
import { CloudAdminPanel } from './features/cloud-admin/CloudAdminPanel'
import { OpenAIProvidersPanel } from './features/openai-providers/OpenAIProvidersPanel'
import { UserWorkspace } from './features/user-workspace/UserWorkspace'
import { authFilesApi } from './features/auth-files/api'
import { cloudClient } from './lib/cloud/client'
import { sharedImportRegistry } from './lib/cloud/sharedRegistry'
import type { CloudFeatures, CloudPlan, CloudUser } from './lib/cloud/types'
import { formatPlanLabel } from './lib/cloud/planLabels'
import type {
  AppState,
  AppUpdateInfo,
  BootstrapSettings,
  CpaManagementInfo,
  CpaState,
  ImportAuthFilesResult
} from './lib/cpa/types'

type AdminTab = 'overview' | 'oauth' | 'auth-files' | 'quota' | 'openai-providers' | 'cloud-admin' | 'cpm'
type UserTab = 'overview' | 'oauth' | 'auth-files' | 'providers' | 'quota' | 'stats'
type DeveloperSurfaceMode = 'admin' | 'user'

interface LoginSession {
  token: string
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
  expiresAt?: string | null
}

const SESSION_KEY = 'cpapp-login-session'
const THEME_KEY = 'cpapp-theme'
const REMEMBER_LOGIN_KEY = 'cpapp-remember-login'
const THEMES = ['light', 'dark', 'synthwave', 'cyberpunk'] as const
type Theme = typeof THEMES[number]

interface RememberedLogin {
  email: string
  password: string
}

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

const MOBILE_WINDOW_SIZE = { width: 430, height: 920, minWidth: 390, minHeight: 760 }
const ADMIN_WINDOW_SIZE = { width: 1440, height: 920, minWidth: 1180, minHeight: 760 }

function App() {
  const passwordDialogRef = useRef<HTMLDialogElement | null>(null)
  const updateDialogRef = useRef<HTMLDialogElement | null>(null)
  const autoStartAttemptedRef = useRef(false)
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

  useEffect(() => {
    const raw = window.localStorage.getItem(REMEMBER_LOGIN_KEY)
    if (!raw) {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RememberedLogin>
      const rememberedEmail = String(parsed.email ?? '').trim()
      const rememberedPassword = String(parsed.password ?? '')
      if (!rememberedEmail || !rememberedPassword) {
        window.localStorage.removeItem(REMEMBER_LOGIN_KEY)
        return
      }
      setEmail(rememberedEmail)
      setPassword(rememberedPassword)
      setRememberLogin(true)
    } catch {
      window.localStorage.removeItem(REMEMBER_LOGIN_KEY)
    }
  }, [])

  const [session, setSession] = useState<LoginSession | null>(() => {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as LoginSession
    } catch {
      return null
    }
  })

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberLogin, setRememberLogin] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [registerMode, setRegisterMode] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [cpaState, setCpaState] = useState<CpaState | null>(null)
  const [managementInfo, setManagementInfo] = useState<CpaManagementInfo | null>(null)
  const [recentLogs, setRecentLogs] = useState('等待运行日志...')
  const [settings, setSettings] = useState<BootstrapSettings>(createEmptySettings)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [errorToastMessage, setErrorToastMessage] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [adminTab, setAdminTab] = useState<AdminTab>('overview')
  const [userTab, setUserTab] = useState<UserTab>('overview')
  const [developerSurfaceMode, setDeveloperSurfaceMode] = useState<DeveloperSurfaceMode>('user')
  const [normalizingFreeTier, setNormalizingFreeTier] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const cpmFrameRef = useRef<HTMLIFrameElement | null>(null)
  const errorToastTimerRef = useRef<number | null>(null)

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

  const useNewUserWorkspace = true
  const sessionPlanLabel = useMemo(
    () => formatPlanLabel(session?.plan.planCode, session?.plan.name),
    [session?.plan.name, session?.plan.planCode]
  )

  const userDisplayName = useMemo(() => {
    if (!session?.user.email) {
      return ''
    }
    const [name] = session.user.email.split('@')
    return name || session.user.email
  }, [session?.user.email])
  const actualIsAdmin = session?.user.role === 'admin'
  const canUseDeveloperSwitch =
    actualIsAdmin || userDisplayName.trim().toLowerCase() === 'xieyuqi'
  const effectiveIsAdmin = canUseDeveloperSwitch ? developerSurfaceMode === 'admin' : actualIsAdmin

  useEffect(() => {
    if (!session) {
      return
    }
    setDeveloperSurfaceMode(actualIsAdmin ? 'admin' : 'user')
  }, [actualIsAdmin, session?.user.id])

  const refreshSessionFromCloud = async () => {
    if (!session) {
      return null
    }
    const next = await cloudClient.me(session.token)
      const nextSession: LoginSession = {
        token: session.token,
        user: next.user,
        plan: next.plan,
        features: next.features,
        expiresAt: next.expiresAt ?? null
      }
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
    setSession(nextSession)
    return nextSession
  }

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
      handleLoadError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    }
  }

  const checkForUpdates = async (silent = false) => {
    try {
      setCheckingUpdate(true)
      const info = await cpaRuntime.checkAppUpdate()
      setUpdateInfo(info)
      if (info.hasUpdate) {
        if (!silent) {
          showToast(`发现新版本 ${info.latestVersion}`)
        }
        updateDialogRef.current?.showModal()
        return
      }
      if (!silent) {
        showToast(`当前已是最新版 ${info.currentVersion}`)
      }
    } catch (error) {
      if (!silent) {
        const message = error instanceof Error ? error.message : String(error)
        handleLoadError(message)
      }
    } finally {
      setCheckingUpdate(false)
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

  useEffect(() => {
    if (!session) {
      return
    }
    void checkForUpdates(true)
  }, [session?.token])

  useEffect(() => {
    if (!session) {
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const next = await cloudClient.me(session.token)
        if (cancelled) {
          return
        }
        const nextSession: LoginSession = {
          token: session.token,
          user: next.user,
          plan: next.plan,
          features: next.features,
          expiresAt: next.expiresAt ?? null
        }
        window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
        setSession(nextSession)
      } catch (error) {
        console.error(error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!session || cpaState?.status !== 'running' || session.features.max_enabled_auth_files !== 1) {
      return
    }

    let cancelled = false
    void (async () => {
      try {
        setNormalizingFreeTier(true)
        const response = await authFilesApi.list()
        const files = Array.isArray(response.files) ? response.files : []
        const enabledFiles = files.filter((file) => !`${file.disabled ?? ''}`.match(/^(true|1)$/i) && file.disabled !== true && file.disabled !== 1)

        if (enabledFiles.length === 0) {
          return
        }

        await Promise.all(enabledFiles.map((file) => authFilesApi.setStatus(file.name, true)))
        if (!cancelled) {
          showToast('免费版登录已自动禁用全部认证文件，请手动启用一个')
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          handleLoadError(message)
        }
      } finally {
        if (!cancelled) {
          setNormalizingFreeTier(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [session, cpaState?.status])

  useEffect(() => {
    if (!session || cpaState?.status !== 'running' || session.user.role === 'admin' || session.features.allow_shared_pool) {
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const trackedFiles = sharedImportRegistry.list()
        if (trackedFiles.length === 0) {
          return
        }
        const response = await authFilesApi.list()
        const files = Array.isArray(response.files) ? response.files : []
        const names = new Set(trackedFiles.map((item) => item.localFileName))
        const activeSharedFiles = files.filter((file) => names.has(file.name) && file.disabled !== true && file.disabled !== 1 && !`${file.disabled ?? ''}`.match(/^(true|1)$/i))

        if (activeSharedFiles.length === 0 || cancelled) {
          return
        }

        await Promise.all(activeSharedFiles.map((file) => authFilesApi.setStatus(file.name, true)))
        if (!cancelled) {
          showToast('当前套餐不可使用共享认证池，已自动禁用本地共享认证文件')
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          handleLoadError(message)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [session, cpaState?.status])

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
      handleLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  useEffect(() => {
    const syncWindowShell = async () => {
      try {
        const appWindow = getCurrentWindow()
        const target = effectiveIsAdmin ? ADMIN_WINDOW_SIZE : MOBILE_WINDOW_SIZE
        await appWindow.setMinSize(new LogicalSize(target.minWidth, target.minHeight))
        await appWindow.setSize(new LogicalSize(target.width, target.height))
        await appWindow.center()
      } catch {
        // Ignore browser mode or early Tauri runtime unavailability.
      }
    }

    void syncWindowShell()
  }, [effectiveIsAdmin])

  useEffect(() => {
    if (!session || session.user.role === 'admin' || !settings.autoStart) {
      autoStartAttemptedRef.current = false
      return
    }
    if (cpaState?.status === 'running' || cpaState?.status === 'starting') {
      autoStartAttemptedRef.current = true
      return
    }
    if (pendingAction !== null || cpaState?.status !== 'stopped' || autoStartAttemptedRef.current) {
      return
    }

    autoStartAttemptedRef.current = true
    void runAction('start', () => cpaRuntime.start())
  }, [session, settings.autoStart, cpaState?.status, pendingAction])

  const savePort = async () => {
    const normalizedPort = Number(settings.apiPort)
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      handleLoadError('端口必须是 1 到 65535 之间的整数。')
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

  const submitLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setLoginError('请输入账号和密码。')
      return
    }

    try {
      setPendingAction('login')
      const response = await cloudClient.login(email.trim().toLowerCase(), password)
      const nextSession: LoginSession = {
        token: response.token,
        user: response.user,
        plan: response.plan,
        features: response.features,
        expiresAt: response.expiresAt ?? null
      }
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
      if (rememberLogin) {
        const remembered: RememberedLogin = {
          email: email.trim().toLowerCase(),
          password
        }
        window.localStorage.setItem(REMEMBER_LOGIN_KEY, JSON.stringify(remembered))
      } else {
        window.localStorage.removeItem(REMEMBER_LOGIN_KEY)
      }
      setSession(nextSession)
      setLoginError(null)
      showToast(`登录成功：${response.plan.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoginError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const submitRegister = async () => {
    if (!email.trim() || !password.trim()) {
      setLoginError('请输入账号和密码。')
      return
    }

    try {
      setPendingAction('register')
      await cloudClient.register(email.trim().toLowerCase(), password)
      setRegisterMode(false)
      setPassword('')
      setLoginError(null)
      showToast('注册成功，请使用新账号登录')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoginError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const logout = () => {
    window.sessionStorage.removeItem(SESSION_KEY)
    setSession(null)
    if (!rememberLogin) {
      setEmail('')
      setPassword('')
    }
    setLoginError(null)
  }

  const submitChangePassword = async () => {
    if (!session) {
      return
    }
    if (!currentPassword.trim() || !nextPassword.trim()) {
      handleLoadError('请输入当前密码和新密码。')
      return
    }
    try {
      setPendingAction('change-password')
      await cloudClient.changePassword(session.token, currentPassword, nextPassword)
      setCurrentPassword('')
      setNextPassword('')
      handleLoadError(null)
      showToast('密码修改成功，请使用新密码继续登录')
      passwordDialogRef.current?.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const showToast = (message: string) => {
    setToastMessage(message)
    window.setTimeout(() => setToastMessage(null), 2500)
  }

  const handleLoadError = (message: string | null) => {
    setLoadError(message)
    if (!message) {
      setErrorToastMessage(null)
      if (errorToastTimerRef.current !== null) {
        window.clearTimeout(errorToastTimerRef.current)
        errorToastTimerRef.current = null
      }
      return
    }
    setErrorToastMessage(message)
    if (errorToastTimerRef.current !== null) {
      window.clearTimeout(errorToastTimerRef.current)
    }
    errorToastTimerRef.current = window.setTimeout(() => {
      setErrorToastMessage(null)
      errorToastTimerRef.current = null
    }, 3000)
  }

  const summarizeImportResult = (result: ImportAuthFilesResult) => {
    if (result.skipped.length > 0) {
      return `已导入 ${result.importedCount} 个认证文件，跳过 ${result.skipped.length} 个无效项目`
    }
    return `已导入 ${result.importedCount} 个认证文件`
  }

  const getExternalHref = (href: string, baseUrl: string) => {
    try {
      const url = new URL(href, baseUrl)
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        return null
      }
      return url.toString()
    } catch {
      return null
    }
  }

  const openExternalHref = async (href: string) => {
    await cpaRuntime.openExternalTarget(href)
  }

  const installExternalLinkHandler = (doc: Document | null, baseUrl: string) => {
    if (!doc) {
      return () => {}
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) {
        return
      }

      const href = anchor.getAttribute('href')
      if (!href) {
        return
      }

      const externalHref = getExternalHref(href, baseUrl)
      if (!externalHref) {
        return
      }

      event.preventDefault()
      void openExternalHref(externalHref)
    }

    doc.addEventListener('click', handleClick, true)
    return () => doc.removeEventListener('click', handleClick, true)
  }

  const handleImportSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files
    if (!selectedFiles || selectedFiles.length === 0) {
      return
    }

    try {
      setPendingAction('import-auth-files')
      handleLoadError(null)

      const payload = await Promise.all(
        Array.from(selectedFiles).map(async (file) => ({
          name: file.name,
          bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
        }))
      )

      const result = await cpaRuntime.importAuthFiles(payload)
      await refresh()
      showToast(summarizeImportResult(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      event.target.value = ''
      setPendingAction(null)
    }
  }

  const handleExportAuthFiles = async () => {
    try {
      setPendingAction('export-auth-files')
      handleLoadError(null)
      const archive = await cpaRuntime.exportAuthFilesArchive()
      if (!archive.savedPath) {
        return
      }
      showToast(`已导出 ${archive.fileCount} 个认证文件`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  useEffect(() => {
    const cleanupMain = installExternalLinkHandler(document, window.location.href)
    return cleanupMain
  }, [])

  useEffect(() => {
    if (!effectiveIsAdmin || adminTab !== 'cpm') {
      return
    }

    const iframe = cpmFrameRef.current
    if (!iframe) {
      return
    }

    let cleanupFrame = () => {}
    const attachFrameHandler = () => {
      cleanupFrame()
      cleanupFrame = installExternalLinkHandler(iframe.contentDocument, iframe.src || window.location.href)
    }

    iframe.addEventListener('load', attachFrameHandler)
    attachFrameHandler()

    return () => {
      iframe.removeEventListener('load', attachFrameHandler)
      cleanupFrame()
    }
  }, [adminTab, cpmUrl, effectiveIsAdmin])

  if (!session) {
    return (
      <div className="min-h-screen bg-base-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-primary flex items-center justify-center text-primary-content shadow-lg mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </div>
            <h1 className="text-3xl font-black tracking-tight text-base-content mb-2">CPSwitch</h1>
            <p className="text-base-content/60 text-sm">极简高效的桌面代理工具</p>
          </div>

          <div className="card bg-base-200/80 shadow-xl border border-base-300 backdrop-blur-sm">
            <div className="card-body p-6 sm:p-8">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl font-bold text-base-content">{registerMode ? '创建账号' : '欢迎回来'}</h2>
                <button
                  className="btn btn-ghost btn-sm text-primary hover:bg-primary/10"
                  onClick={() => {
                    setRegisterMode((current) => !current)
                    setLoginError(null)
                  }}
                >
                  {registerMode ? '直接登录' : '注册账号'}
                </button>
              </div>

              <div className="space-y-4">
                <div className="form-control">
                  <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z" />
                    </svg>
                    <input
                      type="text"
                      className="grow"
                      placeholder="账号"
                      autoCapitalize="none"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void (registerMode ? submitRegister() : submitLogin())
                        }
                      }}
                    />
                  </label>
                </div>

                <div className="form-control">
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
                        if (event.key === 'Enter') {
                          void (registerMode ? submitRegister() : submitLogin())
                        }
                      }}
                    />
                  </label>
                </div>

                {!registerMode ? (
                  <label className="label cursor-pointer justify-start gap-3 py-0">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-primary checkbox-sm"
                      checked={rememberLogin}
                      onChange={(event) => {
                        const checked = event.target.checked
                        setRememberLogin(checked)
                        if (!checked) {
                          window.localStorage.removeItem(REMEMBER_LOGIN_KEY)
                        }
                      }}
                    />
                    <span className="label-text text-sm text-base-content/70">记住账号密码</span>
                  </label>
                ) : null}

                {loginError && (
                  <div className="alert alert-error mt-4 py-2 text-sm rounded-lg">
                    <span>{loginError}</span>
                  </div>
                )}

                <div className="form-control mt-6">
                  <button
                    className="btn btn-primary w-full text-base"
                    disabled={pendingAction === 'login' || pendingAction === 'register'}
                    onClick={() => void (registerMode ? submitRegister() : submitLogin())}
                  >
                    {pendingAction === 'login' || pendingAction === 'register' ? <span className="loading loading-spinner loading-sm"></span> : null}
                    {registerMode ? '创建账号' : '立即登录'}
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
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.zip,application/json,application/zip"
        multiple
        className="hidden"
        onChange={(event) => void handleImportSelection(event)}
      />
      {effectiveIsAdmin ? (
        <div className="navbar h-16 border-b border-base-300 bg-base-100 px-6 shadow-sm">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <div 
                className="flex items-center gap-2 text-2xl font-black tracking-tight cursor-pointer select-none hover:opacity-80 transition-opacity"
                onClick={() => {
                  const currentIndex = THEMES.indexOf(theme)
                  const nextIndex = (currentIndex + 1) % THEMES.length
                  setTheme(THEMES[nextIndex])
                }}
                title="点击切换主题"
              >
                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-content shadow-sm">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </div>
                CPM 管理入口
              </div>
              {canUseDeveloperSwitch ? (
                <div className="join join-horizontal">
                  <button
                    className={`join-item btn btn-xs ${developerSurfaceMode === 'user' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setDeveloperSurfaceMode('user')}
                  >
                    User
                  </button>
                  <button
                    className={`join-item btn btn-xs ${developerSurfaceMode === 'admin' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setDeveloperSurfaceMode('admin')}
                  >
                    Admin
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex-none flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 rounded-full border border-base-300 bg-base-200 px-3 py-1.5 text-xs font-mono text-base-content/60 shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
              cli v{appState?.appVersion ?? '0.1.0'}
            </div>
            <div className="flex items-center gap-3 border-base-300 pl-2 sm:border-l sm:pl-4">
              <button
                className="btn btn-outline btn-sm"
                disabled={checkingUpdate}
                onClick={() => void checkForUpdates(false)}
              >
                {checkingUpdate ? <span className="loading loading-spinner loading-xs"></span> : null}
                检查更新
              </button>
              <div className="hidden text-right sm:block">
                <div className="text-sm font-bold leading-none">{session.user.email}</div>
                <div className="mt-1.5 text-[11px] font-medium tracking-wide text-base-content/55">
                  {sessionPlanLabel}
                </div>
              </div>
              <div className="avatar placeholder">
                <div className="w-10 rounded-full bg-neutral text-neutral-content">
                  <span className="text-lg">{userDisplayName.slice(0, 1).toUpperCase()}</span>
                </div>
              </div>
              <button
                className="ml-2 text-base-content/60 transition-colors hover:text-primary"
                onClick={() => passwordDialogRef.current?.showModal()}
                title="修改密码"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button
                className="ml-2 text-base-content/60 transition-colors hover:text-error"
                onClick={logout}
                title="退出登录"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full flex justify-between items-center pt-2 px-4" >
          <div 
            className="flex items-center gap-2 font-bold text-sm cursor-pointer select-none hover:opacity-80 transition-opacity" 
            onClick={() => {
              const currentIndex = THEMES.indexOf(theme)
              const nextIndex = (currentIndex + 1) % THEMES.length
              setTheme(THEMES[nextIndex])
            }}
            title="点击切换主题"
          >
            <div className="w-4 h-4 rounded-md bg-primary flex items-center justify-center text-primary-content shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </div>
            CPSwitch
          </div>
          <div className="flex items-center gap-1">
            {canUseDeveloperSwitch ? (
              <div className="join join-horizontal">
                <button
                  className={`join-item btn btn-xs ${developerSurfaceMode === 'user' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setDeveloperSurfaceMode('user')}
                >
                  User
                </button>
                <button
                  className={`join-item btn btn-xs ${developerSurfaceMode === 'admin' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setDeveloperSurfaceMode('admin')}
                >
                  Admin
                </button>
              </div>
            ) : null}
            <button
              className="btn btn-ghost btn-sm btn-square"
              disabled={checkingUpdate}
              onClick={() => void checkForUpdates(false)}
              title="检查更新"
            >
                {checkingUpdate ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/><path d="M12 7v5l3 3"/></svg>
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm btn-square"
                onClick={() => passwordDialogRef.current?.showModal()}
                title="修改密码"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button
              className="btn btn-ghost btn-sm btn-square text-error"
              onClick={logout}
              title="退出登录"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
            </button>
          </div>
        </div>
      )}

      <dialog ref={updateDialogRef} className="modal">
        <div className="modal-box max-w-xl">
          <h3 className="text-xl font-bold">版本更新</h3>
          <div className="mt-4 space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-box bg-base-200 px-4 py-3">
                <div className="text-xs text-base-content/60">当前版本</div>
                <div className="mt-1 font-mono font-semibold">{updateInfo?.currentVersion ?? '-'}</div>
              </div>
              <div className="rounded-box bg-base-200 px-4 py-3">
                <div className="text-xs text-base-content/60">最新版本</div>
                <div className="mt-1 font-mono font-semibold">{updateInfo?.latestVersion ?? '-'}</div>
              </div>
            </div>
            {updateInfo?.notes ? (
              <div className="rounded-box border border-base-300 bg-base-100 px-4 py-3 whitespace-pre-wrap">
                {updateInfo.notes}
              </div>
            ) : null}
            {!updateInfo?.hasUpdate ? (
              <div className="alert alert-success">
                <span>当前已是最新版本。</span>
              </div>
            ) : (
              <div className="alert alert-info">
                <span>检测到新版本，建议现在更新。更新包会从你的服务器地址下载。</span>
              </div>
            )}
          </div>
          <div className="modal-action">
            <button className="btn" onClick={() => updateDialogRef.current?.close()}>
              关闭
            </button>
            <button
              className="btn btn-primary"
              disabled={!updateInfo?.hasUpdate || !updateInfo.downloadUrl}
              onClick={() => {
                if (updateInfo?.downloadUrl) {
                  void cpaRuntime.openExternalTarget(updateInfo.downloadUrl)
                }
              }}
            >
              打开下载地址
            </button>
          </div>
        </div>
      </dialog>

      {effectiveIsAdmin ? (
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
              className={`tab ${adminTab === 'oauth' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('oauth')}
            >
              OAuth
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'auth-files' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('auth-files')}
            >
              认证文件
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'quota' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('quota')}
            >
              配额
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'openai-providers' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('openai-providers')}
            >
              OpenAI兼容
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'cloud-admin' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('cloud-admin')}
            >
              后台管理
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
                <div className="badge badge-primary badge-outline badge-lg px-4">
                  {adminTab === 'overview'
                    ? '桌面宿主概览'
                    : adminTab === 'oauth'
                      ? 'OAuth 授权'
                      : adminTab === 'auth-files'
                        ? '认证文件'
                      : adminTab === 'quota'
                        ? '配额管理'
                        : adminTab === 'openai-providers'
                          ? 'OpenAI 兼容提供商'
                        : adminTab === 'cloud-admin'
                          ? '云用户与共享池'
                        : '原始 CPM 管理页'}
                </div>
                <div className={`badge badge-lg px-4 ${statusTone}`}>
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

                <button
                  className="btn btn-outline btn-sm font-normal"
                  disabled={pendingAction !== null || cpaState?.status !== 'running'}
                  onClick={() => importInputRef.current?.click()}
                >
                  {pendingAction === 'import-auth-files' && <span className="loading loading-spinner loading-xs"></span>}
                  批量导入认证
                </button>

                <button
                  className="btn btn-outline btn-sm font-normal"
                  disabled={pendingAction !== null}
                  onClick={() => void handleExportAuthFiles()}
                >
                  {pendingAction === 'export-auth-files' && <span className="loading loading-spinner loading-xs"></span>}
                  批量导出认证
                </button>

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

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">账号</div>
                <div className="stat-value text-lg">{session.user.email}</div>
                <div className="stat-desc">{session.user.role}</div>
              </div>
            </div>
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">套餐</div>
                <div className="stat-value text-secondary text-lg">{sessionPlanLabel}</div>
                <div className="stat-desc">{session.plan.planCode}</div>
              </div>
            </div>
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">自动切换</div>
                <div className="stat-value text-lg">{session.features.allow_auto_rotation ? '开启' : '关闭'}</div>
                <div className="stat-desc">个人云：{session.features.allow_personal_cloud_sync ? '可用' : '禁用'}</div>
              </div>
            </div>
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">共享池</div>
                <div className="stat-value text-lg">{session.features.allow_shared_pool ? '可用' : '不可用'}</div>
                <div className="stat-desc">最大设备：{session.features.max_devices}</div>
              </div>
            </div>
          </div>

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
          ) : adminTab === 'oauth' ? (
            <OAuthPanel
              canManage={true}
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : adminTab === 'auth-files' ? (
            <AuthFilesPanel
              cpaRunning={cpaState?.status === 'running'}
              pendingAction={pendingAction}
              planCode={session.plan.planCode}
              cloudToken={session.token}
              maxEnabledAuthFiles={session.features.max_enabled_auth_files}
              allowAutoRotation={session.features.allow_auto_rotation}
              allowPersonalCloudSync={session.features.allow_personal_cloud_sync}
              allowSharedPool={session.features.allow_shared_pool}
              onNotify={showToast}
              onError={handleLoadError}
              onImportClick={() => importInputRef.current?.click()}
              onExportClick={() => void handleExportAuthFiles()}
              onOpenConfigDir={() => void cpaRuntime.openConfigDir()}
            />
          ) : adminTab === 'quota' ? (
            <QuotaPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : adminTab === 'openai-providers' ? (
            <OpenAIProvidersPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : adminTab === 'cloud-admin' ? (
            <CloudAdminPanel
              token={session.token}
              onNotify={showToast}
              onError={handleLoadError}
            />
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
                      ref={cpmFrameRef}
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
      ) : useNewUserWorkspace ? (
                <UserWorkspace
                  plan={session.plan}
                  features={session.features}
                  planExpiresAt={session.expiresAt ?? null}
                  userKey={session.user.email}
          cloudToken={session.token}
          cpaState={cpaState}
          loadError={loadError}
          pendingAction={pendingAction}
          normalizingFreeTier={normalizingFreeTier}
          onRefreshSession={refreshSessionFromCloud}
          onStart={() => runAction('start', () => cpaRuntime.start(), '启动指令已发送')}
          onRestart={() => runAction('restart', () => cpaRuntime.restart(), '重启指令已发送')}
          onStop={() => runAction('stop', () => cpaRuntime.stop(), '停止指令已发送')}
          onRefresh={() => runAction('refresh', refresh, '状态刷新完毕')}
          onNotify={showToast}
          onError={handleLoadError}
        />
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
              className={`tab ${userTab === 'auth-files' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('auth-files')}
            >
              认证文件
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
                <div className="badge badge-primary badge-outline badge-lg px-4">
                  {userTab === 'overview' ? '普通系统概览' : '用户模块'}
                </div>
                <div className={`badge badge-lg px-4 ${statusTone}`}>
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
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">账号</div>
                    <div className="stat-value text-lg">{session.user.email}</div>
                    <div className="stat-desc">设备：{cloudClient.getDeviceId(session.user.email).slice(0, 8)}</div>
                  </div>
                </div>

                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">套餐</div>
                    <div className="stat-value text-primary">{sessionPlanLabel}</div>
                    <div className="stat-desc">{session.plan.planCode}</div>
                  </div>
                </div>

                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">最大启用认证</div>
                    <div className="stat-value text-secondary">
                      {session.features.max_enabled_auth_files >= 999 ? '∞' : session.features.max_enabled_auth_files}
                    </div>
                    <div className="stat-desc">免费版登录后默认禁用全部</div>
                  </div>
                </div>

                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">云能力</div>
                    <div className="stat-value text-lg">{session.features.allow_personal_cloud_sync ? '个人云' : '本地'}</div>
                    <div className="stat-desc">共享池：{session.features.allow_shared_pool ? '可用' : '不可用'}</div>
                  </div>
                </div>
              </div>

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
            <OAuthPanel
              canManage={false}
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
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

          {userTab === 'auth-files' && (
            <AuthFilesPanel
              cpaRunning={cpaState?.status === 'running'}
              pendingAction={pendingAction}
              planCode={session.plan.planCode}
              cloudToken={session.token}
              maxEnabledAuthFiles={session.features.max_enabled_auth_files}
              allowAutoRotation={session.features.allow_auto_rotation}
              allowPersonalCloudSync={session.features.allow_personal_cloud_sync}
              allowSharedPool={session.features.allow_shared_pool}
              onNotify={showToast}
              onError={handleLoadError}
              onImportClick={() => importInputRef.current?.click()}
              onExportClick={() => void handleExportAuthFiles()}
              onOpenConfigDir={() => void cpaRuntime.openConfigDir()}
            />
          )}

          {userTab === 'quota' && (
            <QuotaPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
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
        <div className="toast toast-top toast-center z-[1100]">
          <div className="alert alert-success shadow-lg">
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {errorToastMessage && (
        <div className="toast toast-top toast-center z-[1200] top-3">
          <div className="alert alert-error shadow-2xl">
            <span>{errorToastMessage}</span>
          </div>
        </div>
      )}

      <dialog ref={passwordDialogRef} className="modal">
        <div className="modal-box max-w-lg">
          <div className="space-y-1">
            <h3 className="text-2xl font-black">修改密码</h3>
            <p className="text-sm text-base-content/60">当前账号：{session?.user.email}</p>
          </div>
          <div className="mt-6 space-y-5">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-base-content/70">当前密码</span>
              <input
                type="password"
                className="input input-bordered h-12"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-base-content/70">新密码</span>
              <input
                type="password"
                className="input input-bordered h-12"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
              />
            </label>
          </div>
          <div className="modal-action mt-8">
            <form method="dialog">
              <button className="btn">取消</button>
            </form>
            <button
              className="btn btn-primary"
              disabled={pendingAction === 'change-password'}
              onClick={() => void submitChangePassword()}
            >
              {pendingAction === 'change-password' ? <span className="loading loading-spinner loading-xs"></span> : null}
              保存新密码
            </button>
          </div>
        </div>
      </dialog>

      {normalizingFreeTier ? (
        <div className="toast toast-bottom toast-end z-[90]">
          <div className="alert">
            <span>免费版登录限制同步中：正在禁用本地认证文件</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
