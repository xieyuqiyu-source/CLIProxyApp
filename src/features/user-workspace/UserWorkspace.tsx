import { useEffect, useMemo, useRef, useState } from 'react'
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

export function UserWorkspace({
  plan,
  features,
  planExpiresAt,
  userKey,
  cloudToken,
  cpaState,
  loadError,
  pendingAction,
  normalizingFreeTier,
  onRefreshSession,
  onStart,
  onRestart,
  onStop,
  onRefresh,
  onNotify,
  onError
}: UserWorkspaceProps) {
  const [activeProvider, setActiveProvider] = useState<QuotaProvider | 'all'>('all')
  const [quotaSourceFilter, setQuotaSourceFilter] = useState<'all' | 'shared' | 'personal'>('all')
  const [providerCounts, setProviderCounts] = useState<Partial<Record<QuotaProvider, number>>>({})
  const [vipDialogOpen, setVipDialogOpen] = useState(false)
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false)
  const [sharedPoolInfoOpen, setSharedPoolInfoOpen] = useState(false)
  const [cardDialogOpen, setCardDialogOpen] = useState(false)
  const [syncingSharedPool, setSyncingSharedPool] = useState(false)
  const [sharedCooldownSeconds, setSharedCooldownSeconds] = useState(0)
  const [openClawDialogOpen, setOpenClawDialogOpen] = useState(false)
  const [runningOpenClawSetup, setRunningOpenClawSetup] = useState(false)
  const [openClawLogs, setOpenClawLogs] = useState<string[]>([])
  const [paymentProducts, setPaymentProducts] = useState<CloudPaymentProduct[]>([])
  const [loadingPaymentProducts, setLoadingPaymentProducts] = useState(false)
  const [creatingPaymentOrder, setCreatingPaymentOrder] = useState(false)
  const [selectedProductCode, setSelectedProductCode] = useState<string>('')
  const [selectedBillingMonths, setSelectedBillingMonths] = useState<1 | 6 | 12>(1)
  const [selectedPurchaseMode, setSelectedPurchaseMode] = useState<CloudPaymentPurchaseMode>('standard')
  const [paymentQuote, setPaymentQuote] = useState<CloudPaymentQuote | null>(null)
  const [loadingPaymentQuote, setLoadingPaymentQuote] = useState(false)
  const [selectedPaymentProvider, setSelectedPaymentProvider] = useState<'wechat' | 'alipay'>('wechat')
  const [activePayment, setActivePayment] = useState<CloudCreatePaymentOrderResponse | null>(null)
  const [paymentQrDataUrl, setPaymentQrDataUrl] = useState<string | null>(null)
  const [paymentPolling, setPaymentPolling] = useState(false)
  const [paymentPollCountdown, setPaymentPollCountdown] = useState(0)
  const [refreshingPaymentStatus, setRefreshingPaymentStatus] = useState(false)
  const [lastPaymentCheckedAt, setLastPaymentCheckedAt] = useState<string | null>(null)
  const [vipCloseConfirmOpen, setVipCloseConfirmOpen] = useState(false)
  const [manualHelpVisible, setManualHelpVisible] = useState(false)
  const paidNotifiedOrderRef = useRef<string | null>(null)
  const planLabel = useMemo(() => formatPlanLabel(plan.planCode, plan.name), [plan.name, plan.planCode])
  const planExpiryLabel = useMemo(() => {
    if (!planExpiresAt) return '未设置'
    return new Date(planExpiresAt).toLocaleString('zh-CN', { hour12: false })
  }, [planExpiresAt])

  const sharedSyncKey = useMemo(() => getSharedSyncStorageKey(userKey.trim().toLowerCase()), [userKey])

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
    let cancelled = false

    const loadProducts = async () => {
      try {
        setLoadingPaymentProducts(true)
        const response = await cloudClient.listPaymentProducts(cloudToken)
        if (cancelled) {
          return
        }
        const products = response.products ?? []
        setPaymentProducts(products)
        setSelectedProductCode((current) => {
          if (current && products.some((product) => product.productCode === current)) {
            return current
          }
          return products[0]?.productCode ?? ''
        })
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) {
          setLoadingPaymentProducts(false)
        }
      }
    }

    void loadProducts()
    return () => {
      cancelled = true
    }
  }, [cloudToken, onError])

  useEffect(() => {
    let cancelled = false

    const buildQr = async () => {
      if (!activePayment?.checkout.codeUrl) {
        setPaymentQrDataUrl(null)
        return
      }
      try {
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
      setPaymentPolling(false)
      setPaymentPollCountdown(0)
      return
    }
    if (activePayment.order.status === 'paid' || activePayment.order.status === 'closed' || activePayment.order.status === 'failed' || activePayment.order.status === 'refunded') {
      setPaymentPolling(false)
      setPaymentPollCountdown(0)
      if (activePayment.order.status === 'paid' && paidNotifiedOrderRef.current !== activePayment.order.orderNo) {
        paidNotifiedOrderRef.current = activePayment.order.orderNo
        onNotify('支付成功，会员状态已更新')
        void onRefreshSession()
      }
      return
    }

    let cancelled = false
    setPaymentPolling(true)
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
      setPaymentPolling(false)
      setPaymentPollCountdown(0)
      window.clearInterval(timer)
      window.clearInterval(countdownTimer)
    }
  }, [activePayment, cloudToken, onError, onNotify, onRefreshSession])

  const sharedButtonLabel = useMemo(() => {
    if (syncingSharedPool) {
      return '共享号池更新中'
    }
    if (features.shared_pool_mode === 'sample' && sharedCooldownSeconds > 0) {
      const minutes = Math.floor(sharedCooldownSeconds / 60)
      const seconds = sharedCooldownSeconds % 60
      return `共享号池 ${minutes}:${String(seconds).padStart(2, '0')}`
    }
    return '共享号池'
  }, [features.shared_pool_mode, sharedCooldownSeconds, syncingSharedPool])

  const selectedProduct = useMemo(
    () => paymentProducts.find((product) => product.productCode === selectedProductCode) ?? null,
    [paymentProducts, selectedProductCode]
  )

  const showUpgradeModes = plan.planCode === 'vip1' && selectedProduct?.planCode === 'vip2'
  const downgradeBlocked = plan.planCode === 'vip2' && selectedProduct?.planCode === 'vip1'

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
    if (!selectedProduct) {
      return
    }
    if (plan.planCode === 'vip1' && selectedProduct.planCode === 'vip2') {
      setSelectedPurchaseMode((current) => (current === 'upgrade_replace_month' ? current : 'upgrade_diff_all'))
      setSelectedBillingMonths(1)
      return
    }
    setSelectedPurchaseMode('standard')
  }, [plan.planCode, selectedProduct])

  useEffect(() => {
    if (!vipDialogOpen || !selectedProductCode) {
      return
    }
    let cancelled = false
    const loadQuote = async () => {
      try {
        setLoadingPaymentQuote(true)
        const response = await cloudClient.quotePaymentOrder(cloudToken, {
          product_code: selectedProductCode,
          billing_months: selectedPurchaseMode === 'standard' ? selectedBillingMonths : 1,
          purchase_mode: selectedPurchaseMode
        })
        if (cancelled) {
          return
        }
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
  }, [cloudToken, onError, selectedBillingMonths, selectedProductCode, selectedPurchaseMode, vipDialogOpen])

  const hasPendingPayment = activePayment?.order.status === 'pending'

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

  const paymentPollingHint = useMemo(() => {
    if (!activePayment) {
      return '创建订单后将自动检查支付结果。'
    }
    if (activePayment.order.status === 'paid') {
      return '支付已完成，会员权益即将生效。'
    }
    if (activePayment.order.status === 'closed' || activePayment.order.status === 'failed' || activePayment.order.status === 'refunded') {
      return '当前订单已结束，请重新创建新的支付订单。'
    }
    if (paymentPolling) {
      return `系统正在自动确认支付结果，${paymentPollCountdown} 秒后再次查询。`
    }
    return '系统正在准备检查支付状态。'
  }, [activePayment, paymentPollCountdown, paymentPolling])

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
        billing_months: selectedPurchaseMode === 'standard' ? selectedBillingMonths : 1,
        purchase_mode: selectedPurchaseMode
      })
      paidNotifiedOrderRef.current = null
      setActivePayment(response)
      setLastPaymentCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      setPaymentPollCountdown(3)
      if (!response.checkout.paymentEnabled) {
        onError(response.checkout.message || '当前支付通道未启用')
        return
      }
      onNotify(`已创建${selectedPaymentProvider === 'wechat' ? '微信' : '支付宝'}支付订单`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreatingPaymentOrder(false)
    }
  }

  const handleOpenVipDialog = () => {
    setManualHelpVisible(false)
    setSelectedBillingMonths(1)
    setVipDialogOpen(true)
  }

  const handleCloseVipDialog = () => {
    if (hasPendingPayment) {
      setVipCloseConfirmOpen(true)
      return
    }
    setVipDialogOpen(false)
  }

  const confirmCloseVipDialog = () => {
    setVipCloseConfirmOpen(false)
    setVipDialogOpen(false)
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
      onNotify(`已同步 ${sharedFiles.length} 个共享认证文件到本地`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncingSharedPool(false)
    }
  }

  const handleOpenClawSetup = async () => {
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
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4">
      <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="badge badge-primary badge-outline badge-lg px-4">用户工作台</div>
            <div className={`badge badge-lg px-4 ${getStatusTone(cpaState?.status)}`}>
              {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
            </div>
            <div className="badge badge-outline px-4">{planLabel}</div>
            <div className="badge badge-ghost px-4">到期：{planExpiryLabel}</div>

            <div className="join shadow-sm ml-auto">
              <button className="join-item btn btn-primary btn-sm" disabled={pendingAction !== null} onClick={() => void onStart()}>
                启动
              </button>
              <button className="join-item btn btn-secondary btn-sm" disabled={pendingAction !== null} onClick={() => void onRestart()}>
                重启
              </button>
              <button className="join-item btn btn-warning btn-sm" disabled={pendingAction !== null} onClick={() => void onStop()}>
                停止
              </button>
            </div>

            <button className="btn btn-outline btn-sm" disabled={pendingAction !== null} onClick={() => void onRefresh()}>
              刷新页面
            </button>

            <div
              className="tooltip tooltip-bottom"
              data-tip={
                features.allow_shared_pool
                  ? features.shared_pool_mode === 'sample'
                    ? '当前套餐每次随机同步 3 个共享认证文件到本地，可每 30 分钟更新一次。'
                    : '同步云端共享号池全部认证文件到本地 CPA，可直接参与使用。'
                  : '共享号池属于付费功能，升级后可一键拉取共享认证文件。'
              }
            >
              <button
                className={`btn btn-sm ${features.allow_shared_pool ? 'btn-accent' : 'btn-outline'}`}
                onClick={() => void handleSharedPoolAction()}
                disabled={syncingSharedPool}
              >
                {syncingSharedPool ? <span className="loading loading-spinner loading-xs" /> : null}
                {sharedButtonLabel}
              </button>
            </div>

            <button
              className="btn btn-secondary btn-sm"
              disabled={runningOpenClawSetup}
              onClick={() => void handleOpenClawSetup()}
            >
              {runningOpenClawSetup ? <span className="loading loading-spinner loading-xs" /> : null}
              一键接入 OpenClaw
            </button>

            <button className="btn btn-primary btn-sm" onClick={handleOpenVipDialog}>
              开通会员
            </button>

            <button className="btn btn-outline btn-sm" onClick={() => setCardDialogOpen(true)}>
              购买虚拟卡
            </button>

            <button className="btn btn-ghost btn-sm" onClick={() => setSharedPoolInfoOpen(true)}>
              共享号池说明
            </button>

          </div>

          {normalizingFreeTier ? (
            <div className="alert alert-warning">
              <span>正在按免费版规则整理本地认证文件，请稍候。</span>
            </div>
          ) : null}

          {loadError ? (
            <div className="alert alert-error">
              <span>{loadError}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="border-b border-base-200 px-4 py-4">
            <div className="text-xs font-medium uppercase tracking-[0.28em] text-base-content/45">模型提供商</div>
            <h3 className="mt-2 text-lg font-bold">Provider</h3>
          </div>
          <ul className="menu gap-2 p-3">
            <li className="menu-title px-2 py-1 text-[11px] uppercase tracking-[0.22em] text-base-content/40">能力入口</li>
            <li>
              <button
                className="justify-between rounded-box"
                onClick={() => void handleSharedPoolAction()}
              >
                <span>云端</span>
                <span className={`badge badge-sm ${features.allow_shared_pool ? 'badge-info' : 'badge-ghost'}`}>
                  {features.allow_shared_pool ? planLabel : 'Free'}
                </span>
              </button>
            </li>
            <li className="menu-title px-2 pt-3 pb-1 text-[11px] uppercase tracking-[0.22em] text-base-content/40">模型提供商</li>
            <li>
              <button
                className={`justify-between rounded-box ${activeProvider === 'all' ? 'menu-active bg-primary text-primary-content' : ''}`}
                onClick={() => setActiveProvider('all')}
              >
                <span>全部</span>
                <span className={`badge badge-sm ${activeProvider === 'all' ? 'badge-neutral' : 'badge-ghost'}`}>
                  {Object.values(providerCounts).reduce((sum, value) => sum + (value ?? 0), 0)}
                </span>
              </button>
            </li>
            {PROVIDER_ORDER.map((provider) => {
              const meta = PROVIDER_META[provider]
              const active = provider === activeProvider
              return (
                <li key={provider}>
                  <button
                    className={`justify-between rounded-box ${active ? 'menu-active bg-primary text-primary-content' : ''}`}
                    onClick={() => setActiveProvider(provider)}
                  >
                    <span>{meta.label}</span>
                    <span className={`badge badge-sm ${active ? 'badge-neutral' : 'badge-ghost'}`}>
                      {providerCounts[provider] ?? 0}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        <div className="rounded-box border border-base-300 bg-base-100 px-4 pb-4 shadow-sm">
          <QuotaPanel
            cpaRunning={cpaState?.status === 'running'}
            activeProvider={activeProvider}
            sourceFilter={quotaSourceFilter}
            onSourceFilterChange={setQuotaSourceFilter}
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
        <div className="modal-box max-w-6xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">开通会员</h3>
              <p className="mt-3 text-sm text-base-content/70">当前套餐为 <span className="font-semibold">{planLabel}</span>。请选择套餐后完成支付，系统会自动开通对应会员权益。</p>
            </div>
            <button className="btn btn-ghost btn-sm btn-circle" onClick={handleCloseVipDialog}>
              ✕
            </button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
            <div className="space-y-4">
              <div className="grid gap-3">
                {loadingPaymentProducts ? (
                  <div className="flex items-center gap-2 text-sm text-base-content/60">
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
                      className={`rounded-box border p-4 text-left transition ${active ? 'border-primary bg-primary/5 shadow-sm' : 'border-base-300 bg-base-100'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                      onClick={() => {
                        if (disabled) return
                        setSelectedProductCode(product.productCode)
                      }}
                      disabled={disabled}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="text-lg font-semibold">{product.displayName}</div>
                          <div className="mt-1 text-sm text-base-content/60 line-clamp-3">{product.description}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-2xl font-bold">¥{(product.priceAmount / 100).toFixed(2)}</div>
                          <div className="mt-1 text-xs text-base-content/50">月付起</div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="rounded-box border border-base-300 bg-base-100 p-4 space-y-4">
                <div className="text-sm font-semibold">购买方案</div>
                {showUpgradeModes ? (
                  <div className="space-y-3">
                    <div className="join">
                      <button
                        className={`join-item btn btn-sm ${selectedPurchaseMode === 'upgrade_diff_all' ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => setSelectedPurchaseMode('upgrade_diff_all')}
                        disabled={hasPendingPayment}
                      >
                        补全部差价升级
                      </button>
                      <button
                        className={`join-item btn btn-sm ${selectedPurchaseMode === 'upgrade_replace_month' ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => setSelectedPurchaseMode('upgrade_replace_month')}
                        disabled={hasPendingPayment}
                      >
                        只开 1 个月 Pro Max
                      </button>
                    </div>
                    <p className="text-xs text-base-content/60">
                      方案 1 会按当前 Pro 剩余月份补差价，升级后到期时间保持不变。方案 2 会放弃当前 Pro 剩余时长，重新开通 1 个月 Pro Max。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="join">
                      {[1, 6, 12].map((months) => (
                        <button
                          key={months}
                          className={`join-item btn btn-sm ${selectedBillingMonths === months ? 'btn-primary' : 'btn-outline'}`}
                          onClick={() => setSelectedBillingMonths(months as 1 | 6 | 12)}
                          disabled={hasPendingPayment || downgradeBlocked}
                        >
                          {months === 1 ? '月付' : months === 6 ? '半年付 9 折' : '年付 7 折'}
                        </button>
                      ))}
                    </div>
                    {downgradeBlocked ? <p className="text-xs text-error">当前已是 Pro Max，暂不支持降级购买 Pro。</p> : null}
                  </div>
                )}

                <div className="rounded-box bg-base-200/60 p-4">
                  <div className="text-sm font-semibold text-base-content">当前报价</div>
                  {loadingPaymentQuote ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-base-content/60">
                      <span className="loading loading-spinner loading-xs"></span>
                      正在计算价格
                    </div>
                  ) : paymentQuote ? (
                    <div className="mt-3 space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium">{paymentQuote.title}</div>
                        <div className="text-xl font-bold">¥{(paymentQuote.amount / 100).toFixed(2)}</div>
                      </div>
                      <div className="text-base-content/65">{paymentQuote.description}</div>
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-base-content/60">选择套餐后，这里会显示后端计算后的正式支付金额。</div>
                  )}
                </div>
              </div>

              <div className="rounded-box border border-base-300 bg-base-100 p-4">
                <div className="text-sm font-semibold">支付方式</div>
                <div className="mt-3 join">
                  <button
                    className={`join-item btn btn-sm ${selectedPaymentProvider === 'wechat' ? 'btn-success' : 'btn-outline'}`}
                    onClick={() => setSelectedPaymentProvider('wechat')}
                    disabled={hasPendingPayment}
                  >
                    微信支付
                  </button>
                  <button
                    className={`join-item btn btn-sm ${selectedPaymentProvider === 'alipay' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setSelectedPaymentProvider('alipay')}
                    disabled={hasPendingPayment}
                  >
                    支付宝
                  </button>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="btn btn-primary btn-sm" disabled={creatingPaymentOrder || !selectedProduct || hasPendingPayment || !paymentQuote || downgradeBlocked} onClick={() => void handleCreatePaymentOrder()}>
                    {creatingPaymentOrder ? <span className="loading loading-spinner loading-xs"></span> : null}
                    {hasPendingPayment ? '当前订单处理中' : '立即支付'}
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => window.open(activePayment?.checkout.codeUrl || '#', '_blank', 'noopener,noreferrer')}
                    disabled={!activePayment?.checkout.codeUrl}
                  >
                    打开支付页面
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-box border border-base-300 bg-base-100 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-base-content">支付状态</div>
                    <div className="mt-1 text-xs text-base-content/55">{selectedPaymentProvider === 'wechat' ? '请使用微信扫码完成支付' : '请使用支付宝扫码完成支付'}</div>
                  </div>
                  <div className={`badge ${activePayment?.order.status === 'paid' ? 'badge-success' : 'badge-ghost'}`}>{paymentStatusLabel}</div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                  {activePayment?.order.status === 'pending' ? (
                    <>
                      <span className={`badge badge-sm ${paymentPolling ? 'badge-info' : 'badge-ghost'}`}>
                        {paymentPolling ? '轮询中' : '等待轮询'}
                      </span>
                      <span>{paymentPollingHint}</span>
                      {paymentExpiresCountdown ? <span>剩余支付时间：{paymentExpiresCountdown}</span> : null}
                      {lastPaymentCheckedAt ? <span>最近检查：{lastPaymentCheckedAt}</span> : null}
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
                <div className="mt-4 flex min-h-[280px] items-center justify-center rounded-box bg-base-200/60 p-4">
                  {activePayment?.order.status === 'paid' ? (
                    <div className="space-y-4 text-center">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-3xl text-success">
                        ✓
                      </div>
                      <div className="space-y-1">
                        <div className="text-lg font-semibold text-base-content">支付成功</div>
                        <div className="text-sm text-base-content/65">会员权益已到账，你可以关闭窗口继续使用。</div>
                      </div>
                    </div>
                  ) : activePayment?.order.status === 'closed' || activePayment?.order.status === 'failed' || activePayment?.order.status === 'refunded' ? (
                    <div className="space-y-4 text-center">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-warning/15 text-3xl text-warning">
                        !
                      </div>
                      <div className="space-y-1">
                        <div className="text-lg font-semibold text-base-content">当前订单不可继续支付</div>
                        <div className="text-sm text-base-content/65">请返回左侧重新创建新的支付订单。</div>
                      </div>
                    </div>
                  ) : paymentQrDataUrl ? (
                    <img src={paymentQrDataUrl} alt="支付二维码" className="h-64 w-64 rounded-box bg-white p-3" />
                  ) : (
                    <div className="space-y-3 text-center text-sm text-base-content/60">
                      <div>创建订单后，这里会显示对应的支付二维码。</div>
                      <div>如暂时无法在线支付，可展开下方人工协助通道。</div>
                    </div>
                  )}
                </div>
                {activePayment ? (
                  <div className="mt-4 space-y-2 text-xs text-base-content/65">
                    <div>订单号：{activePayment.order.orderNo}</div>
                    <div>套餐：{activePayment.product.displayName}</div>
                    <div>金额：¥{(activePayment.order.amount / 100).toFixed(2)}</div>
                    <div>购买方式：{activePayment.order.purchaseMode === 'upgrade_diff_all' ? '补全部差价升级' : activePayment.order.purchaseMode === 'upgrade_replace_month' ? '重新开通 1 个月 Pro Max' : activePayment.order.billingMonths === 12 ? '年付' : activePayment.order.billingMonths === 6 ? '半年付' : '月付'}</div>
                    {activePayment.order.expiresAt ? <div>订单有效期至：{new Date(activePayment.order.expiresAt).toLocaleString('zh-CN', { hour12: false })}</div> : null}
                    {activePayment.checkout.message ? <div>订单说明：{activePayment.checkout.message}</div> : null}
                  </div>
                ) : null}
              </div>

              <div className="rounded-box bg-base-200/60 p-4 text-sm text-base-content/70">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>如需人工协助开通，可使用下方人工通道。</div>
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
                        <div className="mt-1">扫码后说明账号和所需套餐，管理员会在后台协助完成会员开通或虚拟卡处理。</div>
                      </div>
                      <div>
                        <div className="font-semibold text-base-content">适用场景</div>
                        <div className="mt-1">适用于支付通道异常、需要人工确认，或希望先咨询套餐差异的情况。</div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="modal-action">
            <button className="btn btn-outline" onClick={() => setCardDialogOpen(true)}>
              购买虚拟卡
            </button>
            <button className="btn btn-primary" onClick={handleCloseVipDialog}>
              知道了
            </button>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${vipCloseConfirmOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-md">
          <h3 className="text-lg font-bold">确认关闭支付弹窗</h3>
          <p className="mt-3 text-sm text-base-content/70">
            当前订单仍在等待支付。关闭后系统仍会继续轮询支付结果，但你将暂时看不到二维码和状态变化。
          </p>
          <div className="modal-action">
            <button className="btn btn-outline" onClick={() => setVipCloseConfirmOpen(false)}>
              继续支付
            </button>
            <button className="btn btn-primary" onClick={confirmCloseVipDialog}>
              确认关闭
            </button>
          </div>
        </div>
      </dialog>

      <dialog className={`modal ${cardDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-2xl">
          <h3 className="text-xl font-bold">购买虚拟卡</h3>
          <div className="mt-4 space-y-4 text-sm text-base-content/70">
            <div className="rounded-box bg-base-200/60 p-4">
              <div className="text-base font-semibold text-base-content">发放形式</div>
              <div className="mt-1">虚拟卡以卡密形式发放。</div>
            </div>
            <div className="rounded-box bg-base-200/60 p-4">
              <div className="text-base font-semibold text-base-content">价格</div>
              <div className="mt-1">10 元一张。</div>
            </div>
            <div className="rounded-box bg-base-200/60 p-4">
              <div className="text-base font-semibold text-base-content">用途</div>
              <div className="mt-1">可开通企业版 Codex Team，试用一个月期限。</div>
            </div>
            <div className="rounded-box bg-warning/10 p-4 text-warning-content">
              <div className="font-semibold">风险说明</div>
              <div className="mt-1 text-sm text-base-content/80">
                近期封的比较多，建议按需购买。节点干净可以持续使用一个月，节点不干净有概率 3-5 天封。
              </div>
            </div>
            <div className="rounded-box border border-base-300 bg-base-100 p-4">
              <div className="font-semibold text-base-content">购买方式</div>
              <div className="mt-2">当前同样走人工处理。你可以先通过“开通会员”弹窗中的二维码联系，说明需要购买虚拟卡。</div>
            </div>
          </div>
          <div className="modal-action">
            <button
              className="btn btn-primary"
              onClick={() => {
                setCardDialogOpen(false)
                setVipDialogOpen(true)
              }}
            >
              去扫码联系
            </button>
            <button className="btn btn-ghost" onClick={() => setCardDialogOpen(false)}>
              关闭
            </button>
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
        <div className="modal-box max-w-4xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">登录自己账号</h3>
              <p className="text-sm text-base-content/60">直接在当前用户页内登录自己的账号。</p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setOauthDialogOpen(false)}>
              关闭
            </button>
          </div>
          <div className="max-h-[70vh] overflow-auto pr-1">
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

      <dialog className={`modal ${openClawDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-3xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">OpenClaw 接入日志</h3>
              <p className="mt-1 text-sm text-base-content/60">点击后会自动执行接入流程。建议在完成前不要关闭这个窗口。</p>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              disabled={runningOpenClawSetup}
              onClick={() => setOpenClawDialogOpen(false)}
            >
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
            <button
              className="btn btn-primary"
              disabled={runningOpenClawSetup}
              onClick={() => setOpenClawDialogOpen(false)}
            >
              知道了
            </button>
          </div>
        </div>
      </dialog>
    </main>
  )
}
