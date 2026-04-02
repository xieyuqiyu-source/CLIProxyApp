import type {
  CloudAdminUserSummary,
  CloudAuthFile,
  CloudLoginResponse,
  CloudMeResponse,
  CloudRegisterResponse,
  SharedSyncPackage
} from './types'

const CLOUD_BASE_URL = 'http://103.205.254.30:28899/api/v1'
const DEVICE_ID_KEY = 'cpapp-cloud-device-id'

function normalizeAccountKey(account: string) {
  return account.trim().toLowerCase()
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
  const headers = new Headers(init?.headers ?? {})
  headers.set('Content-Type', 'application/json')
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${CLOUD_BASE_URL}${path}`, {
    ...init,
    headers
  })

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return payload as T
}

async function download(path: string, token: string): Promise<{ fileName: string; bytes: number[] }> {
  const response = await fetch(`${CLOUD_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
  if (!response.ok) {
    const text = await response.text()
    let message = `${response.status} ${response.statusText}`
    if (text) {
      try {
        const payload = JSON.parse(text)
        if (payload && typeof payload.error === 'string') {
          message = payload.error
        }
      } catch {
        // ignore non-json bodies
      }
    }
    throw new Error(message)
  }
  const contentDisposition = response.headers.get('Content-Disposition') || ''
  const match = contentDisposition.match(/filename=([^;]+)/i)
  const fileName = match?.[1]?.replace(/(^"|"$)/g, '') || 'auth.json'
  const buffer = await response.arrayBuffer()
  return {
    fileName,
    bytes: Array.from(new Uint8Array(buffer))
  }
}

async function uploadForm<T>(path: string, file: File, token: string): Promise<T> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await fetch(`${CLOUD_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return payload as T
}

export const cloudClient = {
  getDeviceId: (account: string) => resolveDeviceId(account),

  register: (email: string, password: string) =>
    request<CloudRegisterResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password
      })
    }),

  login: (email: string, password: string) =>
    request<CloudLoginResponse>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          device_id: resolveDeviceId(email),
          device_name: 'CLIProxyApp',
          platform: navigator.platform || 'desktop'
        })
      }
    ),

  me: (token: string) => request<CloudMeResponse>('/me', { method: 'GET' }, token),

  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<{ status: string }>('/me/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword
      })
    }, token),

  listMyAuthFiles: (token: string) =>
    request<{ files: CloudAuthFile[] }>('/me/auth-files', { method: 'GET' }, token),

  uploadMyAuthFile: (token: string, file: File) =>
    uploadForm<{ file: CloudAuthFile }>('/me/auth-files/upload', file, token),

  downloadMyAuthFile: (token: string, id: number) =>
    download(`/me/auth-files/${id}/download`, token),

  deleteMyAuthFile: (token: string, id: number) =>
    request<{ status: string }>(`/me/auth-files/${id}`, { method: 'DELETE' }, token),

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
    request<{ status: string }>(`/admin/users/${userId}/plan`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }, token),

  adminUploadSharedAuthFile: (token: string, file: File) =>
    uploadForm<{ file: CloudAuthFile }>('/admin/shared-auth-files/upload', file, token)
}
