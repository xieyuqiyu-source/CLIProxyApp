export interface CloudUser {
  id: number
  email: string
  role: 'user' | 'admin'
  status: string
  createdAt: string
  updatedAt: string
}

export interface CloudPlan {
  id: number
  planCode: string
  name: string
  description: string
}

export interface CloudFeatures {
  max_enabled_auth_files: number
  allow_auto_rotation: boolean
  allow_personal_cloud_sync: boolean
  allow_shared_pool: boolean
  max_devices: number
}

export interface CloudDevice {
  id: number
  userId: number
  deviceId: string
  deviceName: string
  platform: string
  status: string
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

export interface CloudLoginResponse {
  token: string
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
  device: CloudDevice
}

export interface CloudMeResponse {
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
}

export interface CloudAuthFile {
  id: number
  ownerType: 'user' | 'shared'
  ownerUserId: number | null
  provider: string
  fileName: string
  storagePath: string
  fileHash: string
  encrypted: boolean
  status: string
  sourceType: 'personal' | 'shared'
  planRequired: string | null
  displayName: string
  createdAt: string
  updatedAt: string
}

export interface CloudRegisterResponse {
  user: CloudUser
}

export interface CloudAdminUserSummary {
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
}
