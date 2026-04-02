import { useEffect, useMemo, useState } from 'react'
import { QuotaPanel } from '../quota/QuotaPanel'
import { PROVIDER_META, PROVIDER_ORDER } from '../quota/providerMeta'
import type { QuotaProvider } from '../quota/types'
import type { CloudFeatures, CloudPlan } from '../../lib/cloud/types'
import type { BootstrapSettings, CpaManagementInfo, CpaState } from '../../lib/cpa/types'
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
  userKey: string
  cloudToken: string
  cpaState: CpaState | null
  settings: BootstrapSettings
  managementInfo: CpaManagementInfo | null
  loadError: string | null
  pendingAction: string | null
  normalizingFreeTier: boolean
  onRefreshSession: () => Promise<{ plan: CloudPlan; features: CloudFeatures } | null>
  onSettingsChange: (updater: (current: BootstrapSettings) => BootstrapSettings) => void
  onSavePort: () => Promise<void>
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

function getSharedSyncStorageKey(userKey: string) {
  return `cpapp-shared-sync-last:${userKey}`
}

function buildSharedLocalFileName(fileName: string) {
  return fileName.startsWith('共享-') ? fileName : `共享-${fileName}`
}

export function UserWorkspace({
  plan,
  features,
  userKey,
  cloudToken,
  cpaState,
  settings,
  managementInfo,
  loadError,
  pendingAction,
  normalizingFreeTier,
  onRefreshSession,
  onSettingsChange,
  onSavePort,
  onStart,
  onRestart,
  onStop,
  onRefresh,
  onNotify,
  onError
}: UserWorkspaceProps) {
  const [activeProvider, setActiveProvider] = useState<QuotaProvider>(PROVIDER_ORDER[0])
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
  const planLabel = useMemo(() => formatPlanLabel(plan.planCode, plan.name), [plan.name, plan.planCode])

  const proxyUrl = useMemo(
    () => `http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`,
    [cpaState?.apiPort, settings.apiPort]
  )

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

  const sharedButtonLabel = useMemo(() => {
    if (syncingSharedPool) {
      return '共享号池更新中'
    }
    if (features.shared_pool_mode === 'sample' && sharedCooldownSeconds > 0) {
      const minutes = Math.floor(sharedCooldownSeconds / 60)
      const seconds = sharedCooldownSeconds % 60
      return `共享号池更新 ${minutes}:${String(seconds).padStart(2, '0')}`
    }
    return '共享号池更新'
  }, [features.shared_pool_mode, sharedCooldownSeconds, syncingSharedPool])

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

            <div className="join shadow-sm ml-auto">
              <div className="join-item flex items-center border border-base-300 bg-base-100 px-3 text-sm">端口</div>
              <input
                type="number"
                min={1}
                max={65535}
                className="join-item input input-bordered input-sm w-24 text-center font-mono"
                value={settings.apiPort}
                onChange={(event) => {
                  onSettingsChange((current) => ({
                    ...current,
                    apiPort: Number(event.target.value || 0)
                  }))
                }}
              />
              <button className="join-item btn btn-primary btn-sm" disabled={pendingAction !== null} onClick={() => void onSavePort()}>
                保存
              </button>
            </div>

            <div className="join shadow-sm">
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
              刷新状态
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

            <button className="btn btn-primary btn-sm" onClick={() => setVipDialogOpen(true)}>
              开通会员
            </button>

            <button className="btn btn-outline btn-sm" onClick={() => setCardDialogOpen(true)}>
              购买虚拟卡
            </button>

            <button className="btn btn-ghost btn-sm" onClick={() => setSharedPoolInfoOpen(true)}>
              共享号池说明
            </button>

            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(proxyUrl)
                onNotify('代理地址已复制')
              }}
            >
              复制代理地址
            </button>

            <button
              className="btn btn-outline btn-sm"
              disabled={!managementInfo?.managementKey}
              onClick={() => {
                void navigator.clipboard.writeText(managementInfo?.managementKey ?? '')
                onNotify('API KEY 已复制')
              }}
            >
              复制调用密钥
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
            onUpgradeVip={() => setVipDialogOpen(true)}
            onOpenOauth={() => setOauthDialogOpen(true)}
            onProviderCountsChange={setProviderCounts}
            onNotify={onNotify}
            onError={onError}
          />
        </div>
      </section>

      <dialog className={`modal ${vipDialogOpen ? 'modal-open' : ''}`}>
        <div className="modal-box max-w-lg">
          <h3 className="text-xl font-bold">开通会员</h3>
          <p className="mt-3 text-sm text-base-content/70">
            当前套餐为 <span className="font-semibold">{planLabel}</span>。
            免费版只能启用一个认证文件，自动切换、共享池和更多并发能力需要升级到 Pro 或 Pro Max。
          </p>
          <div className="mt-4 rounded-box bg-base-200/60 p-4 text-sm text-base-content/70">
            当前支付能力暂未接入。你可以扫码添加客服或进群，后台人工为你开通对应会员权限。
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div className="rounded-box border border-base-300 bg-base-100 p-3">
              <img
                src={vipQrImage}
                alt="会员开通二维码"
                className="h-full w-full rounded-box object-cover"
              />
            </div>
            <div className="space-y-3 text-sm text-base-content/70">
              <div>
                <div className="font-semibold text-base-content">开通方式</div>
                <div className="mt-1">扫码后添加客服或进群，备注你的账号和需要开通的套餐。</div>
              </div>
              <div>
                <div className="font-semibold text-base-content">后台授权</div>
                <div className="mt-1">管理员会在后台直接为你的账号分配 `Pro / Pro Max` 等权限。</div>
              </div>
              <div>
                <div className="font-semibold text-base-content">建议</div>
                <div className="mt-1">如果你主要需要自动切换和共享号池，优先开通 Pro 或 Pro Max 再使用当前用户工作台。</div>
              </div>
            </div>
          </div>
          <div className="modal-action">
            <button className="btn btn-outline" onClick={() => setCardDialogOpen(true)}>
              购买虚拟卡
            </button>
            <button className="btn btn-primary" onClick={() => setVipDialogOpen(false)}>
              知道了
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
              <h3 className="text-xl font-bold">OAuth 授权</h3>
              <p className="text-sm text-base-content/60">直接在当前用户页内完成认证授权。</p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setOauthDialogOpen(false)}>
              关闭
            </button>
          </div>
          <div className="max-h-[70vh] overflow-auto pr-1">
            <OAuthPanel
              canManage={false}
              cpaRunning={cpaState?.status === 'running'}
              visibleProviders={[mapQuotaProviderToOauthProvider(activeProvider)]}
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
