import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { cloudClient } from '../../lib/cloud/client'
import type { CloudAdminUserSummary, CloudPlan } from '../../lib/cloud/types'

interface CloudAdminPanelProps {
  token: string
  onNotify: (message: string) => void
  onError: (message: string | null) => void
}

export function CloudAdminPanel({ token, onNotify, onError }: CloudAdminPanelProps) {
  const sharedUploadRef = useRef<HTMLInputElement | null>(null)
  const [users, setUsers] = useState<CloudAdminUserSummary[]>([])
  const [plans, setPlans] = useState<CloudPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const [draftPlans, setDraftPlans] = useState<Record<number, string>>({})
  const [draftExpiresAt, setDraftExpiresAt] = useState<Record<number, string>>({})

  const load = async (notify = false) => {
    try {
      setLoading(true)
      const [usersResponse, plansResponse] = await Promise.all([
        cloudClient.adminListUsers(token),
        cloudClient.adminListPlans(token)
      ])
      setUsers(usersResponse.users)
      setPlans(plansResponse.plans)
      setDraftPlans((current) => {
        const next = { ...current }
        usersResponse.users.forEach((item) => {
          if (!next[item.user.id]) {
            next[item.user.id] = item.plan.planCode
          }
        })
        return next
      })
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

  const savePlan = async (user: CloudAdminUserSummary) => {
    const planCode = draftPlans[user.user.id] || user.plan.planCode
    const expiresAt = draftExpiresAt[user.user.id]?.trim() || null
    try {
      setSavingUserId(user.user.id)
      await cloudClient.adminAssignPlan(token, user.user.id, {
        plan_code: planCode,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null
      })
      await load()
      onNotify(`已更新 ${user.user.email} 的套餐为 ${planCode}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingUserId(null)
    }
  }

  const handleSharedUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files
    if (!selectedFiles || selectedFiles.length === 0) {
      return
    }
    try {
      setUploading(true)
      for (const file of Array.from(selectedFiles)) {
        await cloudClient.adminUploadSharedAuthFile(token, file)
      }
      onNotify(`已上传 ${selectedFiles.length} 个共享认证文件`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      event.target.value = ''
      setUploading(false)
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-6">
      <input
        ref={sharedUploadRef}
        type="file"
        accept=".json,application/json"
        multiple
        className="hidden"
        onChange={(event) => void handleSharedUpload(event)}
      />

      <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
        <div className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="badge badge-outline badge-primary">Cloud Admin</div>
            <h2 className="mt-2 text-3xl font-black">共享池与用户套餐</h2>
            <p className="mt-2 text-sm text-base-content/60">
              这里管理共享认证池上传，以及给云端账号分配 `plan_code`。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={uploading} onClick={() => sharedUploadRef.current?.click()}>
              {uploading ? <span className="loading loading-spinner loading-xs"></span> : null}
              上传共享认证
            </button>
            <button className="btn btn-outline" disabled={loading} onClick={() => void load(true)}>
              {loading ? <span className="loading loading-spinner loading-xs"></span> : null}
              刷新用户
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
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
              {users.map((item) => (
                <tr key={item.user.id}>
                  <td>{item.user.id}</td>
                  <td>{item.user.email}</td>
                  <td>
                    <span className={`badge ${item.user.role === 'admin' ? 'badge-secondary' : 'badge-ghost'}`}>
                      {item.user.role}
                    </span>
                  </td>
                  <td>
                    <div className="font-semibold">{item.plan.planCode}</div>
                    <div className="text-xs text-base-content/55">{item.plan.name}</div>
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
      </section>
    </div>
  )
}
