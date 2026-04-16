import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { QuotaPanel } from '../quota/QuotaPanel'
import { PROVIDER_META, PROVIDER_ORDER } from '../quota/providerMeta'
import type { QuotaProvider } from '../quota/types'
import type {
  CloudCreatePaymentOrderResponse,
  CloudFeatures,
  CloudPaymentProduct,
  CloudPaymentPurchaseMode,
  CloudPaymentQuote,
  CloudPlan
} from '../../lib/cloud/types'
import type { CpaState } from '../../lib/cpa/types'
import { OAuthPanel } from '../oauth/OAuthPanel'
import type { OAuthProvider } from '../oauth/types'
import { cloudClient } from '../../lib/cloud/client'
import { formatPlanLabel } from '../../lib/cloud/planLabels'
import { sharedImportRegistry } from '../../lib/cloud/sharedRegistry'
import { cpaRuntime } from '../../lib/cpa/runtime'
import vipQrImage from '../../assets/vip-qr.jpg'
import { authFilesApi } from '../auth-files/api'

interface UserWorkspaceProps {
  plan: CloudPlan
  features: CloudFeatures
  planExpiresAt: string | null
  userKey: string
  cloudToken: string
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

function buildSharedLocalFileName(fileName: string) {
  return fileName.startsWith('共享-') ? fileName : `共享-${fileName}`
}

function buildQuoteCacheKey(productCode: string, billingMonths: number, purchaseMode: CloudPaymentPurchaseMode) {
  return `${productCode}:${billingMonths}:${purchaseMode}`
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
  cpaState,
  normalizingFreeTier,
  onRefreshSession,
  onNotify,
  onError
}: UserWorkspaceProps) {
  const providerTabsContainerRef = useRef<HTMLDivElement | null>(null)
  const providerTabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [activeProvider, setActiveProvider] = useState<QuotaProvider | 'all'>('all')
  const [providerCounts, setProviderCounts] = useState<Partial<Record<QuotaProvider, number>>>({})
  const [vipDialogOpen, setVipDialogOpen] = useState(false)
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false)
  const [sharedPoolInfoOpen, setSharedPoolInfoOpen] = useState(false)
  const [syncingSharedPool, setSyncingSharedPool] = useState(false)
  const [quotaRefreshToken, setQuotaRefreshToken] = useState(0)
  const [, setSharedCooldownSeconds] = useState(0)
  const [openClawIntroOpen, setOpenClawIntroOpen] = useState(false)
  const [openClawDialogOpen, setOpenClawDialogOpen] = useState(false)
  const [runningOpenClawSetup, setRunningOpenClawSetup] = useState(false)
  const [openClawLogs, setOpenClawLogs] = useState<string[]>([])
  const [paymentProducts, setPaymentProducts] = useState<CloudPaymentProduct[]>([])
  const [loadingPaymentProducts, setLoadingPaymentProducts] = useState(false)
  const [preparingVipDialog, setPreparingVipDialog] = useState(false)
  const [creatingPaymentOrder, setCreatingPaymentOrder] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState<string>('')
  const [selectedBillingMonths, setSelectedBillingMonths] = useState<1 | 6 | 12>(1)
  const [paymentQuote, setPaymentQuote] = useState<CloudPaymentQuote | null>(null)
  const [loadingPaymentQuote, setLoadingPaymentQuote] = useState(false)
  const [paymentQuoteCache, setPaymentQuoteCache] = useState<Record<string, CloudPaymentQuote>>({})
  const selectedPaymentProvider: 'xunhu' = 'xunhu'
  const [activePayment, setActivePayment] = useState<CloudCreatePaymentOrderResponse | null>(null)
  const [paymentCheckoutOpen, setPaymentCheckoutOpen] = useState(false)
  const [paymentQrDataUrl, setPaymentQrDataUrl] = useState<string | null>(null)
  const [paymentPollCountdown, setPaymentPollCountdown] = useState(0)
  const [refreshingPaymentStatus, setRefreshingPaymentStatus] = useState(false)
  const [closingPaymentCheckout, setClosingPaymentCheckout] = useState(false)
  const [lastPaymentCheckedAt, setLastPaymentCheckedAt] = useState<string | null>(null)
  const [manualHelpVisible, setManualHelpVisible] = useState(false)
  const paidNotifiedOrderRef = useRef<string | null>(null)
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
  const sharedSyncKey = useMemo(() => getSharedSyncStorageKey(userKey.trim().toLowerCase()), [userKey])

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
    if (features.shared_pool_mode !== 'sample' || features.shared_pool_refresh_minutes <= 0) {
      setSharedCooldownSeconds(0)
      return
    }

    const tick = () => {
      const lastSync = Number(window.localStorage.getItem(sharedSyncKey) || '0')
      const nextAllowedAt = lastSync + features.shared_pool_refresh_minutes * 60 * 1000
      const remaining = Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000))
      setSharedCooldownSeconds(remaining)
    }

    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [features.shared_pool_mode, features.shared_pool_refresh_minutes, sharedSyncKey])

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

  const handleSharedPoolAction = async () => {
    const latestSession = await onRefreshSession()
    const effectiveFeatures = latestSession?.features ?? features

    if (!effectiveFeatures.allow_shared_pool) {
      setVipDialogOpen(true)
      return
    }
    if (cpaState?.status !== 'running') {
      onError('请先启动 CPA，再同步共享号池。')
      return
    }

    try {
      setSyncingSharedPool(true)
      onError(null)
      const syncPackage = await cloudClient.getSharedSyncPackage(cloudToken)
      const sharedFiles = Array.isArray(syncPackage.files) ? syncPackage.files : []
      if (sharedFiles.length === 0) {
        onNotify('当前共享号池没有可同步的认证文件')
        return
      }

      if (effectiveFeatures.shared_pool_mode === 'sample' && effectiveFeatures.shared_pool_refresh_minutes > 0) {
        const lastSync = Number(window.localStorage.getItem(sharedSyncKey) || '0')
        const nextAllowedAt = lastSync + effectiveFeatures.shared_pool_refresh_minutes * 60 * 1000
        if (lastSync > 0 && Date.now() < nextAllowedAt) {
          const remaining = Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000))
          setSharedCooldownSeconds(remaining)
          onError(`当前套餐的共享号池每 ${effectiveFeatures.shared_pool_refresh_minutes} 分钟可更新一次。`)
          return
        }
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
      if (effectiveFeatures.shared_pool_mode === 'sample' && effectiveFeatures.shared_pool_refresh_minutes > 0) {
        setSharedCooldownSeconds(effectiveFeatures.shared_pool_refresh_minutes * 60)
      }
      setQuotaRefreshToken((current) => current + 1)
      onNotify(`已同步 ${sharedFiles.length} 个共享认证文件到本地`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncingSharedPool(false)
    }
  }

  const handleOpenClawSetup = async () => {
    setOpenClawIntroOpen(false)
    setOpenClawDialogOpen(true)
    setOpenClawLogs(['准备开始接入 OpenClaw...'])
    setRunningOpenClawSetup(true)
    onError(null)
    try {
      const result = await cpaRuntime.setupOpenClawProvider()
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

  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-col gap-3 px-3 py-3">
      <section className="rounded-[24px] border border-base-300 bg-base-100 shadow-sm">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="truncate text-sm font-black">{userKey}</div>
                <div className={`badge badge-xs px-2 ${getStatusTone(cpaState?.status)}`}>
                  {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                </div>
                <div className="badge badge-outline badge-xs px-2">{planLabel}</div>
              </div>
              {formattedPlanExpiresAt ? (
                <div className="mt-1 text-[11px] text-base-content/55">
                  到期时间 {formattedPlanExpiresAt}
                </div>
              ) : null}
            </div>
            <button className="btn btn-ghost btn-sm btn-square" onClick={() => setSharedPoolInfoOpen(true)} title="共享号池说明">
              <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
            </button>
          </div>

          <div className="grid gap-2">
            <div className="grid grid-cols-3 gap-2">
              <button
                className={`btn h-11 rounded-2xl px-0 ${features.allow_shared_pool ? 'btn-accent' : 'btn-outline'}`}
                onClick={() => void handleSharedPoolAction()}
                disabled={syncingSharedPool}
              >
                <span className="truncate">获取账号</span>
                {syncingSharedPool ? <span className="loading loading-spinner loading-xs" /> : null}
              </button>

              <button
                className="btn btn-secondary h-11 rounded-2xl px-0"
                disabled={runningOpenClawSetup}
                onClick={() => setOpenClawIntroOpen(true)}
              >
                {runningOpenClawSetup ? <span className="loading loading-spinner loading-xs" /> : 'OpenClaw'}
              </button>

              <button className="btn btn-primary h-11 rounded-2xl px-0" onClick={() => void handleOpenVipDialog()} disabled={preparingVipDialog}>
                {preparingVipDialog ? <span className="loading loading-spinner loading-xs" /> : null}
                开通会员
              </button>
            </div>

          </div>

          {normalizingFreeTier ? (
            <div className="alert alert-warning py-2 text-sm">
              <span>正在按免费版规则整理认证文件。</span>
            </div>
          ) : null}

        </div>
      </section>

      <section className="rounded-[24px] border border-base-300 bg-base-100 shadow-sm">
        <div className="border-b border-base-200 px-2.5 py-2.5">
          <div ref={providerTabsContainerRef} className="-mx-1 overflow-x-auto scrollbar-none">
            <div className="tabs tabs-box tabs-sm inline-flex min-w-full flex-nowrap gap-1 bg-transparent px-1">
              {mobileProviderOrder.map((provider) => {
                const active = provider === activeProvider
                const label = provider === 'all' ? '全部' : PROVIDER_META[provider].label
                const count =
                  provider === 'all'
                    ? Object.values(providerCounts).reduce((sum, value) => sum + (value ?? 0), 0)
                    : (providerCounts[provider] ?? 0)
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
                    className={`tab h-9 min-w-fit whitespace-nowrap rounded-full px-3 text-xs font-medium ${active ? 'tab-active bg-primary text-primary-content' : ''}`}
                    onClick={() => setActiveProvider(provider)}
                  >
                    {label}
                    <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${active ? 'bg-primary-content/15 text-primary-content' : 'bg-base-300 text-base-content/65'}`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="px-2 pb-2 pt-1.5">
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
            onProviderCountsChange={setProviderCounts}
            onNotify={onNotify}
            onError={onError}
          />
        </div>
      </section>

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
                        setSelectedProductCode(product.productCode)
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
                  <div className="grid grid-cols-3 gap-2">
                    {[1, 6, 12].map((months) => (
                      <button
                        key={months}
                        className={`rounded-2xl border p-3 text-left transition ${
                          selectedBillingMonths === months
                            ? 'border-primary bg-primary/8 ring-1 ring-primary/20'
                            : 'border-base-300 bg-base-100'
                        }`}
                        onClick={() => setSelectedBillingMonths(months as 1 | 6 | 12)}
                        disabled={hasPendingPayment || downgradeBlocked}
                      >
                        <div className="text-sm font-semibold">{months === 1 ? '月付' : months === 6 ? '半年付' : '年付'}</div>
                        <div className="mt-2 min-h-[28px]">
                          {billingQuotes[months as 1 | 6 | 12] ? (
                            <div className="text-lg font-bold">
                              ¥{(billingQuotes[months as 1 | 6 | 12]!.amount / 100).toFixed(2)}
                            </div>
                          ) : loadingPaymentQuote ? (
                            <div className="flex items-center gap-1 text-xs text-base-content/55">
                              <span className="loading loading-spinner loading-xs" />
                              加载中
                            </div>
                          ) : null}
                        </div>
                      </button>
                    ))}
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
                    ? '支持完整共享号池、自动切换、云端备份。'
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
            <p>`Pro` 会随机同步 3 个共享认证文件到本地，并支持每 30 分钟更新一次。</p>
            <p>`Pro Max` 则享有共享号池全部功能，同时支持自动切换与云端备份。</p>
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
        <div className="modal-box w-[min(92vw,420px)] max-w-[420px] p-0">
          <div className="flex items-center justify-between gap-3 border-b border-base-200 px-4 py-4">
            <div className="min-w-0">
              <h3 className="text-lg font-bold">登录账号</h3>
              <p className="mt-1 text-xs text-base-content/60">在当前窗口完成自己的账号授权。</p>
            </div>
            <button className="btn btn-ghost btn-sm btn-circle shrink-0" onClick={() => setOauthDialogOpen(false)}>
              ✕
            </button>
          </div>
          <div className="max-h-[78vh] overflow-auto px-4 py-4">
            <OAuthPanel
              canManage={false}
              cpaRunning={cpaState?.status === 'running'}
              visibleProviders={resolveOauthProviders(activeProvider)}
              embeddedMode
              showExtendedTools={false}
              onNotify={onNotify}
              onError={onError}
            />
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${openClawIntroOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-md">
          <div className="space-y-4">
            <div>
              <h3 className="text-xl font-bold">OpenClaw</h3>
              <p className="mt-2 text-sm leading-6 text-base-content/70">
                这个按钮会自动把当前本地代理接入 OpenClaw，并写入 provider 和模型配置。
              </p>
            </div>
            <div className="modal-action">
              <button className="btn btn-outline" onClick={() => setOpenClawIntroOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void handleOpenClawSetup()}>
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
