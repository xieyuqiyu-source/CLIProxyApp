import { cpaRuntime } from '../cpa/runtime'
import type {
  CloudAdminUserSummary,
  CloudAuthFile,
  CloudLoginResponse,
  CloudMeResponse,
  CloudRegisterResponse,
  SharedSyncPackage
} from './types'

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
  return cpaRuntime.proxyCloudRequest({
    method: init?.method ?? 'GET',
    path,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    token
  }) as Promise<T>
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

  adminUploadSharedAuthFile: (token: string, file: File) =>
    uploadForm<{ file: CloudAuthFile }>('/admin/shared-auth-files/upload', file, token),

  adminDeleteSharedAuthFile: (token: string, id: number) =>
    request<{ status: string }>(`/admin/shared-auth-files/${id}`, { method: 'DELETE' }, token),

  adminDeleteAllSharedAuthFiles: (token: string) =>
    request<{ status: string; deleted: number }>(
      '/admin/shared-auth-files',
      { method: 'DELETE' },
      token
    )
}
