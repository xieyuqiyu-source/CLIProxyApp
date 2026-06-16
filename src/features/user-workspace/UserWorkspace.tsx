import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import QRCode from 'qrcode'
import { QuotaPanel } from '../quota/QuotaPanel'
import { PROVIDER_META, PROVIDER_ORDER } from '../quota/providerMeta'
import type { AuthFileItem, QuotaProvider } from '../quota/types'
import type {
  CloudCreatePaymentOrderResponse,
  CloudFeatures,
  CloudPaymentProduct,
  CloudPaymentPurchaseMode,
  CloudPaymentQuote,
  CloudPlan
} from '../../lib/cloud/types'
import type { CpaState } from '../../lib/cpa/types'
import type { ImportAuthInputFile, KiroProxyStartResult, OpenClawConfigMode } from '../../lib/cpa/types'
import { OAuthPanel } from '../oauth/OAuthPanel'
import { OpenAIProvidersPanel } from '../openai-providers/OpenAIProvidersPanel'
import { CodexConfigDialog } from '../codex-config/CodexConfigDialog'
import { ContinueConfigDialog } from '../continue-config/ContinueConfigDialog'
import type { OAuthProvider } from '../oauth/types'
import { cloudClient } from '../../lib/cloud/client'
import { formatPlanLabel } from '../../lib/cloud/planLabels'
import { sharedImportRegistry } from '../../lib/cloud/sharedRegistry'
import { cpaRuntime } from '../../lib/cpa/runtime'
import vipQrImage from '../../assets/vip-qr.jpg'
import { authFilesApi } from '../auth-files/api'
import { getApiCallErrorMessage, quotaApi } from '../quota/api'

const CCSWITCH_OFFICIAL_URL = 'https://ccswitch.io/zh/'
const CCSWITCH_DOWNLOAD_URL = 'https://github.com/farion1231/cc-switch/releases'

interface UserWorkspaceProps {
  plan: CloudPlan
  features: CloudFeatures
  planExpiresAt: string | null
  userKey: string
  cloudToken: string
  isAdminAccount: boolean
  cpaState: CpaState | null
  loadError: string | null
  pendingAction: string | null
  normalizingFreeTier: boolean
  onRefreshSession: () => Promise<{ plan: CloudPlan; features: CloudFeatures } | null>
  onStart: () => Promise<void>
  onRestart: () => Promise<void>
  onStop: () => Promise<void>
  onRefresh: () => Promise<void>
  onNotify: (message: string) => void
  onError: (message: string | null) => void
}

const statusLabelMap: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '异常'
}

function getStatusTone(status?: string) {
  switch (status) {
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
}

function mapQuotaProviderToOauthProvider(provider: QuotaProvider): OAuthProvider {
  switch (provider) {
    case 'claude':
      return 'anthropic'
    case 'codex':
      return 'codex'
    case 'gemini-cli':
      return 'gemini-cli'
    case 'antigravity':
      return 'antigravity'
    case 'kimi':
      return 'kimi'
  }
}

function resolveOauthProviders(provider: QuotaProvider | 'all'): OAuthProvider[] | undefined {
  if (provider === 'all') {
    return PROVIDER_ORDER.map(mapQuotaProviderToOauthProvider)
  }
  return [mapQuotaProviderToOauthProvider(provider)]
}

function getSharedSyncStorageKey(userKey: string) {
  return `cpapp-shared-sync-last:${userKey}`
}

function getAutoSharedSyncStorageKey(userKey: string) {
  return `cpapp-auto-shared-sync-hours:${userKey}`
}

function getAutoSharedSyncLastRunKey(userKey: string) {
  return `cpapp-auto-shared-sync-last-run:${userKey}`
}

const autoSharedSyncOptions = [
  { label: '关闭', hours: 0 },
  { label: '1小时', hours: 1 },
  { label: '3小时', hours: 3 },
  { label: '6小时', hours: 6 },
  { label: '12小时', hours: 12 }
] as const

const loginImportTabs = [
  { id: 'oauth', label: 'OAuth' },
  { id: 'token-json', label: 'Token/Json' },
  { id: 'file', label: '导入' }
] as const

type LoginImportTab = (typeof loginImportTabs)[number]['id']
type TokenImportProvider = 'codex' | 'anthropic' | 'gemini-cli' | 'antigravity' | 'kimi'
type TokenImportKind = 'access_token' | 'refresh_token'

const tokenImportProviders: Array<{ value: TokenImportProvider; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'anthropic', label: 'Claude' },
  { value: 'gemini-cli', label: 'Gemini CLI' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'kimi', label: 'Kimi' }
]

function buildSharedLocalFileName(fileName: string) {
  return fileName.startsWith('共享-') ? fileName : `共享-${fileName}`
}

function encodeImportFile(name: string, content: string): ImportAuthInputFile {
  return {
    name,
    bytes: Array.from(new TextEncoder().encode(content))
  }
}

function buildAuthImportFileName(prefix: string, suffix = 'json') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${prefix}-${timestamp}.${suffix}`
}

function inferAuthImportProvider(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return 'auth'
  }
  const record = value as Record<string, unknown>
  const provider = record.provider ?? record.type ?? record.kind ?? record.service
  if (typeof provider === 'string' && provider.trim()) {
    return provider.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  }
  if ('claudeAiOauth' in record || 'anthropic' in record) return 'anthropic'
  if ('refresh_token' in record || 'refreshToken' in record || 'accessToken' in record || 'access_token' in record) return 'token'
  return 'auth'
}

function normalizePastedJsonAuth(raw: string) {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed
  }
  const record = { ...(parsed as Record<string, unknown>) }
  if (typeof record.accessToken === 'string' && !record.access_token) {
    record.access_token = record.accessToken
  }
  if (typeof record.refreshToken === 'string' && !record.refresh_token) {
    record.refresh_token = record.refreshToken
  }
  return record
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function buildQuoteCacheKey(productCode: string, billingMonths: number, purchaseMode: CloudPaymentPurchaseMode) {
  return `${productCode}:${billingMonths}:${purchaseMode}`
}

function normalizeStringValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeAuthFileName(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function normalizeAuthIndex(file: AuthFileItem) {
  return normalizeStringValue(file.authIndex) ?? normalizeStringValue(file.auth_index)
}

function isDisabledAuthFile(file: AuthFileItem) {
  return file.disabled === true || file.disabled === 1 || `${file.disabled ?? ''}`.match(/^(true|1)$/i) !== null
}

function isCodexLikeAuthFile(file: AuthFileItem) {
  const raw = `${file.provider ?? ''} ${file.type ?? ''} ${file.name ?? ''}`.toLowerCase()
  return raw.includes('codex') || raw.includes('chatgpt') || raw.includes('openai')
}

function parseResponseJson(result: { body: unknown | null; bodyText: string }) {
  if (result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
    return result.body as Record<string, unknown>
  }
  try {
    const parsed = JSON.parse(result.bodyText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function getWindowUsedPercent(windowValue: unknown) {
  const record = readRecord(windowValue)
  if (!record) {
    return null
  }
  return normalizeNumberValue(record.used_percent ?? record.usedPercent)
}

function getCodexWindowSeconds(windowValue: unknown) {
  const record = readRecord(windowValue)
  if (!record) {
    return null
  }
  return normalizeNumberValue(record.limit_window_seconds ?? record.limitWindowSeconds)
}

function getCodexWindows(limitInfo: Record<string, unknown> | null) {
  const primary =
    readRecord(limitInfo?.primary_window) ??
    readRecord(limitInfo?.primaryWindow)
  const secondary =
    readRecord(limitInfo?.secondary_window) ??
    readRecord(limitInfo?.secondaryWindow)

  let fiveHour = null as Record<string, unknown> | null
  let weekly = null as Record<string, unknown> | null
  for (const windowValue of [primary, secondary]) {
    const seconds = getCodexWindowSeconds(windowValue)
    if (seconds === 18000 && !fiveHour) {
      fiveHour = windowValue
    } else if (seconds === 604800 && !weekly) {
      weekly = windowValue
    }
  }

  return {
    fiveHour: fiveHour ?? (primary && primary !== weekly ? primary : null),
    weekly: weekly ?? (secondary && secondary !== fiveHour ? secondary : null)
  }
}

function isCodexQuotaPayloadExhausted(payload: Record<string, unknown>) {
  const rateLimit = readRecord(payload.rate_limit) ?? readRecord(payload.rateLimit)
  if (!rateLimit) {
    return false
  }

  const windows = getCodexWindows(rateLimit)
  const weeklyUsed = getWindowUsedPercent(windows.weekly)
  return weeklyUsed !== null && weeklyUsed >= 99.5
}

async function isSharedAuthExhausted(file: AuthFileItem) {
  if (isDisabledAuthFile(file)) {
    return true
  }
  if (!isCodexLikeAuthFile(file)) {
    return false
  }

  const authIndex = normalizeAuthIndex(file)
  if (!authIndex) {
    return false
  }

  const result = await quotaApi.apiCall({
    authIndex,
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header: {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
    }
  })

  if (result.statusCode === 401 || result.statusCode === 402) {
    return true
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const message = getApiCallErrorMessage(result).toLowerCase()
    return [
      'invalid_token',
      'invalid token',
      'unauthorized',
      'authentication failed',
      'account_deactivated',
      'account disabled',
      'account_disabled',
      'subscription_required',
      'subscription required',
      'payment required'
    ].some((needle) => message.includes(needle))
  }

  const payload = parseResponseJson(result)
  return payload ? isCodexQuotaPayloadExhausted(payload) : false
}

async function checkTrackedSharedAuthsExhausted() {
  const trackedFiles = sharedImportRegistry.list()
  if (trackedFiles.length === 0) {
    return { hasTrackedFiles: false, exhausted: true, usableCount: 0, checkedCount: 0 }
  }

  const response = await quotaApi.listAuthFiles()
  const localFiles = Array.isArray(response.files) ? response.files : []
  const localByName = new Map(localFiles.map((file) => [normalizeAuthFileName(file.name), file]))
  let usableCount = 0
  let checkedCount = 0

  for (const record of trackedFiles) {
    const file = localByName.get(normalizeAuthFileName(record.localFileName))
    if (!file) {
      checkedCount += 1
      continue
    }
    checkedCount += 1
    const exhausted = await isSharedAuthExhausted(file)
    if (!exhausted) {
      usableCount += 1
    }
  }

  return {
    hasTrackedFiles: true,
    exhausted: usableCount === 0,
    usableCount,
    checkedCount
  }
}

function isDirectQrImageUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return false
  }
  try {
    const url = new URL(trimmed)
    return /qrcode/i.test(url.pathname) || /\.(png|jpg|jpeg|webp|gif)$/i.test(url.pathname)
  } catch {
    return false
  }
}

export function UserWorkspace({
  plan,
  features,
  planExpiresAt,
  userKey,
  cloudToken,
  isAdminAccount,
  cpaState,
  normalizingFreeTier,
  onRefreshSession,
  onNotify,
  onError
}: UserWorkspaceProps) {
  const providerTabsContainerRef = useRef<HTMLDivElement | null>(null)
  const providerTabRefs = useRef(new Map<string, HTMLButtonElement>())
  const authImportFileInputRef = useRef<HTMLInputElement | null>(null)
  const [activeProvider, setActiveProvider] = useState<QuotaProvider | 'all'>('all')
  const [vipDialogOpen, setVipDialogOpen] = useState(false)
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false)
  const [loginImportTab, setLoginImportTab] = useState<LoginImportTab>('oauth')
  const [tokenImportProvider, setTokenImportProvider] = useState<TokenImportProvider>('codex')
  const [tokenImportKind, setTokenImportKind] = useState<TokenImportKind>('refresh_token')
  const [tokenJsonImportValue, setTokenJsonImportValue] = useState('')
  const [importingLoginAuth, setImportingLoginAuth] = useState(false)
  const [openAICompatDialogOpen, setOpenAICompatDialogOpen] = useState(false)
  const [codexConfigDialogOpen, setCodexConfigDialogOpen] = useState(false)
  const [continueConfigDialogOpen, setContinueConfigDialogOpen] = useState(false)
  const [sharedPoolInfoOpen, setSharedPoolInfoOpen] = useState(false)
  const [syncingSharedPool, setSyncingSharedPool] = useState(false)
  const [quotaRefreshToken, setQuotaRefreshToken] = useState(0)
  const [autoSharedSyncHours, setAutoSharedSyncHours] = useState(0)
  const autoSharedSyncRunningRef = useRef(false)
  const [openClawIntroOpen, setOpenClawIntroOpen] = useState(false)
  const [openClawDialogOpen, setOpenClawDialogOpen] = useState(false)
  const [runningOpenClawSetup, setRunningOpenClawSetup] = useState(false)
  const [openClawLogs, setOpenClawLogs] = useState<string[]>([])
  const [openClawMode, setOpenClawMode] = useState<OpenClawConfigMode>('modern')
  const [loadingOpenClawState, setLoadingOpenClawState] = useState(false)
  const [openClawModels, setOpenClawModels] = useState<string[]>([])
  const [openClawSelectedModels, setOpenClawSelectedModels] = useState<string[]>([])
  const [openClawPrimaryModel, setOpenClawPrimaryModel] = useState<string>('')
  const [openClawFallbackModels, setOpenClawFallbackModels] = useState<string[]>([])
  const [openClawClearOtherModels, setOpenClawClearOtherModels] = useState(false)
  const openClawSelectionDirtyRef = useRef(false)
  const [kiroDialogOpen, setKiroDialogOpen] = useState(false)
  const [runningKiroProxy, setRunningKiroProxy] = useState(false)
  const [kiroLogs, setKiroLogs] = useState<string[]>([])
  const [kiroProxyResult, setKiroProxyResult] = useState<KiroProxyStartResult | null>(null)
  const [probingKiroModels, setProbingKiroModels] = useState(false)
  const [kiroModels, setKiroModels] = useState<string[]>([])
  const [paymentProducts, setPaymentProducts] = useState<CloudPaymentProduct[]>([])
  const [loadingPaymentProducts, setLoadingPaymentProducts] = useState(false)
  const [preparingVipDialog, setPreparingVipDialog] = useState(false)
  const [creatingPaymentOrder, setCreatingPaymentOrder] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState<string>('')
  const [selectedBillingMonths, setSelectedBillingMonths] = useState<1 | 6 | 12>(1)
  const [paymentQuote, setPaymentQuote] = useState<CloudPaymentQuote | null>(null)
  const [loadingPaymentQuote, setLoadingPaymentQuote] = useState(false)
  const [paymentQuoteCache, setPaymentQuoteCache] = useState<Record<string, CloudPaymentQuote>>({})
  const selectedPaymentProvider = 'xunhu' as const
  const [activePayment, setActivePayment] = useState<CloudCreatePaymentOrderResponse | null>(null)
  const [paymentCheckoutOpen, setPaymentCheckoutOpen] = useState(false)
  const [paymentQrDataUrl, setPaymentQrDataUrl] = useState<string | null>(null)
  const [paymentPollCountdown, setPaymentPollCountdown] = useState(0)
  const [refreshingPaymentStatus, setRefreshingPaymentStatus] = useState(false)
  const [closingPaymentCheckout, setClosingPaymentCheckout] = useState(false)
  const [lastPaymentCheckedAt, setLastPaymentCheckedAt] = useState<string | null>(null)
  const [manualHelpVisible, setManualHelpVisible] = useState(false)
  const paidNotifiedOrderRef = useRef<string | null>(null)
  const closeCodexConfigDialog = useCallback(() => setCodexConfigDialogOpen(false), [])
  const closeContinueConfigDialog = useCallback(() => setContinueConfigDialogOpen(false), [])
  const planLabel = useMemo(() => formatPlanLabel(plan.planCode, plan.name), [plan.name, plan.planCode])
  const formattedPlanExpiresAt = useMemo(() => {
    if (!planExpiresAt) {
      return null
    }
    const value = new Date(planExpiresAt)
    if (Number.isNaN(value.getTime())) {
      return null
    }
    return value.toLocaleString('zh-CN', { hour12: false })
  }, [planExpiresAt])
  const normalizedUserKey = useMemo(() => userKey.trim().toLowerCase(), [userKey])
  const sharedSyncKey = useMemo(() => getSharedSyncStorageKey(normalizedUserKey), [normalizedUserKey])
  const autoSharedSyncKey = useMemo(() => getAutoSharedSyncStorageKey(normalizedUserKey), [normalizedUserKey])
  const autoSharedSyncLastRunKey = useMemo(() => getAutoSharedSyncLastRunKey(normalizedUserKey), [normalizedUserKey])

  const warmupStandardQuotes = useCallback(
    async (productCode: string) => {
      const monthsList: Array<1 | 6 | 12> = [1, 6, 12]
      const missing = monthsList.filter((months) => !paymentQuoteCache[buildQuoteCacheKey(productCode, months, 'standard')])
      if (missing.length === 0) {
        return
      }

      const responses = await Promise.all(
        missing.map(async (months) => {
          const response = await cloudClient.quotePaymentOrder(cloudToken, {
            product_code: productCode,
            billing_months: months,
            purchase_mode: 'standard'
          })
          return { months, quote: response.quote }
        })
      )

      setPaymentQuoteCache((current) => {
        const next = { ...current }
        responses.forEach(({ months, quote }) => {
          next[buildQuoteCacheKey(productCode, months, 'standard')] = quote
        })
        return next
      })
    },
    [cloudToken, paymentQuoteCache]
  )

  const refreshPaymentQuotesForProduct = useCallback(
    async (productCode: string) => {
      const monthsList: Array<1 | 6 | 12> = [1, 6, 12]
      try {
        setLoadingPaymentQuote(true)
        setPaymentQuoteCache((current) => {
          const next = { ...current }
          monthsList.forEach((months) => {
            delete next[buildQuoteCacheKey(productCode, months, 'standard')]
          })
          return next
        })

        const responses = await Promise.all(
          monthsList.map(async (months) => {
            const response = await cloudClient.quotePaymentOrder(cloudToken, {
              product_code: productCode,
              billing_months: months,
              purchase_mode: 'standard'
            })
            return { months, quote: response.quote }
          })
        )

        setPaymentQuoteCache((current) => {
          const next = { ...current }
          responses.forEach(({ months, quote }) => {
            next[buildQuoteCacheKey(productCode, months, 'standard')] = quote
          })
          return next
        })

        const selectedQuote = responses.find(({ months }) => months === selectedBillingMonths)?.quote ?? null
        setPaymentQuote(selectedQuote)
      } finally {
        setLoadingPaymentQuote(false)
      }
    },
    [cloudToken, selectedBillingMonths]
  )

  const ensurePaymentProductsLoaded = useCallback(async () => {
    if (paymentProducts.length > 0) {
      return paymentProducts
    }
    setLoadingPaymentProducts(true)
    try {
      const response = await cloudClient.listPaymentProducts(cloudToken)
      const products = response.products ?? []
      setPaymentProducts(products)
      return products
    } finally {
      setLoadingPaymentProducts(false)
    }
  }, [cloudToken, paymentProducts])

  useEffect(() => {
    if (!isAdminAccount) {
      setAutoSharedSyncHours(0)
      return
    }

    const storedHours = Number(window.localStorage.getItem(autoSharedSyncKey) || '0')
    const allowedHours = autoSharedSyncOptions.some((option) => option.hours === storedHours) ? storedHours : 0
    setAutoSharedSyncHours(allowedHours)
  }, [autoSharedSyncKey, isAdminAccount])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void cpaRuntime.onOpenClawSetupLog((line) => {
      if (disposed) return
      setOpenClawLogs((current) => [...current, line])
    }).then((cleanup) => {
      if (disposed) {
        cleanup()
        return
      }
      unlisten = cleanup
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void cpaRuntime.onKiroProxyLog((line) => {
      if (disposed) return
      setKiroLogs((current) => [...current, line])
    }).then((cleanup) => {
      if (disposed) {
        cleanup()
        return
      }
      unlisten = cleanup
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (activeProvider === 'all') {
      providerTabsContainerRef.current?.scrollTo({
        left: 0,
        behavior: 'smooth'
      })
      return
    }
    const key = activeProvider
    const node = providerTabRefs.current.get(key)
    node?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest'
    })
  }, [activeProvider])

  useEffect(() => {
    let cancelled = false

    const loadProducts = async () => {
      try {
        const products = await ensurePaymentProductsLoaded()
        if (cancelled) {
          return
        }
        setSelectedProductCode((current) => {
          if (current && products.some((product) => product.productCode === current)) {
            return current
          }
          return products.find((product) => product.planCode === 'vip1')?.productCode ?? products[0]?.productCode ?? ''
        })
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : String(error))
        }
      }
    }

    void loadProducts()
    return () => {
      cancelled = true
    }
  }, [ensurePaymentProductsLoaded, onError])

  useEffect(() => {
    let cancelled = false

    const buildQr = async () => {
      if (!activePayment?.checkout.codeUrl) {
        setPaymentQrDataUrl(null)
        return
      }
      try {
        if (isDirectQrImageUrl(activePayment.checkout.codeUrl)) {
          if (!cancelled) {
            setPaymentQrDataUrl(activePayment.checkout.codeUrl)
          }
          return
        }
        const dataUrl = await QRCode.toDataURL(activePayment.checkout.codeUrl, {
          margin: 1,
          width: 260
        })
        if (!cancelled) {
          setPaymentQrDataUrl(dataUrl)
        }
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : String(error))
        }
      }
    }

    void buildQr()
    return () => {
      cancelled = true
    }
  }, [activePayment, onError])

  useEffect(() => {
    if (!activePayment?.order?.orderNo) {
      setPaymentPollCountdown(0)
      return
    }
    if (activePayment.order.status === 'paid' || activePayment.order.status === 'closed' || activePayment.order.status === 'failed' || activePayment.order.status === 'refunded') {
      setPaymentPollCountdown(0)
      if (activePayment.order.status === 'paid' && paidNotifiedOrderRef.current !== activePayment.order.orderNo) {
        paidNotifiedOrderRef.current = activePayment.order.orderNo
        onNotify('支付成功，会员状态已更新')
        void onRefreshSession()
      }
      return
    }

    let cancelled = false
    setPaymentPollCountdown(3)
    const countdownTimer = window.setInterval(() => {
      setPaymentPollCountdown((current) => (current <= 1 ? 3 : current - 1))
    }, 1000)
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await cloudClient.getPaymentOrder(cloudToken, activePayment.order.orderNo)
          if (cancelled) {
            return
          }
          setLastPaymentCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
          setPaymentPollCountdown(3)
          setActivePayment((current) => {
            if (!current || current.order.orderNo !== response.order.orderNo) {
              return current
            }
            return {
              ...current,
              order: response.order
            }
          })
          if (response.order.status === 'paid') {
            if (paidNotifiedOrderRef.current !== response.order.orderNo) {
              paidNotifiedOrderRef.current = response.order.orderNo
              onNotify('支付成功，会员状态已更新')
              await onRefreshSession()
            }
          }
        } catch (error) {
          if (!cancelled) {
            onError(error instanceof Error ? error.message : String(error))
          }
        }
      })()
    }, 3000)

    return () => {
      cancelled = true
      setPaymentPollCountdown(0)
      window.clearInterval(timer)
      window.clearInterval(countdownTimer)
    }
  }, [activePayment, cloudToken, onError, onNotify, onRefreshSession])

  const selectedProduct = useMemo(
    () => paymentProducts.find((product) => product.productCode === selectedProductCode) ?? null,
    [paymentProducts, selectedProductCode]
  )

  const upgradingToProMax = plan.planCode === 'vip1' && selectedProduct?.planCode === 'vip2'
  const downgradeBlocked = plan.planCode === 'vip2' && selectedProduct?.planCode === 'vip1'
  const billingQuotes = useMemo(() => {
    if (!selectedProductCode) {
      return {}
    }
    return {
      1: paymentQuoteCache[buildQuoteCacheKey(selectedProductCode, 1, 'standard')],
      6: paymentQuoteCache[buildQuoteCacheKey(selectedProductCode, 6, 'standard')],
      12: paymentQuoteCache[buildQuoteCacheKey(selectedProductCode, 12, 'standard')]
    } satisfies Partial<Record<1 | 6 | 12, CloudPaymentQuote>>
  }, [paymentQuoteCache, selectedProductCode])

  const paymentStatusLabel = useMemo(() => {
    switch (activePayment?.order.status) {
      case 'paid':
        return '已支付'
      case 'closed':
        return '已关闭'
      case 'failed':
        return '支付失败'
      case 'refunded':
        return '已退款'
      case 'pending':
        return '待支付'
      default:
        return '未创建订单'
    }
  }, [activePayment])

  useEffect(() => {
    if (!vipDialogOpen || !selectedProductCode) {
      return
    }
    let cancelled = false
    const loadQuote = async () => {
      const quoteKey = buildQuoteCacheKey(
        selectedProductCode,
        selectedBillingMonths,
        'standard'
      )
      const cached = paymentQuoteCache[quoteKey]
      if (cached) {
        setPaymentQuote(cached)
        setLoadingPaymentQuote(false)
        return
      }
      try {
        setLoadingPaymentQuote(true)
        const response = await cloudClient.quotePaymentOrder(cloudToken, {
          product_code: selectedProductCode,
          billing_months: selectedBillingMonths,
          purchase_mode: 'standard'
        })
        if (cancelled) {
          return
        }
        setPaymentQuoteCache((current) => ({
          ...current,
          [quoteKey]: response.quote
        }))
        setPaymentQuote(response.quote)
      } catch (error) {
        if (!cancelled) {
          setPaymentQuote(null)
          onError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) {
          setLoadingPaymentQuote(false)
        }
      }
    }
    void loadQuote()
    return () => {
      cancelled = true
    }
  }, [cloudToken, onError, paymentQuoteCache, selectedBillingMonths, selectedProductCode, vipDialogOpen])

  useEffect(() => {
    if (!vipDialogOpen || !selectedProductCode) {
      return
    }

    const warmupQuotes = async () => {
      try {
        await warmupStandardQuotes(selectedProductCode)
      } catch {
        // keep current quote flow working even if warmup partially fails
      }
    }

    void warmupQuotes()
  }, [selectedProductCode, vipDialogOpen, warmupStandardQuotes])

  const loadOpenClawConfigState = useCallback(async () => {
    openClawSelectionDirtyRef.current = false
    setLoadingOpenClawState(true)
    try {
      const result = await cpaRuntime.getOpenClawConfigState()
      const models = result.availableModels
      setOpenClawModels(models)
      setOpenClawSelectedModels(models)
      const primary = result.recommendedPrimaryModel ?? models[0] ?? ''
      setOpenClawPrimaryModel(primary)
      setOpenClawFallbackModels(models.filter((model) => model !== primary))
      setOpenClawClearOtherModels(false)
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setLoadingOpenClawState(false)
    }
  }, [onError])

  const handleOpenClawIntro = useCallback(async () => {
    const loaded = await loadOpenClawConfigState()
    if (loaded) {
      setOpenClawIntroOpen(true)
    }
  }, [loadOpenClawConfigState])

  const hasPendingPayment = activePayment?.order.status === 'pending'
  const mobileProviderOrder: (QuotaProvider | 'all')[] = ['all', 'codex', 'claude', 'gemini-cli', 'antigravity', 'kimi']

  const paymentExpiresCountdown = useMemo(() => {
    if (!activePayment?.order.expiresAt || activePayment.order.status !== 'pending') {
      return null
    }
    const expiresAt = new Date(activePayment.order.expiresAt).getTime()
    const remainingMs = Math.max(0, expiresAt - Date.now())
    const totalSeconds = Math.floor(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }, [activePayment, paymentPollCountdown, lastPaymentCheckedAt])

  const paymentExpiredLocally = useMemo(() => {
    if (!activePayment?.order.expiresAt || activePayment.order.status !== 'pending') {
      return false
    }
    return new Date(activePayment.order.expiresAt).getTime() <= Date.now()
  }, [activePayment, paymentPollCountdown, lastPaymentCheckedAt])

  const paymentPollingHint = useMemo(() => {
    if (!activePayment) {
      return '创建订单后会显示微信支付二维码。'
    }
    if (activePayment.order.status === 'paid') {
      return '支付已完成，会员权益已经开通。'
    }
    if (paymentExpiredLocally || activePayment.order.status === 'closed' || activePayment.order.status === 'failed' || activePayment.order.status === 'refunded') {
      return '当前订单已失效，请返回重新发起支付。'
    }
    if (paymentExpiresCountdown) {
      return `支付剩余时间 ${paymentExpiresCountdown}`
    }
    return '正在确认支付状态。'
  }, [activePayment, paymentExpiredLocally, paymentExpiresCountdown])

  const handleRefreshPaymentOrder = async () => {
    if (!activePayment?.order.orderNo) {
      return
    }
    try {
      setRefreshingPaymentStatus(true)
      onError(null)
      const response = await cloudClient.getPaymentOrder(cloudToken, activePayment.order.orderNo)
      setLastPaymentCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      setPaymentPollCountdown(3)
      setActivePayment((current) => {
        if (!current || current.order.orderNo !== response.order.orderNo) {
          return current
        }
        return {
          ...current,
          order: response.order
        }
      })
      if (response.order.status === 'paid' && paidNotifiedOrderRef.current !== response.order.orderNo) {
        paidNotifiedOrderRef.current = response.order.orderNo
        onNotify('支付成功，会员状态已更新')
        await onRefreshSession()
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshingPaymentStatus(false)
    }
  }

  const handleCreatePaymentOrder = async () => {
    if (!selectedProductCode) {
      onError('请先选择要购买的套餐')
      return
    }
    try {
      setCreatingPaymentOrder(true)
      onError(null)
      const response = await cloudClient.createPaymentOrder(cloudToken, {
        product_code: selectedProductCode,
        provider: selectedPaymentProvider,
        billing_months: selectedBillingMonths,
        purchase_mode: 'standard'
      })
      paidNotifiedOrderRef.current = null
      if (!response.checkout.paymentEnabled) {
        onError(response.checkout.message || '当前支付通道未启用')
        return
      }
      if (!response.checkout.codeUrl) {
        onError('支付通道未返回二维码地址')
        return
      }
      setActivePayment(response)
      setPaymentCheckoutOpen(true)
      setLastPaymentCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      setPaymentPollCountdown(3)
      onNotify('已创建虎皮椒支付订单')
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreatingPaymentOrder(false)
    }
  }

  const handleOpenVipDialog = async () => {
    try {
      setPreparingVipDialog(true)
      setManualHelpVisible(false)
      setSelectedBillingMonths(1)
      setPaymentCheckoutOpen(false)
      onError(null)

      const products = await ensurePaymentProductsLoaded()
      const preferredPlanCode = plan.planCode === 'vip2' ? 'vip2' : 'vip1'
      const defaultProductCode =
        products.find((product) => product.planCode === preferredPlanCode)?.productCode ??
        products.find((product) => product.planCode === 'vip1')?.productCode ??
        products[0]?.productCode ??
        ''

      if (!defaultProductCode) {
        onError('当前没有可购买套餐')
        return
      }

      setSelectedProductCode(defaultProductCode)
      await warmupStandardQuotes(defaultProductCode)
      setVipDialogOpen(true)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreparingVipDialog(false)
    }
  }

  const handleCloseVipDialog = () => {
    setVipDialogOpen(false)
  }

  const handleClosePaymentCheckout = async () => {
    if (activePayment?.order.orderNo && activePayment.order.status === 'pending') {
      try {
        setClosingPaymentCheckout(true)
        const response = await cloudClient.cancelPaymentOrder(cloudToken, activePayment.order.orderNo)
        setActivePayment((current) => (current ? { ...current, order: response.order } : current))
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        setClosingPaymentCheckout(false)
      }
    }
    setPaymentCheckoutOpen(false)
  }

  const handleSharedPoolAction = useCallback(async (options?: { silent?: boolean; scheduled?: boolean }) => {
    const latestSession = await onRefreshSession()
    const effectiveFeatures = latestSession?.features ?? features

    if (!effectiveFeatures.allow_shared_pool) {
      if (!options?.silent) {
        setVipDialogOpen(true)
      }
      return false
    }
    if (cpaState?.status !== 'running') {
      if (!options?.silent) {
        onError('请先启动本地代理，再同步共享号池。')
      }
      return false
    }

    try {
      setSyncingSharedPool(true)
      onError(null)
      if (effectiveFeatures.shared_pool_mode === 'sample') {
        const currentSharedState = await checkTrackedSharedAuthsExhausted()
        if (currentSharedState.hasTrackedFiles && !currentSharedState.exhausted) {
          if (!options?.silent) {
            onError(`当前还有 ${currentSharedState.usableCount} 个共享账号可用，全部用完后才能重新获取账号。`)
          }
          return false
        }
      }

      const syncPackage = await cloudClient.getSharedSyncPackage(cloudToken)
      const sharedFiles = Array.isArray(syncPackage.files) ? syncPackage.files : []
      if (sharedFiles.length === 0) {
        if (!options?.silent) {
          onNotify('当前共享号池没有可同步的认证文件')
        }
        return true
      }

      const existingShared = sharedImportRegistry.list()
      for (const record of existingShared) {
        try {
          await authFilesApi.deleteFile(record.localFileName)
        } catch {
          // ignore stale local shared entries
        }
      }
      sharedImportRegistry.clear()

      for (const file of sharedFiles) {
        const download = await cloudClient.downloadSharedAuthFile(cloudToken, file.id)
        const localFileName = buildSharedLocalFileName(download.fileName)
        await cpaRuntime.importAuthFiles([
          {
            name: localFileName,
            bytes: download.bytes
          }
        ])
        sharedImportRegistry.upsert({
          cloudFileId: file.id,
          localFileName,
          downloadedAt: new Date().toISOString(),
          planRequired: file.planRequired
        })
      }

      window.localStorage.setItem(sharedSyncKey, String(Date.now()))
      setQuotaRefreshToken((current) => current + 1)
      onNotify(options?.scheduled ? `自动获取账号完成：已同步 ${sharedFiles.length} 个共享认证文件到本地` : `已同步 ${sharedFiles.length} 个共享认证文件到本地`)
      return true
    } catch (error) {
      if (!options?.silent) {
        onError(error instanceof Error ? error.message : String(error))
      }
      return false
    } finally {
      setSyncingSharedPool(false)
    }
  }, [cloudToken, cpaState?.status, features, onError, onNotify, onRefreshSession, sharedSyncKey])

  const importLoginAuthFiles = useCallback(
    async (files: ImportAuthInputFile[], successMessage: string) => {
      if (cpaState?.status !== 'running') {
        onError('请先启动本地代理，再导入认证。')
        return false
      }
      try {
        setImportingLoginAuth(true)
        onError(null)
        const result = await cpaRuntime.importAuthFiles(files)
        setQuotaRefreshToken((current) => current + 1)
        onNotify(`${successMessage}${result.extractedCount ? `，识别 ${result.extractedCount} 个文件` : ''}`)
        return true
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setImportingLoginAuth(false)
      }
    },
    [cpaState?.status, onError, onNotify]
  )

  const handleImportTokenJsonAuth = useCallback(async () => {
    const raw = tokenJsonImportValue.trim()
    if (!raw) {
      onError('请先粘贴 Token 或认证 JSON。')
      return
    }
    let parsed: unknown
    let shouldImportAsJson = false
    try {
      parsed = normalizePastedJsonAuth(raw)
      shouldImportAsJson = Boolean(parsed && typeof parsed === 'object')
    } catch {
      parsed = raw
    }
    if (shouldImportAsJson) {
      const provider = inferAuthImportProvider(parsed)
      const imported = await importLoginAuthFiles(
        [encodeImportFile(buildAuthImportFileName(`pasted-${provider}`), JSON.stringify(parsed, null, 2))],
        'JSON 认证已导入'
      )
      if (imported) {
        setTokenJsonImportValue('')
      }
      return
    }
    const token = typeof parsed === 'string' ? parsed.trim() : raw
    if (!token) {
      onError('没有识别到可导入的 Token 或 JSON。')
      return
    }
    const tokenPayload = {
      provider: tokenImportProvider,
      type: tokenImportProvider,
      token_type: 'bearer',
      [tokenImportKind]: token,
      metadata: {
        [tokenImportKind]: token
      }
    }
    const imported = await importLoginAuthFiles(
      [
        encodeImportFile(
          buildAuthImportFileName(`${tokenImportProvider}-${tokenImportKind.replace('_', '-')}`),
          JSON.stringify(tokenPayload, null, 2)
        )
      ],
      'Token 认证已导入'
    )
    if (imported) {
      setTokenJsonImportValue('')
    }
  }, [importLoginAuthFiles, onError, tokenImportKind, tokenImportProvider, tokenJsonImportValue])

  const handleImportJsonAuthFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.target.files ?? [])
      event.target.value = ''
      if (selectedFiles.length === 0) {
        return
      }
      const validFiles = selectedFiles.filter((file) => file.name.toLowerCase().endsWith('.json'))
      if (validFiles.length === 0) {
        onError('请选择 .json 认证文件。')
        return
      }
      try {
        setImportingLoginAuth(true)
        const payload = await Promise.all(
          validFiles.map(async (file) => ({
            name: file.name,
            bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
          }))
        )
        await importLoginAuthFiles(payload, validFiles.length > 1 ? `已导入 ${validFiles.length} 个认证文件` : '认证文件已导入')
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
      } finally {
        setImportingLoginAuth(false)
      }
    },
    [importLoginAuthFiles, onError]
  )

  const handleAutoSharedSyncChange = useCallback(
    (hours: number) => {
      setAutoSharedSyncHours(hours)
      if (hours > 0) {
        window.localStorage.setItem(autoSharedSyncKey, String(hours))
        onNotify(`已开启自动获取账号：每 ${hours} 小时执行一次`)
        return
      }

      window.localStorage.removeItem(autoSharedSyncKey)
      window.localStorage.removeItem(autoSharedSyncLastRunKey)
      onNotify('已关闭自动获取账号')
    },
    [autoSharedSyncKey, autoSharedSyncLastRunKey, onNotify]
  )

  useEffect(() => {
    if (!isAdminAccount || autoSharedSyncHours <= 0 || !features.allow_shared_pool) {
      return
    }

    const intervalMs = autoSharedSyncHours * 60 * 60 * 1000
    const tick = () => {
      if (autoSharedSyncRunningRef.current || syncingSharedPool) {
        return
      }
      const lastRun = Number(window.localStorage.getItem(autoSharedSyncLastRunKey) || '0')
      if (lastRun > 0 && Date.now() - lastRun < intervalMs) {
        return
      }

      autoSharedSyncRunningRef.current = true
      void handleSharedPoolAction({ silent: true, scheduled: true })
        .then((completed) => {
          if (completed) {
            window.localStorage.setItem(autoSharedSyncLastRunKey, String(Date.now()))
          }
        })
        .finally(() => {
          autoSharedSyncRunningRef.current = false
        })
    }

    tick()
    const timer = window.setInterval(tick, 60 * 1000)
    return () => window.clearInterval(timer)
  }, [
    autoSharedSyncHours,
    autoSharedSyncLastRunKey,
    features.allow_shared_pool,
    handleSharedPoolAction,
    isAdminAccount,
    syncingSharedPool
  ])

  const toggleOpenClawSelectedModel = (model: string) => {
    openClawSelectionDirtyRef.current = true
    setOpenClawSelectedModels((current) => {
      const next = current.includes(model)
        ? current.filter((item) => item !== model)
        : [...current, model]
      if (!next.includes(openClawPrimaryModel)) {
        setOpenClawPrimaryModel(next[0] ?? '')
      }
      setOpenClawFallbackModels((fallbacks) =>
        fallbacks.filter((item) => next.includes(item) && item !== openClawPrimaryModel)
      )
      return next
    })
  }

  const toggleOpenClawFallbackModel = (model: string) => {
    openClawSelectionDirtyRef.current = true
    setOpenClawFallbackModels((current) =>
      current.includes(model)
        ? current.filter((item) => item !== model)
        : [...current, model]
    )
  }

  const handleOpenClawSetup = async () => {
    setOpenClawIntroOpen(false)
    setOpenClawDialogOpen(true)
    setOpenClawLogs(['准备开始接入 OpenClaw...'])
    setRunningOpenClawSetup(true)
    onError(null)
    try {
      const result = await cpaRuntime.setupOpenClawProvider({
        mode: openClawMode,
        selectedModels: openClawMode === 'modern' ? openClawSelectedModels : [],
        primaryModel: openClawMode === 'modern' ? openClawPrimaryModel || null : null,
        fallbackModels: openClawMode === 'modern' ? openClawFallbackModels : [],
        clearOtherModels: openClawMode === 'modern' ? openClawClearOtherModels : false
      })
      onNotify(`OpenClaw 接入完成，已写入 ${result.modelCount} 个模型`)
      setOpenClawLogs((current) => [
        ...current,
        `接入完成：provider=${result.providerId}，alias=${result.alias}`,
        `配置文件：${result.configPath}`
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onError(message)
      setOpenClawLogs((current) => [...current, `失败：${message}`])
    } finally {
      setRunningOpenClawSetup(false)
    }
  }

  const handleKiroProxySetup = async () => {
    setKiroDialogOpen(true)
    setKiroProxyResult(null)
    setKiroModels([])
    setKiroLogs(['准备安装并启动 9router...'])
    setRunningKiroProxy(true)
    onError(null)
    try {
      const result = await cpaRuntime.startKiroProxy()
      setKiroProxyResult(result)
      setKiroLogs((current) => [
        ...current,
        result.alreadyRunning ? '已复用正在运行的 9router。' : '9router 反代已启动。',
        `代理地址：${result.baseUrl}`,
        `API Key：${result.apiKey}`
      ])
      onNotify('Kiro 反代已开启')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onError(message)
      setKiroLogs((current) => [...current, `失败：${message}`])
    } finally {
      setRunningKiroProxy(false)
    }
  }

  const handleProbeKiroModels = async () => {
    setProbingKiroModels(true)
    onError(null)
    try {
      const result = await cpaRuntime.probeKiroModels()
      setKiroModels(result.models)
      setKiroLogs((current) => [
        ...current,
        `模型探查完成：${result.models.length} 个`,
        ...result.models.map((model) => `- ${model}`)
      ])
      onNotify(`已探查到 ${result.models.length} 个 Kiro 模型`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onError(message)
      setKiroLogs((current) => [...current, `模型探查失败：${message}`])
    } finally {
      setProbingKiroModels(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-col gap-3 px-3 py-3">
      <div className="w-full bg-base-100 rounded-2xl p-4 mb-4 shadow-sm">
        <div className="flex justify-between items-center text-sm font-bold mb-2">
          <span className="truncate mr-2">{userKey}</span>
          <div className="flex gap-2 shrink-0">
            <div className={`badge badge-outline badge-sm ${getStatusTone(cpaState?.status)}`}>
              {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
            </div>
            <div className={`badge badge-sm border-none font-bold ${
              planLabel.toLowerCase().includes('max') ? 'bg-warning text-warning-content' : 
              planLabel.toLowerCase().includes('pro') ? 'bg-primary text-primary-content' : 
              'bg-info text-info-content'
            }`}>
              {planLabel}
            </div>
          </div>
        </div>
        {formattedPlanExpiresAt ? (
          <p className="text-xs text-base-content/60 mt-1">到期时间 {formattedPlanExpiresAt}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-2 w-full mb-2 px-4">
        <button
          className={`btn btn-xs h-8 rounded-lg border-none shadow-sm ${features.allow_shared_pool ? 'btn-success text-success-content' : 'btn-outline'}`}
          onClick={() => void handleSharedPoolAction()}
          disabled={syncingSharedPool}
        >
          {syncingSharedPool ? <span className="loading loading-spinner loading-xs" /> : null}
          获取账号
        </button>

        <button
          className="btn btn-neutral btn-xs h-8 rounded-lg border-none shadow-sm"
          disabled={runningOpenClawSetup || loadingOpenClawState}
          onClick={() => void handleOpenClawIntro()}
        >
          {loadingOpenClawState ? <span className="loading loading-spinner loading-xs" /> : null}
          OpenClaw
        </button>

        <button
          className="btn btn-neutral btn-xs h-8 rounded-lg border-none shadow-sm"
          disabled={runningKiroProxy}
          onClick={() => setKiroDialogOpen(true)}
        >
          {runningKiroProxy ? <span className="loading loading-spinner loading-xs" /> : null}
          Kiro反代
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 w-full mb-2 px-4">
        <button 
          className="btn btn-primary btn-xs h-8 rounded-lg border-none shadow-sm" 
          onClick={() => void handleOpenVipDialog()} 
          disabled={preparingVipDialog}
        >
          开通会员
        </button>
      </div>

      {isAdminAccount ? (
        <div className="w-full mb-2 px-4">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
            <span className="text-xs font-semibold text-base-content/70">自动获取账号</span>
            <select
              className="select select-bordered select-xs h-8 min-h-8 w-28 rounded-lg"
              value={autoSharedSyncHours}
              onChange={(event) => handleAutoSharedSyncChange(Number(event.target.value))}
            >
              {autoSharedSyncOptions.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 w-full mb-6 px-4">
        <button
          className="btn btn-neutral btn-xs h-8 rounded-lg border-none shadow-sm"
          onClick={() => setOpenAICompatDialogOpen(true)}
        >
          OpenAI兼容
        </button>
        <button
          className="btn btn-neutral btn-xs h-8 rounded-lg border-none shadow-sm"
          onClick={() => setCodexConfigDialogOpen(true)}
        >
          Codex配置
        </button>
        <button
          className="btn btn-neutral btn-xs h-8 rounded-lg border-none shadow-sm col-span-2"
          onClick={() => setContinueConfigDialogOpen(true)}
        >
          Continue配置
        </button>
      </div>

      {normalizingFreeTier ? (
        <div className="alert alert-warning py-2 text-sm mx-4 mb-4 w-auto">
          <span>正在按免费版规则整理认证文件。</span>
        </div>
      ) : null}

      <div className="w-full px-4 mb-4">
        <div ref={providerTabsContainerRef} className="overflow-x-auto scrollbar-none flex gap-2 w-full">
          {mobileProviderOrder.map((provider) => {
            const active = provider === activeProvider
            const label = provider === 'all' ? '全部' : PROVIDER_META[provider].label
            return (
              <button
                key={provider}
                ref={(node) => {
                  if (node) {
                    providerTabRefs.current.set(provider, node)
                  } else {
                    providerTabRefs.current.delete(provider)
                  }
                }}
                className={`text-sm whitespace-nowrap transition-colors outline-none px-3 py-1.5 rounded-full ${active ? 'bg-base-content/10 text-base-content font-bold' : 'text-base-content/50 hover:text-base-content/80'}`}
                onClick={() => setActiveProvider(provider)}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3 w-full pb-8 px-4">
        <QuotaPanel
            cpaRunning={cpaState?.status === 'running'}
            activeProvider={activeProvider}
            refreshToken={quotaRefreshToken}
            showHeader={false}
            compactUserMode
            maxEnabledAuthFiles={features.max_enabled_auth_files}
            allowAutoRotation={features.allow_auto_rotation}
            onUpgradeVip={handleOpenVipDialog}
            onOpenOauth={() => setOauthDialogOpen(true)}
            onNotify={onNotify}
            onError={onError}
          />
      </div>

      <dialog className={`modal ${vipDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">开通会员</h3>
            </div>
            <button className="btn btn-ghost btn-sm btn-circle" onClick={handleCloseVipDialog}>
              ✕
            </button>
          </div>
          <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-2.5">
                {loadingPaymentProducts ? (
                  <div className="col-span-2 flex items-center gap-2 text-sm text-base-content/60">
                    <span className="loading loading-spinner loading-xs"></span>
                    正在加载可购买套餐
                  </div>
                ) : null}
                {paymentProducts.map((product) => {
                  const active = product.productCode === selectedProductCode
                  const disabled = hasPendingPayment || (plan.planCode === 'vip2' && product.planCode === 'vip1')
                  return (
                    <button
                      key={product.id}
                      className={`rounded-2xl border p-3 text-left transition ${active ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/15' : 'border-base-300 bg-base-100'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                      onClick={() => {
                        if (disabled) return
                        if (product.productCode === selectedProductCode) return
                        setSelectedProductCode(product.productCode)
                        setPaymentQuote(null)
                        void refreshPaymentQuotesForProduct(product.productCode).catch((error) => {
                          onError(error instanceof Error ? error.message : String(error))
                        })
                      }}
                      disabled={disabled}
                    >
                      <div className="text-lg font-semibold leading-none">{product.displayName}</div>
                    </button>
                  )
                })}
              </div>

              <div className="rounded-box border border-base-300 bg-base-100 p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">购买方案</div>
                  {loadingPaymentQuote ? (
                    <div className="flex items-center gap-1 text-xs text-base-content/55">
                      <span className="loading loading-spinner loading-xs" />
                      获取价格中
                    </div>
                  ) : null}
                </div>
                <div className="space-y-3">
                  <div className="space-y-2.5">
                    {[1, 6, 12].map((months) => {
                      const quote = billingQuotes[months as 1 | 6 | 12]
                      const originalAmount = ((selectedProduct?.priceAmount ?? 0) * months) / 100
                      const label = months === 1 ? '\u6708\u4ed8' : months === 6 ? '\u534a\u5e74\u4ed8' : '\u5e74\u4ed8'

                      return (
                        <button
                          key={months}
                          className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition ${
                            selectedBillingMonths === months
                              ? 'border-primary bg-primary/8 ring-1 ring-primary/20'
                              : 'border-base-300 bg-base-100'
                          }`}
                          onClick={() => setSelectedBillingMonths(months as 1 | 6 | 12)}
                          disabled={hasPendingPayment || downgradeBlocked}
                        >
                          <div className="min-w-0">
                            <div className="text-base font-semibold">{label}</div>
                            {months === 6 || months === 12 ? (
                              <div className="mt-1 text-xs text-base-content/55">
                                <span className="line-through">{'\u539f\u4ef7 \u00a5'}{originalAmount.toFixed(2)}</span>
                                <span className="mx-1.5 text-base-content/30">{'\u00b7'}</span>
                                <span className="font-semibold text-warning">{months === 6 ? '85\u6298' : '7\u6298'}</span>
                              </div>
                            ) : (
                              <div className="mt-1 text-xs text-base-content/40">{'\u6807\u51c6\u4ef7\u683c'}</div>
                            )}
                          </div>
                          <div className="ml-4 min-w-[104px] text-right">
                            {quote ? (
                              <div className="text-xl font-black">{'\u00a5'}{(quote.amount / 100).toFixed(2)}</div>
                            ) : loadingPaymentQuote ? (
                              <div className="flex items-center justify-end gap-1 text-xs text-base-content/55">
                                <span className="loading loading-spinner loading-xs" />
                                {'\u52a0\u8f7d\u4e2d...'}
                              </div>
                            ) : null}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  {upgradingToProMax ? (
                    <div className="rounded-2xl border border-error/40 bg-error/10 px-3 py-3 text-xs leading-6 text-error">
                      重新升级订阅会覆盖旧订阅，确定操作吗？如有费用疑问请添加人工协助。
                    </div>
                  ) : null}
                  {downgradeBlocked ? <p className="text-xs text-error">您当前已是 ProMax 用户。</p> : null}
                </div>
                <div className="rounded-2xl bg-base-200/70 px-3 py-3 text-sm text-base-content/75">
                  {selectedProduct?.planCode === 'vip2'
                    ? '支持最多 10 个共享账号、自动切换、云端备份。'
                    : '支持自动切换、个人云同步、共享号池随机 3 个。'}
                </div>
              </div>

              <div className="rounded-box border border-base-300 bg-base-100 p-4">
                <div className="text-sm font-semibold">支付方式</div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={creatingPaymentOrder || !selectedProduct || hasPendingPayment || !paymentQuote || downgradeBlocked}
                    onClick={() => void handleCreatePaymentOrder()}
                  >
                    {creatingPaymentOrder ? <span className="loading loading-spinner loading-xs"></span> : null}
                    {hasPendingPayment ? '当前订单处理中' : '微信支付'}
                  </button>
                  <button
                    className="btn btn-disabled btn-sm"
                    disabled
                    title="正在开通中..."
                  >
                    支付宝支付
                  </button>
                </div>
              </div>
              <div className="rounded-box bg-base-200/60 p-4 text-sm text-base-content/70">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>人工协助</div>
                  <button className="btn btn-outline btn-sm" onClick={() => setManualHelpVisible((value) => !value)}>
                    {manualHelpVisible ? '收起人工协助' : '展开人工协助'}
                  </button>
                </div>
                {manualHelpVisible ? (
                  <div className="mt-4 grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
                    <div className="rounded-box border border-base-300 bg-base-100 p-3">
                      <img
                        src={vipQrImage}
                        alt="人工开通二维码"
                        className="h-full w-full rounded-box object-cover"
                      />
                    </div>
                    <div className="space-y-3">
                      <div>
                        <div className="font-semibold text-base-content">人工协助说明</div>
                        <div className="mt-1">扫码后说明账号和所需套餐，管理员会在后台协助处理。</div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${paymentCheckoutOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-4xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">立即支付</h3>
              <p className="mt-1 text-sm text-base-content/55">请使用微信扫码完成支付</p>
            </div>
            <button className="btn btn-ghost btn-sm btn-circle" onClick={() => void handleClosePaymentCheckout()} disabled={closingPaymentCheckout}>
              {closingPaymentCheckout ? <span className="loading loading-spinner loading-xs" /> : '✕'}
            </button>
          </div>

          <div className="mt-4 grid gap-5 md:grid-cols-[300px_minmax(0,1fr)]">
            <div className="rounded-[28px] border border-success/20 bg-success/5 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-success">微信支付</div>
                  <div className="mt-1 text-xs text-base-content/55">请使用微信扫一扫完成付款</div>
                </div>
                <div className="badge badge-success badge-outline">微信</div>
              </div>
              <div className="flex min-h-[290px] items-center justify-center rounded-[24px] bg-base-100 p-4 shadow-sm">
                {activePayment?.order.status === 'paid' ? (
                  <div className="space-y-4 text-center">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-3xl text-success">✓</div>
                    <div className="text-lg font-semibold">支付成功</div>
                    <div className="text-sm text-base-content/60">会员权益已经到账</div>
                  </div>
                ) : paymentExpiredLocally || activePayment?.order.status === 'closed' || activePayment?.order.status === 'failed' || activePayment?.order.status === 'refunded' ? (
                  <div className="space-y-3 text-center">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-warning/15 text-3xl text-warning">!</div>
                    <div className="text-lg font-semibold">订单已失效</div>
                    <div className="text-sm text-base-content/60">请关闭窗口后重新发起支付</div>
                  </div>
                ) : paymentQrDataUrl ? (
                  <img src={paymentQrDataUrl} alt="支付二维码" className="h-64 w-64 rounded-box bg-white p-3" />
                ) : (
                  <div className="space-y-2 text-center">
                    <span className="loading loading-spinner loading-md text-success"></span>
                    <div className="text-sm text-base-content/60">正在生成微信支付二维码</div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-[28px] border border-base-300 bg-base-100 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-lg font-semibold">{activePayment?.product.displayName ?? selectedProduct?.displayName ?? '会员套餐'}</div>
                <div className={`badge ${activePayment?.order.status === 'paid' ? 'badge-success' : 'badge-ghost'}`}>{paymentStatusLabel}</div>
              </div>

              <div className="mt-5 space-y-4 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-base-content/55">购买方案</span>
                  <span className="font-medium">
                    {activePayment?.order.billingMonths === 12
                      ? '年付'
                      : activePayment?.order.billingMonths === 6
                        ? '半年付'
                        : '月付'}
                  </span>
                </div>
                {activePayment?.order.orderNo ? (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-base-content/55">订单号</span>
                    <span className="max-w-[15rem] truncate font-medium" title={activePayment.order.orderNo}>
                      {activePayment.order.orderNo}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="my-5 border-t border-base-200" />

              <div className="space-y-3">
                <div className="rounded-2xl bg-error/8 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-base-content/60">支付金额</span>
                    <span className="text-4xl font-black text-error">
                      ¥{activePayment ? (activePayment.order.amount / 100).toFixed(2) : paymentQuote ? (paymentQuote.amount / 100).toFixed(2) : '--'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                  {activePayment?.order.status === 'pending' && !paymentExpiredLocally ? (
                    <>
                      <span className="badge badge-sm badge-success">支付剩余时间</span>
                      {paymentExpiresCountdown ? <span className="font-medium text-base-content">{paymentExpiresCountdown}</span> : null}
                      {lastPaymentCheckedAt ? <span>最近检查 {lastPaymentCheckedAt}</span> : null}
                    </>
                  ) : (
                    <span>{paymentPollingHint}</span>
                  )}
                  <button
                    className="btn btn-ghost btn-xs ml-auto"
                    onClick={() => void handleRefreshPaymentOrder()}
                    disabled={!activePayment?.order.orderNo || refreshingPaymentStatus}
                  >
                    {refreshingPaymentStatus ? <span className="loading loading-spinner loading-xs" /> : null}
                    立即检查
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${sharedPoolInfoOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-xl">
          <h3 className="text-xl font-bold">共享号池说明</h3>
          <div className="mt-3 space-y-3 text-sm text-base-content/70">
            <p>共享号池会把云端共享认证文件拉到本地 `CPA` 认证目录，文件名前缀会自动加上“共享-”，随后这些认证文件就能和本地文件一起参与使用。</p>
            <p>`Pro` 会随机同步 3 个共享认证文件到本地；当前共享账号全部不可用或额度耗尽后，才能重新获取下一批。</p>
            <p>`Pro Max` 可同步最多 10 个共享账号，同时支持自动切换与云端备份。</p>
          </div>
          <div className="modal-action">
            {!features.allow_shared_pool ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  setSharedPoolInfoOpen(false)
                  setVipDialogOpen(true)
                }}
              >
                开通会员
              </button>
            ) : null}
            <button className="btn btn-ghost" onClick={() => setSharedPoolInfoOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${oauthDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box w-[min(94vw,460px)] max-w-[460px] p-0">
          <div className="flex items-center justify-between gap-3 border-b border-base-200 px-4 py-4">
            <div className="min-w-0">
              <h3 className="text-lg font-bold">登录账号</h3>
              <p className="mt-1 text-xs text-base-content/60">OAuth 授权、Token、JSON 或文件都可以导入。</p>
            </div>
            <button className="btn btn-ghost btn-sm btn-circle shrink-0" onClick={() => setOauthDialogOpen(false)}>
              ✕
            </button>
          </div>
          <div className="border-b border-base-200 px-4 py-3">
            <div className="grid grid-cols-3 gap-1 rounded-2xl bg-base-200 p-1 text-xs font-bold">
              {loginImportTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`rounded-xl px-2 py-2 transition ${loginImportTab === tab.id ? 'bg-primary text-primary-content shadow-sm' : 'text-base-content/65'}`}
                  onClick={() => setLoginImportTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[70vh] overflow-auto px-4 py-4">
            {loginImportTab === 'oauth' ? (
              <OAuthPanel
                canManage={false}
                cpaRunning={cpaState?.status === 'running'}
                visibleProviders={resolveOauthProviders(activeProvider)}
                embeddedMode
                showExtendedTools={false}
                onNotify={onNotify}
                onError={onError}
              />
            ) : loginImportTab === 'token-json' ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-base-200 bg-base-100 p-3 text-xs leading-5 text-base-content/60">
                  粘贴完整 JSON 会按 JSON 导入；粘贴纯 token 会按下方类型自动封装后导入。
                </div>
                <textarea
                  className="textarea textarea-bordered min-h-52 w-full text-sm"
                  value={tokenJsonImportValue}
                  onChange={(event) => setTokenJsonImportValue(event.target.value)}
                  placeholder='粘贴 session JSON、auth.json、Sub2API JSON、accessToken 或 refresh_token'
                />
                <div className="text-xs font-bold text-base-content/60">纯 Token 识别设置</div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="form-control">
                    <span className="label-text text-xs font-bold text-base-content/70">类型</span>
                    <select
                      className="select select-bordered select-sm"
                      value={tokenImportProvider}
                      onChange={(event) => setTokenImportProvider(event.target.value as TokenImportProvider)}
                    >
                      {tokenImportProviders.map((provider) => (
                        <option key={provider.value} value={provider.value}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-control">
                    <span className="label-text text-xs font-bold text-base-content/70">Token</span>
                    <select
                      className="select select-bordered select-sm"
                      value={tokenImportKind}
                      onChange={(event) => setTokenImportKind(event.target.value as TokenImportKind)}
                    >
                      <option value="refresh_token">refresh_token</option>
                      <option value="access_token">access_token</option>
                    </select>
                  </label>
                </div>
                <button className="btn btn-primary w-full" disabled={importingLoginAuth} onClick={handleImportTokenJsonAuth}>
                  {importingLoginAuth && <span className="loading loading-spinner loading-xs" />}
                  识别并导入认证
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <input
                  ref={authImportFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  multiple
                  className="hidden"
                  onChange={handleImportJsonAuthFiles}
                />
                <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-5 text-center">
                  <div className="text-base font-bold">导入 JSON 文件</div>
                  <p className="mt-2 text-sm text-base-content/60">选择一个或多个认证 JSON 文件，会直接导入到本地 CPA 认证目录。</p>
                </div>
                <button
                  className="btn btn-primary w-full"
                  disabled={importingLoginAuth}
                  onClick={() => authImportFileInputRef.current?.click()}
                >
                  {importingLoginAuth && <span className="loading loading-spinner loading-xs" />}
                  选择 JSON 文件
                </button>
              </div>
            )}
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${openAICompatDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-2xl p-0">
          <div className="flex items-center justify-between border-b border-base-200 px-4 py-3">
            <div>
              <h3 className="text-lg font-bold">OpenAI兼容</h3>
              <p className="mt-1 text-xs text-base-content/60">这里可以直接配置你想接入的 OpenAI 兼容模型。</p>
            </div>
            <button className="btn btn-ghost btn-sm btn-circle shrink-0" onClick={() => setOpenAICompatDialogOpen(false)}>
              ✕
            </button>
          </div>
          <div className="max-h-[78vh] overflow-auto px-4 py-4">
            <OpenAIProvidersPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={onNotify}
              onError={onError}
              simpleMode
            />
          </div>
        </div>
      </dialog>

      <CodexConfigDialog
        open={codexConfigDialogOpen}
        onClose={closeCodexConfigDialog}
        onNotify={onNotify}
        onError={onError}
      />

      <ContinueConfigDialog
        open={continueConfigDialogOpen}
        onClose={closeContinueConfigDialog}
        onNotify={onNotify}
        onError={onError}
      />

      <dialog className={`modal ${kiroDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box flex max-h-[88vh] max-w-3xl flex-col p-0 overflow-hidden">
          <div className="shrink-0 border-b border-base-300 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-bold">Kiro 反代</h3>
                <p className="mt-1 text-sm text-base-content/60">安装并启动 9router，本地提供 OpenAI 兼容代理。</p>
              </div>
              <button
                className="btn btn-ghost btn-sm btn-circle"
                disabled={runningKiroProxy}
                onClick={() => setKiroDialogOpen(false)}
              >
                x
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            <div className="mb-4 rounded-box border border-info/20 bg-info/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-bold">CCSwitch</div>
                  <p className="mt-1 text-xs leading-5 text-base-content/60">
                    用 CCSwitch 配置 Kiro/Claude Desktop 等客户端时，将下方地址作为请求地址。
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn btn-outline btn-xs"
                    onClick={() => void cpaRuntime.openExternalTarget(CCSWITCH_OFFICIAL_URL)}
                  >
                    官网
                  </button>
                  <button
                    className="btn btn-primary btn-xs"
                    onClick={() => void cpaRuntime.openExternalTarget(CCSWITCH_DOWNLOAD_URL)}
                  >
                    下载
                  </button>
                </div>
              </div>
              <div className="mt-3 rounded-lg bg-base-100/80 p-3 text-xs leading-6 text-base-content/70">
                <div className="mb-1 font-bold text-base-content">使用教程</div>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>选中你想使用反代的工具，例如 ClaudeDesktop。</li>
                  <li>点击右侧黄色 + 号，选择自定义配置。</li>
                  <li>下滑到底，其他内容随便填，将请求地址和 API Key 填入。</li>
                  <li>开启模型映射，获取模型列表，选择自己需要的模型。</li>
                  <li>设定好后添加并启用，重启应用再次打开即可使用。</li>
                </ol>
              </div>
            </div>

            <div className="rounded-box border border-base-300 bg-neutral p-4 text-sm text-neutral-content shadow-inner">
              <div className="mb-3 flex items-center gap-2 text-xs opacity-70">
                {runningKiroProxy ? <span className="loading loading-spinner loading-xs" /> : null}
                <span>{runningKiroProxy ? '执行中' : kiroProxyResult ? '已就绪' : '等待执行'}</span>
              </div>
              <div className="max-h-[240px] min-h-[180px] space-y-2 overflow-auto font-mono text-xs leading-6">
                {kiroLogs.length === 0 ? <div className="opacity-60">点击开启反代后显示安装和启动进度。</div> : null}
                {kiroLogs.map((line, index) => (
                  <div key={`${index}-${line}`} className="break-all">
                    {line}
                  </div>
                ))}
              </div>
            </div>

            {kiroProxyResult ? (
              <div className="mt-4 grid gap-3">
                <div className="join w-full shadow-sm">
                  <div className="join-item flex min-w-20 items-center border border-base-300 bg-base-200 px-3 text-xs font-semibold text-base-content/60">
                    地址
                  </div>
                  <input className="input input-bordered join-item w-full font-mono text-xs" readOnly value={kiroProxyResult.baseUrl} />
                  <button
                    className="btn btn-outline join-item"
                    onClick={() => {
                      void navigator.clipboard.writeText(kiroProxyResult.baseUrl)
                      onNotify('Kiro 代理地址已复制')
                    }}
                  >
                    复制
                  </button>
                </div>
                <div className="join w-full shadow-sm">
                  <div className="join-item flex min-w-20 items-center border border-base-300 bg-base-200 px-3 text-xs font-semibold text-base-content/60">
                    Key
                  </div>
                  <input className="input input-bordered join-item w-full font-mono text-xs" readOnly value={kiroProxyResult.apiKey} />
                  <button
                    className="btn btn-outline join-item"
                    onClick={() => {
                      void navigator.clipboard.writeText(kiroProxyResult.apiKey)
                      onNotify('Kiro API Key 已复制')
                    }}
                  >
                    复制
                  </button>
                </div>
              </div>
            ) : null}

            {kiroModels.length > 0 ? (
              <div className="mt-4 rounded-box border border-base-300 bg-base-100 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-sm font-bold">探查模型</div>
                  <div className="badge badge-outline badge-sm">{kiroModels.length}</div>
                </div>
                <div className="max-h-48 space-y-1 overflow-auto">
                  {kiroModels.map((model) => (
                    <div key={model} className="rounded-lg bg-base-200 px-3 py-2 font-mono text-xs break-all">
                      {model}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="modal-action m-0 shrink-0 border-t border-base-300 px-5 py-4">
            <button className="btn btn-outline" disabled={runningKiroProxy} onClick={() => setKiroDialogOpen(false)}>
              取消
            </button>
            <button
              className="btn btn-outline"
              disabled={runningKiroProxy || probingKiroModels}
              onClick={() => void handleProbeKiroModels()}
            >
              {probingKiroModels ? <span className="loading loading-spinner loading-xs" /> : null}
              探查模型
            </button>
            <button className="btn btn-primary" disabled={runningKiroProxy} onClick={() => void handleKiroProxySetup()}>
              {runningKiroProxy ? <span className="loading loading-spinner loading-xs" /> : null}
              开启反代
            </button>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${openClawIntroOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-2xl">
          <div className="space-y-4">
            <div>
              <h3 className="text-xl font-bold">OpenClaw</h3>
              <p className="mt-2 text-sm leading-6 text-base-content/70">
                自动把当前本地代理接入 OpenClaw。旧版保持原有写法，新版支持指定模型、默认模型和备选模型。
              </p>
            </div>
            <div className="join w-full">
              <button
                className={`btn join-item flex-1 ${openClawMode === 'legacy' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => {
                  openClawSelectionDirtyRef.current = true
                  setOpenClawMode('legacy')
                }}
              >
                旧版
              </button>
              <button
                className={`btn join-item flex-1 ${openClawMode === 'modern' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => {
                  openClawSelectionDirtyRef.current = true
                  setOpenClawMode('modern')
                }}
              >
                新版
              </button>
            </div>
            {openClawMode === 'modern' ? (
              <div className="space-y-3 rounded-box border border-base-300 bg-base-200/50 p-3">
                {loadingOpenClawState ? (
                  <div className="flex items-center gap-2 text-sm text-base-content/60">
                    <span className="loading loading-spinner loading-xs" />
                    正在读取当前代理模型
                  </div>
                ) : null}
                <div>
                  <div className="mb-2 text-sm font-bold">写入模型（可多选）</div>
                  <div className="max-h-40 space-y-1 overflow-auto rounded-box bg-base-100 p-2">
                    {openClawModels.length === 0 && !loadingOpenClawState ? (
                      <div className="text-sm text-base-content/50">暂无模型，请先确认本地代理已启动。</div>
                    ) : null}
                    {openClawModels.map((model) => (
                      <label key={model} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-base-200">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-primary checkbox-sm"
                          checked={openClawSelectedModels.includes(model)}
                          onChange={() => toggleOpenClawSelectedModel(model)}
                        />
                        <span className="truncate">{model}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label className="form-control">
                  <span className="label-text mb-1 font-bold">默认模型</span>
                  <select
                    className="select select-bordered select-sm"
                    value={openClawPrimaryModel}
                    onChange={(event) => {
                      openClawSelectionDirtyRef.current = true
                      const next = event.target.value
                      setOpenClawPrimaryModel(next)
                      setOpenClawFallbackModels((current) => current.filter((model) => model !== next))
                    }}
                  >
                    {openClawSelectedModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <div className="mb-2 text-sm font-bold">备选模型（可多选）</div>
                  <div className="max-h-32 space-y-1 overflow-auto rounded-box bg-base-100 p-2">
                    {openClawSelectedModels
                      .filter((model) => model !== openClawPrimaryModel)
                      .map((model) => (
                        <label key={model} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-base-200">
                          <input
                            type="checkbox"
                            className="checkbox checkbox-warning checkbox-sm"
                            checked={openClawFallbackModels.includes(model)}
                            onChange={() => toggleOpenClawFallbackModel(model)}
                          />
                          <span className="truncate">{model}</span>
                        </label>
                      ))}
                  </div>
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-box border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-warning checkbox-sm mt-0.5"
                    checked={openClawClearOtherModels}
                    onChange={(event) => {
                      openClawSelectionDirtyRef.current = true
                      setOpenClawClearOtherModels(event.target.checked)
                    }}
                  />
                  <span className="leading-6">
                    清除其他模型
                    <span className="block text-xs text-base-content/60">
                      勾选后只保留本次选择的 `cliproxy` 模型，并清理以前残留的 `cliproxy/*` 模型项。
                    </span>
                  </span>
                </label>
              </div>
            ) : (
              <div className="rounded-box border border-base-300 bg-base-200/50 p-3 text-sm text-base-content/70">
                旧版会写入所有代理模型，只更新 provider 和模型 allowlist，不主动修改默认模型和备选模型。
              </div>
            )}
            <div className="modal-action">
              <button className="btn btn-outline" onClick={() => setOpenClawIntroOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={runningOpenClawSetup || loadingOpenClawState || (openClawMode === 'modern' && openClawSelectedModels.length === 0)}
                onClick={() => void handleOpenClawSetup()}
              >
                继续
              </button>
            </div>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${openClawDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-3xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">OpenClaw 接入日志</h3>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpenClawDialogOpen(false)}>
              关闭
            </button>
          </div>
          <div className="mt-4 rounded-box border border-base-300 bg-neutral p-4 text-sm text-neutral-content shadow-inner">
            <div className="mb-3 flex items-center gap-2 text-xs opacity-70">
              {runningOpenClawSetup ? <span className="loading loading-spinner loading-xs" /> : null}
              <span>{runningOpenClawSetup ? '执行中' : '已结束'}</span>
            </div>
            <div className="max-h-[420px] space-y-2 overflow-auto font-mono text-xs leading-6">
              {openClawLogs.length === 0 ? <div className="opacity-60">等待开始...</div> : null}
              {openClawLogs.map((line, index) => (
                <div key={`${index}-${line}`} className="break-all">
                  {line}
                </div>
              ))}
            </div>
          </div>
          <div className="modal-action">
            {!runningOpenClawSetup ? (
              <button className="btn btn-outline" onClick={() => void handleOpenClawSetup()}>
                重新执行
              </button>
            ) : null}
            <button className="btn btn-primary" onClick={() => setOpenClawDialogOpen(false)}>
              知道了
            </button>
          </div>
        </div>
      </dialog>
    </main>
  )
}
