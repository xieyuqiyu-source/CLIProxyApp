import { useEffect, useRef, useState } from 'react'
import { cloudClient } from '../../lib/cloud/client'
import type { CloudAdminUserSummary, CloudAuthFile, CloudPaymentOrder, CloudPaymentProduct, CloudPlan } from '../../lib/cloud/types'
import { cpaRuntime } from '../../lib/cpa/runtime'

interface CloudAdminPanelProps {
  token: string
  onNotify: (message: string) => void
  onError: (message: string | null) => void
}

type AdminSection = 'overview' | 'users' | 'payments' | 'publish'
type SharedCredentialMode = 'plain' | 'quota_card'

export function CloudAdminPanel({ token, onNotify, onError }: CloudAdminPanelProps) {
  const USERS_PAGE_SIZE = 10
  const releaseInputRef = useRef<HTMLInputElement | null>(null)
  const [section, setSection] = useState<AdminSection>('overview')
  const [users, setUsers] = useState<CloudAdminUserSummary[]>([])
  const [plans, setPlans] = useState<CloudPlan[]>([])
  const [sharedCloudFiles, setSharedCloudFiles] = useState<CloudAuthFile[]>([])
  const [paymentProducts, setPaymentProducts] = useState<CloudPaymentProduct[]>([])
  const [paymentOrders, setPaymentOrders] = useState<CloudPaymentOrder[]>([])
  const [paymentOrderStatusFilter, setPaymentOrderStatusFilter] = useState<'all' | 'pending' | 'paid' | 'closed' | 'failed' | 'refunded'>('all')
  const [paymentOrderQuery, setPaymentOrderQuery] = useState('')
  const [userPage, setUserPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadingRelease, setUploadingRelease] = useState(false)
  const [clearingSharedPool, setClearingSharedPool] = useState(false)
  const [deletingSharedFileId, setDeletingSharedFileId] = useState<number | null>(null)
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const [savingPaymentProductId, setSavingPaymentProductId] = useState<number | null>(null)
  const [creatingPaymentProduct, setCreatingPaymentProduct] = useState(false)
  const [regrantingOrderNo, setRegrantingOrderNo] = useState<string | null>(null)
  const [draftRoles, setDraftRoles] = useState<Record<number, 'user' | 'admin'>>({})
  const [draftPlans, setDraftPlans] = useState<Record<number, string>>({})
  const [draftExpiresAt, setDraftExpiresAt] = useState<Record<number, string>>({})
  const [draftPaymentProducts, setDraftPaymentProducts] = useState<Record<number, CloudPaymentProduct>>({})
  const [releaseVersion, setReleaseVersion] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [sharedCredentialMode, setSharedCredentialMode] = useState<SharedCredentialMode>('plain')
  const [sharedQuotaLimit, setSharedQuotaLimit] = useState(200)
  const [newProduct, setNewProduct] = useState({
    product_code: '',
    name: '',
    display_name: '',
    plan_code: 'vip1',
    price_amount: 0,
    currency: 'CNY',
    duration_days: 30,
    status: 'active',
    sort_order: 100,
    description: ''
  })

  const load = async (notify = false, orderOptions?: { status?: string; query?: string }) => {
    try {
      setLoading(true)
      const [usersResponse, plansResponse, sharedResponse, paymentProductsResponse, paymentOrdersResponse] = await Promise.all([
        cloudClient.adminListUsers(token),
        cloudClient.adminListPlans(token),
        cloudClient.listSharedAuthFiles(token),
        cloudClient.adminListPaymentProducts(token),
        cloudClient.adminListPaymentOrders(token, {
          limit: 50,
          status: orderOptions?.status ?? paymentOrderStatusFilter,
          query: orderOptions?.query ?? paymentOrderQuery
        })
      ])
      setUsers(usersResponse.users)
      setPlans(plansResponse.plans)
      setSharedCloudFiles(Array.isArray(sharedResponse.files) ? sharedResponse.files : [])
      setPaymentProducts(paymentProductsResponse.products)
      setPaymentOrders(paymentOrdersResponse.orders)
      setDraftRoles((current) => {
        const next = { ...current }
        usersResponse.users.forEach((item) => {
          if (!next[item.user.id]) {
            next[item.user.id] = item.user.role === 'admin' ? 'admin' : 'user'
          }
        })
        return next
      })
      setDraftPlans((current) => {
        const next = { ...current }
        usersResponse.users.forEach((item) => {
          if (!next[item.user.id]) {
            next[item.user.id] = item.plan.planCode
          }
        })
        return next
      })
      setDraftExpiresAt((current) => {
        const next = { ...current }
        usersResponse.users.forEach((item) => {
          if (!(item.user.id in next)) {
            next[item.user.id] = item.expiresAt ? item.expiresAt.slice(0, 16) : ''
          }
        })
        return next
      })
      setDraftPaymentProducts(
        Object.fromEntries(paymentProductsResponse.products.map((item) => [item.id, item]))
      )
      if (notify) {
        onNotify('云端用户与套餐数据已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [token])

  const handleRefreshPaymentOrders = async () => {
    await load(false, {
      status: paymentOrderStatusFilter,
      query: paymentOrderQuery.trim()
    })
  }

  const handleRegrantOrder = async (orderNo: string) => {
    try {
      setRegrantingOrderNo(orderNo)
      await cloudClient.adminRegrantPaymentOrder(token, orderNo)
      await handleRefreshPaymentOrders()
      onNotify(`已重新发放订单 ${orderNo} 对应的会员权益`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRegrantingOrderNo(null)
    }
  }

  const savePlan = async (user: CloudAdminUserSummary) => {
    const role = draftRoles[user.user.id] || user.user.role
    const planCode = draftPlans[user.user.id] || user.plan.planCode
    const expiresAt = draftExpiresAt[user.user.id]?.trim() || null
    try {
      setSavingUserId(user.user.id)
      if (role !== user.user.role) {
        await cloudClient.adminUpdateUserRole(token, user.user.id, { role })
      }
      await cloudClient.adminAssignPlan(token, user.user.id, {
        plan_code: planCode,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null
      })
      await load()
      onNotify(`已更新 ${user.user.email} 的角色和套餐`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingUserId(null)
    }
  }

  const uploadSharedFiles = async (selectedFiles: Array<{ name: string; bytes: number[] }>) => {
    if (!selectedFiles || selectedFiles.length === 0) {
      return
    }
    try {
      setUploading(true)
      for (const file of selectedFiles) {
        const blob = new Blob([new Uint8Array(file.bytes)], { type: 'application/json' })
        const uploadFile = new File([blob], file.name, { type: 'application/json' })
        const response = await cloudClient.adminUploadSharedAuthFile(token, uploadFile, {
          distributionMode: sharedCredentialMode,
          quotaLimit: sharedCredentialMode === 'quota_card' ? sharedQuotaLimit : 0
        })
        if (sharedCredentialMode === 'quota_card' && response.file?.distributionMode !== 'quota_card') {
          throw new Error('后端没有保存为加密额度卡，请确认 Cloud 服务已更新到最新代码')
        }
      }
      await load()
      onNotify(`已上传 ${selectedFiles.length} 个共享认证文件`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const handleSharedUploadClick = async () => {
    try {
      const files = await cpaRuntime.pickLocalAuthFiles()
      await uploadSharedFiles(files)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const clearSharedPool = async () => {
    try {
      setClearingSharedPool(true)
      const result = await cloudClient.adminDeleteAllSharedAuthFiles(token)
      await load()
      onNotify(`已清空共享号池，共删除 ${result.deleted} 个文件`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setClearingSharedPool(false)
    }
  }

  const deleteSharedFile = async (file: CloudAuthFile) => {
    try {
      setDeletingSharedFileId(file.id)
      await cloudClient.adminDeleteSharedAuthFile(token, file.id)
      await load()
      onNotify(`已删除共享认证：${file.displayName || file.fileName}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingSharedFileId(null)
    }
  }

  const handleReleaseUploadSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    if (!releaseVersion.trim()) {
      onError('请先填写版本号，再上传安装包')
      return
    }
    try {
      setUploadingRelease(true)
      const response = await cloudClient.adminUploadAppRelease(token, file, {
        version: releaseVersion.trim(),
        notes: releaseNotes.trim()
      })
      onNotify(`已上传更新包并刷新 latest.json：${response.manifest.version}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploadingRelease(false)
    }
  }

  const savePaymentProduct = async (productId: number) => {
    const draft = draftPaymentProducts[productId]
    if (!draft) {
      return
    }
    try {
      setSavingPaymentProductId(productId)
      await cloudClient.adminUpdatePaymentProduct(token, productId, {
        product_code: draft.productCode,
        name: draft.name,
        display_name: draft.displayName,
        plan_code: draft.planCode,
        price_amount: Number(draft.priceAmount),
        currency: draft.currency,
        duration_days: Number(draft.durationDays),
        status: draft.status,
        sort_order: Number(draft.sortOrder),
        description: draft.description
      })
      await load()
      onNotify(`已更新商品：${draft.displayName}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingPaymentProductId(null)
    }
  }

  const createPaymentProduct = async () => {
    try {
      setCreatingPaymentProduct(true)
      await cloudClient.adminCreatePaymentProduct(token, {
        product_code: newProduct.product_code,
        name: newProduct.name,
        display_name: newProduct.display_name,
        plan_code: newProduct.plan_code,
        price_amount: Number(newProduct.price_amount),
        currency: newProduct.currency,
        duration_days: Number(newProduct.duration_days),
        status: newProduct.status,
        sort_order: Number(newProduct.sort_order),
        description: newProduct.description
      })
      setNewProduct({
        product_code: '',
        name: '',
        display_name: '',
        plan_code: 'vip1',
        price_amount: 0,
        currency: 'CNY',
        duration_days: 30,
        status: 'active',
        sort_order: 100,
        description: ''
      })
      await load()
      onNotify('已创建支付商品')
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreatingPaymentProduct(false)
    }
  }

  const formatSharedModeLabel = (file: CloudAuthFile) =>
    file.distributionMode === 'quota_card' ? '加密额度卡' : '普通凭证'

  const activePaidUsers = users.filter((item) => ['vip1', 'vip2'].includes(item.plan.planCode)).length
  const adminUsers = users.filter((item) => item.user.role === 'admin').length
  const activeProducts = paymentProducts.filter((item) => item.status === 'active').length
  const pendingOrders = paymentOrders.filter((item) => item.status === 'pending').length
  const recentOrders = paymentOrders.slice(0, 5)
  const totalUserPages = Math.max(1, Math.ceil(users.length / USERS_PAGE_SIZE))
  const currentUserPage = Math.min(userPage, totalUserPages)
  const paginatedUsers = users.slice((currentUserPage - 1) * USERS_PAGE_SIZE, currentUserPage * USERS_PAGE_SIZE)

  return (
    <div className="mt-4 flex flex-col gap-6">
      <input
        ref={releaseInputRef}
        type="file"
        className="hidden"
        accept=".dmg,.exe,.zip"
        onChange={(event) => void handleReleaseUploadSelection(event)}
      />
      <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
        <div className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-3xl font-black">云端后台</h2>
          </div>
          <button className="btn btn-outline" disabled={loading} onClick={() => void load(true)}>
            {loading ? <span className="loading loading-spinner loading-xs"></span> : null}
            刷新数据
          </button>
        </div>
      </section>

      <div className="tabs tabs-boxed bg-base-200 p-1.5">
        <button className={`tab text-base font-semibold transition-colors ${section === 'overview' ? 'tab-active text-primary' : 'text-base-content/70'}`} onClick={() => setSection('overview')}>
          总览
        </button>
        <button className={`tab text-base font-semibold transition-colors ${section === 'users' ? 'tab-active text-primary' : 'text-base-content/70'}`} onClick={() => setSection('users')}>
          用户
        </button>
        <button className={`tab text-base font-semibold transition-colors ${section === 'payments' ? 'tab-active text-primary' : 'text-base-content/70'}`} onClick={() => setSection('payments')}>
          支付
        </button>
        <button className={`tab text-base font-semibold transition-colors ${section === 'publish' ? 'tab-active text-primary' : 'text-base-content/70'}`} onClick={() => setSection('publish')}>
          发布
        </button>
      </div>

      {section === 'overview' ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
              <div className="text-sm text-base-content/60">用户总数</div>
              <div className="mt-2 text-3xl font-black">{users.length}</div>
              <div className="mt-2 text-xs text-base-content/50">管理员 {adminUsers} / 付费用户 {activePaidUsers}</div>
            </div>
            <div className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
              <div className="text-sm text-base-content/60">支付商品</div>
              <div className="mt-2 text-3xl font-black">{paymentProducts.length}</div>
              <div className="mt-2 text-xs text-base-content/50">上架中 {activeProducts}</div>
            </div>
            <div className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
              <div className="text-sm text-base-content/60">支付订单</div>
              <div className="mt-2 text-3xl font-black">{paymentOrders.length}</div>
              <div className="mt-2 text-xs text-base-content/50">待支付 {pendingOrders}</div>
            </div>
            <div className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
              <div className="text-sm text-base-content/60">共享号池操作</div>
              <div className="mt-3 flex flex-col gap-2">
                <select
                  className="select select-bordered select-sm"
                  value={sharedCredentialMode}
                  onChange={(event) => setSharedCredentialMode(event.target.value === 'quota_card' ? 'quota_card' : 'plain')}
                >
                  <option value="plain">普通凭证</option>
                  <option value="quota_card">加密额度卡</option>
                </select>
                {sharedCredentialMode === 'quota_card' ? (
                  <input
                    type="number"
                    min={1}
                    className="input input-bordered input-sm"
                    value={sharedQuotaLimit}
                    onChange={(event) => setSharedQuotaLimit(Math.max(1, Number(event.target.value) || 1))}
                  />
                ) : null}
                <button className="btn btn-primary btn-sm" disabled={uploading} onClick={() => void handleSharedUploadClick()}>
                  {uploading ? <span className="loading loading-spinner loading-xs"></span> : null}
                  上传共享认证
                </button>
                <button className="btn btn-outline btn-error btn-sm" disabled={clearingSharedPool} onClick={() => void clearSharedPool()}>
                  {clearingSharedPool ? <span className="loading loading-spinner loading-xs"></span> : null}
                  清空共享号池
                </button>
              </div>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <div className="rounded-box border border-base-300 bg-base-100 shadow-sm">
              <div className="border-b border-base-300 px-6 py-4">
                <h3 className="text-xl font-bold">最近订单</h3>
                <p className="mt-1 text-sm text-base-content/60">快速查看最近支付记录和当前状态。</p>
              </div>
              <div className="overflow-x-auto p-4">
                <table className="table table-zebra">
                  <thead>
                    <tr>
                      <th>订单号</th>
                      <th>套餐</th>
                      <th>金额</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id}>
                        <td className="font-mono text-xs">{order.orderNo}</td>
                        <td>{order.planCode}</td>
                        <td>¥{(order.amount / 100).toFixed(2)} {order.currency}</td>
                        <td><span className="badge badge-outline">{order.status}</span></td>
                      </tr>
                    ))}
                    {recentOrders.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center text-sm text-base-content/50">暂无订单</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-box border border-base-300 bg-base-100 shadow-sm">
              <div className="border-b border-base-300 px-6 py-4">
                <h3 className="text-xl font-bold">更新发布</h3>
                <p className="mt-1 text-sm text-base-content/60">上传新安装包后，后端会自动刷新 latest.json。</p>
              </div>
              <div className="grid gap-5 p-6">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-base-content/70">版本号</span>
                  <input className="input input-bordered h-12" placeholder="例如 0.1.7" value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-base-content/70">更新说明</span>
                  <input className="input input-bordered h-12" placeholder="可选，写到 latest.json 里" value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} />
                </label>
                <button className="btn btn-secondary" disabled={uploadingRelease} onClick={() => releaseInputRef.current?.click()}>
                  {uploadingRelease ? <span className="loading loading-spinner loading-xs"></span> : null}
                  上传更新包
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {section === 'users' ? (
        <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="border-b border-base-300 px-6 py-4">
            <h3 className="text-xl font-bold">用户与套餐</h3>
            <p className="mt-1 text-sm text-base-content/60">集中管理账号角色、套餐和到期时间。</p>
          </div>
          <div className="overflow-x-auto p-4">
            <table className="table table-zebra">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>当前套餐</th>
                  <th>新套餐</th>
                  <th>到期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {paginatedUsers.map((item) => (
                  <tr key={item.user.id}>
                    <td>{item.user.id}</td>
                    <td>{item.user.email}</td>
                    <td>
                      <select
                        className="select select-bordered select-sm w-28"
                        value={draftRoles[item.user.id] ?? (item.user.role === 'admin' ? 'admin' : 'user')}
                        onChange={(event) =>
                          setDraftRoles((current) => ({
                            ...current,
                            [item.user.id]: event.target.value === 'admin' ? 'admin' : 'user'
                          }))
                        }
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      <div className="font-semibold">{item.plan.planCode}</div>
                      <div className="text-xs text-base-content/55">{item.plan.name}</div>
                      <div className="mt-1 text-xs text-base-content/45">
                        到期：{item.expiresAt ? new Date(item.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '未设置'}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select select-bordered select-sm w-32"
                        value={draftPlans[item.user.id] ?? item.plan.planCode}
                        onChange={(event) =>
                          setDraftPlans((current) => ({
                            ...current,
                            [item.user.id]: event.target.value
                          }))
                        }
                      >
                        {plans.map((plan) => (
                          <option key={plan.id} value={plan.planCode}>
                            {plan.planCode}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="datetime-local"
                        className="input input-bordered input-sm w-56"
                        value={draftExpiresAt[item.user.id] ?? ''}
                        onChange={(event) =>
                          setDraftExpiresAt((current) => ({
                            ...current,
                            [item.user.id]: event.target.value
                          }))
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={savingUserId === item.user.id}
                        onClick={() => void savePlan(item)}
                      >
                        {savingUserId === item.user.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                        保存
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 px-6 py-4">
            <div className="text-sm text-base-content/60">
              第 {currentUserPage} / {totalUserPages} 页，共 {users.length} 个用户
            </div>
            <div className="join">
              <button
                className="btn btn-sm join-item"
                disabled={currentUserPage <= 1}
                onClick={() => setUserPage((page) => Math.max(1, page - 1))}
              >
                上一页
              </button>
              <button
                className="btn btn-sm join-item"
                disabled={currentUserPage >= totalUserPages}
                onClick={() => setUserPage((page) => Math.min(totalUserPages, page + 1))}
              >
                下一页
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {section === 'payments' ? (
        <div className="grid gap-6">
          <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
            <div className="border-b border-base-300 px-6 py-4">
              <h3 className="text-xl font-bold">支付商品与价格</h3>
              <p className="mt-1 text-sm text-base-content/60">维护 Pro / Pro Max 的价格、时长、排序和上下架状态。</p>
            </div>
            <div className="overflow-x-auto p-4">
              <table className="table table-zebra">
                <thead>
                  <tr>
                    <th>编码</th>
                    <th>显示名</th>
                    <th>套餐</th>
                    <th>价格(元)</th>
                    <th>时长(天)</th>
                    <th>状态</th>
                    <th>排序</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentProducts.map((item) => {
                    const draft = draftPaymentProducts[item.id] ?? item
                    return (
                      <tr key={item.id}>
                        <td className="min-w-40">
                          <input className="input input-bordered input-sm w-full" value={draft.productCode} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, productCode: event.target.value } }))} />
                        </td>
                        <td className="min-w-40">
                          <input className="input input-bordered input-sm w-full" value={draft.displayName} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, displayName: event.target.value } }))} />
                        </td>
                        <td>
                          <select className="select select-bordered select-sm w-32" value={draft.planCode} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, planCode: event.target.value } }))}>
                            {plans.map((plan) => (
                              <option key={plan.id} value={plan.planCode}>{plan.planCode}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input type="number" step="0.01" className="input input-bordered input-sm w-28" value={(draft.priceAmount / 100).toFixed(2)} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, priceAmount: Math.round((Number(event.target.value) || 0) * 100) } }))} />
                        </td>
                        <td>
                          <input type="number" className="input input-bordered input-sm w-24" value={draft.durationDays} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, durationDays: Number(event.target.value) } }))} />
                        </td>
                        <td>
                          <select className="select select-bordered select-sm w-28" value={draft.status} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, status: event.target.value as 'active' | 'disabled' } }))}>
                            <option value="active">active</option>
                            <option value="disabled">disabled</option>
                          </select>
                        </td>
                        <td>
                          <input type="number" className="input input-bordered input-sm w-20" value={draft.sortOrder} onChange={(event) => setDraftPaymentProducts((current) => ({ ...current, [item.id]: { ...draft, sortOrder: Number(event.target.value) } }))} />
                        </td>
                        <td>
                          <button className="btn btn-primary btn-sm" disabled={savingPaymentProductId === item.id} onClick={() => void savePaymentProduct(item.id)}>
                            {savingPaymentProductId === item.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                            保存
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td><input className="input input-bordered input-sm w-full" value={newProduct.product_code} onChange={(event) => setNewProduct((current) => ({ ...current, product_code: event.target.value }))} /></td>
                    <td><input className="input input-bordered input-sm w-full" value={newProduct.display_name} onChange={(event) => setNewProduct((current) => ({ ...current, display_name: event.target.value, name: event.target.value || current.name }))} /></td>
                    <td>
                      <select className="select select-bordered select-sm w-32" value={newProduct.plan_code} onChange={(event) => setNewProduct((current) => ({ ...current, plan_code: event.target.value }))}>
                        {plans.map((plan) => (
                          <option key={plan.id} value={plan.planCode}>{plan.planCode}</option>
                        ))}
                      </select>
                    </td>
                    <td><input type="number" step="0.01" className="input input-bordered input-sm w-28" value={(newProduct.price_amount / 100).toFixed(2)} onChange={(event) => setNewProduct((current) => ({ ...current, price_amount: Math.round((Number(event.target.value) || 0) * 100) }))} /></td>
                    <td><input type="number" className="input input-bordered input-sm w-24" value={newProduct.duration_days} onChange={(event) => setNewProduct((current) => ({ ...current, duration_days: Number(event.target.value) }))} /></td>
                    <td>
                      <select className="select select-bordered select-sm w-28" value={newProduct.status} onChange={(event) => setNewProduct((current) => ({ ...current, status: event.target.value }))}>
                        <option value="active">active</option>
                        <option value="disabled">disabled</option>
                      </select>
                    </td>
                    <td><input type="number" className="input input-bordered input-sm w-20" value={newProduct.sort_order} onChange={(event) => setNewProduct((current) => ({ ...current, sort_order: Number(event.target.value) }))} /></td>
                    <td>
                      <button className="btn btn-secondary btn-sm" disabled={creatingPaymentProduct} onClick={() => void createPaymentProduct()}>
                        {creatingPaymentProduct ? <span className="loading loading-spinner loading-xs"></span> : null}
                        新增
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
            <div className="border-b border-base-300 px-6 py-4">
              <h3 className="text-xl font-bold">支付订单</h3>
              <p className="mt-1 text-sm text-base-content/60">支持按状态筛选、搜索订单，并对已支付订单执行重新发放。</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-6 pt-4">
              <select
                className="select select-bordered select-sm w-40"
                value={paymentOrderStatusFilter}
                onChange={(event) => setPaymentOrderStatusFilter(event.target.value as typeof paymentOrderStatusFilter)}
              >
                <option value="all">全部状态</option>
                <option value="pending">待支付</option>
                <option value="paid">已支付</option>
                <option value="closed">已关闭</option>
                <option value="failed">支付失败</option>
                <option value="refunded">已退款</option>
              </select>
              <input
                className="input input-bordered input-sm w-72"
                placeholder="搜索订单号 / 套餐 / 商品 / 渠道 / 用户ID"
                value={paymentOrderQuery}
                onChange={(event) => setPaymentOrderQuery(event.target.value)}
              />
              <button className="btn btn-outline btn-sm" onClick={() => void handleRefreshPaymentOrders()}>
                刷新订单
              </button>
            </div>
            <div className="overflow-x-auto p-4">
              <table className="table table-zebra">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>用户</th>
                    <th>商品</th>
                    <th>套餐</th>
                    <th>渠道</th>
                    <th>金额</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentOrders.map((order) => (
                    <tr key={order.id}>
                      <td className="font-mono text-xs">{order.orderNo}</td>
                      <td>{order.userId}</td>
                      <td>{order.productDisplayName || order.productCode || '-'}</td>
                      <td>{order.planCode}</td>
                      <td>{order.paymentProvider}</td>
                      <td>¥{(order.amount / 100).toFixed(2)} {order.currency}</td>
                      <td><span className="badge badge-outline">{order.status}</span></td>
                      <td>{order.createdAt ? new Date(order.createdAt).toLocaleString() : '-'}</td>
                      <td>
                        <button
                          className="btn btn-outline btn-sm"
                          disabled={order.status !== 'paid' || regrantingOrderNo === order.orderNo}
                          onClick={() => void handleRegrantOrder(order.orderNo)}
                        >
                          {regrantingOrderNo === order.orderNo ? <span className="loading loading-spinner loading-xs"></span> : null}
                          重新发放
                        </button>
                      </td>
                    </tr>
                  ))}
                  {paymentOrders.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center text-sm text-base-content/50">当前筛选条件下暂无订单</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {section === 'publish' ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
            <div className="border-b border-base-300 px-6 py-4">
              <h3 className="text-xl font-bold">共享号池</h3>
              <p className="mt-1 text-sm text-base-content/60">上传共享认证时，同名文件会自动覆盖旧文件。</p>
            </div>
            <div className="flex flex-col gap-5 p-6">
              <div className="grid gap-3 rounded-box border border-base-300 bg-base-200/40 p-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-base-content/70">上传方式</span>
                  <select
                    className="select select-bordered"
                    value={sharedCredentialMode}
                    onChange={(event) => setSharedCredentialMode(event.target.value === 'quota_card' ? 'quota_card' : 'plain')}
                  >
                    <option value="plain">普通凭证：下载到用户本地</option>
                    <option value="quota_card">加密额度卡：不下发原凭证</option>
                  </select>
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-base-content/70">卡片额度</span>
                  <input
                    type="number"
                    min={1}
                    className="input input-bordered"
                    disabled={sharedCredentialMode !== 'quota_card'}
                    value={sharedQuotaLimit}
                    onChange={(event) => setSharedQuotaLimit(Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="badge badge-outline">{sharedCloudFiles.length} 个共享认证</span>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary btn-sm" disabled={uploading} onClick={() => void handleSharedUploadClick()}>
                    {uploading ? <span className="loading loading-spinner loading-xs"></span> : null}
                    上传共享认证
                  </button>
                  <button className="btn btn-outline btn-error btn-sm" disabled={clearingSharedPool} onClick={() => void clearSharedPool()}>
                    {clearingSharedPool ? <span className="loading loading-spinner loading-xs"></span> : null}
                    清空共享号池
                  </button>
                </div>
              </div>

              {sharedCloudFiles.length === 0 ? (
                <div className="rounded-box border border-dashed border-base-300 px-4 py-8 text-sm text-base-content/55">
                  当前共享号池还是空的。
                </div>
              ) : (
                <div className="space-y-3">
                  {sharedCloudFiles.map((file) => (
                    <div key={file.id} className="rounded-box border border-base-300 bg-base-100 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{file.displayName || file.fileName}</div>
                          <div className="mt-1 text-sm text-base-content/60">
                            {file.provider} · {file.fileName}
                            {file.planRequired ? ` · ${file.planRequired}` : ''}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className={`badge ${file.distributionMode === 'quota_card' ? 'badge-warning' : 'badge-ghost'}`}>
                              {formatSharedModeLabel(file)}
                            </span>
                            {file.distributionMode === 'quota_card' ? (
                              <span className="badge badge-outline">
                                {file.quotaUsed ?? 0} / {file.quotaLimit ?? 0}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <button
                          className="btn btn-outline btn-error btn-sm"
                          disabled={deletingSharedFileId === file.id || clearingSharedPool}
                          onClick={() => void deleteSharedFile(file)}
                        >
                          {deletingSharedFileId === file.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
            <div className="border-b border-base-300 px-6 py-4">
              <h3 className="text-xl font-bold">应用更新</h3>
              <p className="mt-1 text-sm text-base-content/60">上传安装包后自动更新下载清单。</p>
            </div>
            <div className="grid gap-5 p-6">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-base-content/70">版本号</span>
                <input className="input input-bordered h-12" placeholder="例如 0.1.7" value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-base-content/70">更新说明</span>
                <input className="input input-bordered h-12" placeholder="可选，写到 latest.json 里" value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} />
              </label>
              <button className="btn btn-secondary" disabled={uploadingRelease} onClick={() => releaseInputRef.current?.click()}>
                {uploadingRelease ? <span className="loading loading-spinner loading-xs"></span> : null}
                上传更新包
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
