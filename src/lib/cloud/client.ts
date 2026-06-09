import { cpaRuntime } from '../cpa/runtime'
import type {
  CloudAppReleaseManifest,
  CloudCreatePaymentOrderResponse,
  CloudLoginChallengeResponse,
  CloudLoginConflictResponse,
  CloudRegisterChallengeResponse,
  CloudQuotePaymentOrderResponse,
  CloudPaymentOrder,
  CloudPaymentProduct,
  CloudAdminUserSummary,
  CloudAuthFile,
  CloudLoginResponse,
  CloudMeResponse,
  CloudRegisterResponse,
  SharedSyncPackage
} from './types'

const DEVICE_ID_KEY = 'cpapp-cloud-device-id'
const TRUSTED_DEVICE_KEY = 'cpapp-cloud-trusted-device'

function normalizeAccountKey(account: string) {
  const normalized = account.trim()
  return normalized.includes('@') ? normalized.toLowerCase() : normalized
}

function resolveDeviceId(account: string) {
  const scopedKey = `${DEVICE_ID_KEY}:${normalizeAccountKey(account)}`
  const existing = window.localStorage.getItem(scopedKey)
  if (existing) {
    return existing
  }
  const next = crypto.randomUUID()
  window.localStorage.setItem(scopedKey, next)
  return next
}

async function request<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  return cpaRuntime.proxyCloudRequest({
    method: init?.method ?? 'GET',
    path,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    token
  }) as Promise<T>
}

interface TrustedDeviceLoginCache {
  email: string
  deviceId: string
  trustedToken: string
  trustedUntil?: string | null
}

async function download(path: string, token: string): Promise<{ fileName: string; bytes: number[] }> {
  return cpaRuntime.proxyCloudDownload({
    path,
    token
  })
}

async function uploadForm<T>(path: string, file: File, token: string): Promise<T> {
  return cpaRuntime.proxyCloudUpload({
    path,
    fileName: file.name,
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    mimeType: file.type || 'application/octet-stream',
    token
  }) as Promise<T>
}

async function uploadFormWithFields<T>(
  path: string,
  file: File,
  token: string,
  fields: Record<string, string>
): Promise<T> {
  return cpaRuntime.proxyCloudUpload({
    path,
    fileName: file.name,
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    mimeType: file.type || 'application/octet-stream',
    fields,
    token
  }) as Promise<T>
}

export const cloudClient = {
  getDeviceId: (account: string) => resolveDeviceId(account),

  getTrustedDeviceLogin: (): TrustedDeviceLoginCache | null => {
    const raw = window.localStorage.getItem(TRUSTED_DEVICE_KEY)
    if (!raw) {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TrustedDeviceLoginCache>
      const email = normalizeAccountKey(String(parsed.email ?? ''))
      const deviceId = String(parsed.deviceId ?? '').trim()
      const trustedToken = String(parsed.trustedToken ?? '').trim()
      const trustedUntil = parsed.trustedUntil ? String(parsed.trustedUntil) : null
      if (!email || !deviceId || !trustedToken) {
        window.localStorage.removeItem(TRUSTED_DEVICE_KEY)
        return null
      }
      return { email, deviceId, trustedToken, trustedUntil }
    } catch {
      window.localStorage.removeItem(TRUSTED_DEVICE_KEY)
      return null
    }
  },

  saveTrustedDeviceLogin: (payload: TrustedDeviceLoginCache) => {
    window.localStorage.setItem(TRUSTED_DEVICE_KEY, JSON.stringify(payload))
  },

  clearTrustedDeviceLogin: () => {
    window.localStorage.removeItem(TRUSTED_DEVICE_KEY)
  },

  register: (email: string, password: string) =>
    request<CloudRegisterChallengeResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password
      })
    }),

  verifyRegister: (email: string, challengeId: string, code: string) =>
    request<CloudRegisterResponse>('/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        email,
        challenge_id: challengeId,
        code
      })
    }),

  login: (email: string, password: string, trustDevice = true) =>
    request<CloudLoginResponse | CloudLoginChallengeResponse>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          device_id: resolveDeviceId(email),
          device_name: 'CPSwitch',
          platform: navigator.platform || 'desktop',
          trust_device: trustDevice
        })
      }
    ),

  verifyLogin: (
    email: string,
    challengeId: string,
    code: string,
    trustDevice = true,
    forceLogoutExisting = false
  ) =>
    request<CloudLoginResponse | CloudLoginConflictResponse>(
      '/auth/login/verify',
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          challenge_id: challengeId,
          code,
          trust_device: trustDevice,
          force_logout_existing: forceLogoutExisting
        })
      }
    ),

  loginTrustedDevice: (email: string, trustedToken: string) =>
    request<CloudLoginResponse>(
      '/auth/device-login',
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          device_id: resolveDeviceId(email),
          device_name: 'CPSwitch',
          platform: navigator.platform || 'desktop',
          trusted_token: trustedToken
        })
      }
    ),

  me: (token: string) => request<CloudMeResponse>('/me', { method: 'GET' }, token),

  logout: (token: string) => request<{ status: string }>('/me/logout', { method: 'POST' }, token),

  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<{ status: string }>(
      '/me/change-password',
      {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword
        })
      },
      token
    ),

  listMyAuthFiles: (token: string) =>
    request<{ files: CloudAuthFile[] }>('/me/auth-files', { method: 'GET' }, token),

  uploadMyAuthFile: (token: string, file: File) =>
    uploadForm<{ file: CloudAuthFile }>('/me/auth-files/upload', file, token),

  downloadMyAuthFile: (token: string, id: number) =>
    download(`/me/auth-files/${id}/download`, token),

  deleteMyAuthFile: (token: string, id: number) =>
    request<{ status: string }>(`/me/auth-files/${id}`, { method: 'DELETE' }, token),

  deleteAllMyAuthFiles: (token: string) =>
    request<{ status: string; deleted: number }>('/me/auth-files', { method: 'DELETE' }, token),

  listSharedAuthFiles: (token: string) =>
    request<{ files: CloudAuthFile[] }>('/shared/auth-files', { method: 'GET' }, token),

  getSharedSyncPackage: (token: string) =>
    request<SharedSyncPackage>('/shared/auth-files/sync-package', { method: 'GET' }, token),

  downloadSharedAuthFile: (token: string, id: number) =>
    download(`/shared/auth-files/${id}/download`, token),

  adminListUsers: (token: string) =>
    request<{ users: CloudAdminUserSummary[] }>('/admin/users', { method: 'GET' }, token),

  adminListPlans: (token: string) =>
    request<{ plans: Array<{ id: number; planCode: string; name: string; description: string }> }>(
      '/admin/plans',
      { method: 'GET' },
      token
    ),

  adminAssignPlan: (token: string, userId: number, payload: { plan_code: string; expires_at?: string | null }) =>
    request<{ status: string }>(
      `/admin/users/${userId}/plan`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      },
      token
    ),

  adminUpdateUserRole: (token: string, userId: number, payload: { role: 'user' | 'admin' }) =>
    request<{ status: string }>(
      `/admin/users/${userId}/role`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      },
      token
    ),

  listPaymentProducts: (token: string) =>
    request<{ products: CloudPaymentProduct[] }>('/pay/products', { method: 'GET' }, token),

  quotePaymentOrder: (
    token: string,
    payload: {
      product_code: string
      billing_months: number
      purchase_mode: 'standard' | 'upgrade_diff_all' | 'upgrade_replace_month'
    }
  ) =>
    request<CloudQuotePaymentOrderResponse>(
      '/pay/quote',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      },
      token
    ),

  adminListPaymentProducts: (token: string) =>
    request<{ products: CloudPaymentProduct[] }>('/admin/pay/products', { method: 'GET' }, token),

  adminCreatePaymentProduct: (
    token: string,
    payload: {
      product_code: string
      name: string
      display_name: string
      plan_code: string
      price_amount: number
      currency: string
      duration_days: number
      status: string
      sort_order: number
      description: string
    }
  ) =>
    request<{ product: CloudPaymentProduct }>(
      '/admin/pay/products',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      },
      token
    ),

  adminUpdatePaymentProduct: (
    token: string,
    id: number,
    payload: Partial<{
      product_code: string
      name: string
      display_name: string
      plan_code: string
      price_amount: number
      currency: string
      duration_days: number
      status: string
      sort_order: number
      description: string
    }>
  ) =>
    request<{ product: CloudPaymentProduct }>(
      `/admin/pay/products/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      },
      token
    ),

  adminListPaymentOrders: (token: string, options?: { limit?: number; status?: string; query?: string }) => {
    const params = new URLSearchParams()
    params.set('limit', String(options?.limit ?? 50))
    if (options?.status) {
      params.set('status', options.status)
    }
    if (options?.query) {
      params.set('query', options.query)
    }
    return request<{ orders: CloudPaymentOrder[] }>(`/admin/pay/orders?${params.toString()}`, { method: 'GET' }, token)
  },

  adminRegrantPaymentOrder: (token: string, orderNo: string) =>
    request<{ status: string; order: CloudPaymentOrder }>(
      `/admin/pay/orders/${encodeURIComponent(orderNo)}/regrant`,
      { method: 'POST' },
      token
    ),

  createPaymentOrder: (
    token: string,
    payload: {
      product_code: string
      provider: 'xunhu'
      billing_months: number
      purchase_mode: 'standard' | 'upgrade_diff_all' | 'upgrade_replace_month'
    }
  ) =>
    request<CloudCreatePaymentOrderResponse>(
      '/pay/orders',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      },
      token
    ),

  getPaymentOrder: (token: string, orderNo: string) =>
    request<{ order: CloudPaymentOrder }>(`/pay/orders/${orderNo}`, { method: 'GET' }, token),

  cancelPaymentOrder: (token: string, orderNo: string) =>
    request<{ order: CloudPaymentOrder }>(`/pay/orders/${encodeURIComponent(orderNo)}/cancel`, { method: 'POST' }, token),

  adminUploadSharedAuthFile: (token: string, file: File) =>
    uploadForm<{ file: CloudAuthFile }>('/admin/shared-auth-files/upload', file, token),

  adminUploadAppRelease: (token: string, file: File, payload: { version: string; notes?: string }) =>
    uploadFormWithFields<{ manifest: CloudAppReleaseManifest }>(
      '/admin/app-releases/upload',
      file,
      token,
      {
        version: payload.version,
        notes: payload.notes ?? ''
      }
    ),

  adminDeleteSharedAuthFile: (token: string, id: number) =>
    request<{ status: string }>(`/admin/shared-auth-files/${id}`, { method: 'DELETE' }, token),

  adminDeleteAllSharedAuthFiles: (token: string) =>
    request<{ status: string; deleted: number }>(
      '/admin/shared-auth-files',
      { method: 'DELETE' },
      token
    )
}
