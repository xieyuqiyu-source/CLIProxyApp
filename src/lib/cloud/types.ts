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
  shared_pool_mode: 'none' | 'sample' | 'full'
  shared_pool_max_files: number
  shared_pool_refresh_minutes: number
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
  status: 'ok'
  token: string
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
  expiresAt?: string | null
  device: CloudDevice
  trusted_token?: string
  trusted_until?: string | null
}

export interface CloudLoginChallengeResponse {
  status: 'verification_required'
  challenge_id: string
  masked_email: string
  expires_at: string
  debug_code?: string
}

export interface CloudLoginConflictResponse {
  status: 'conflict'
  error: string
  active_device?: {
    deviceId: string
    deviceName: string
    platform: string
    lastSeenAt?: string | null
  } | null
}

export interface CloudRegisterChallengeResponse {
  status: 'verification_required'
  challenge_id: string
  masked_email: string
  expires_at: string
  debug_code?: string
}

export interface CloudMeResponse {
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
  expiresAt?: string | null
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

export interface SharedSyncPackage {
  mode: 'none' | 'sample' | 'full'
  max_files: number
  refresh_after_minutes: number
  files: CloudAuthFile[]
}

export interface CloudRegisterResponse {
  status?: 'ok'
  user: CloudUser
}

export interface CloudAdminUserSummary {
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
  expiresAt?: string | null
}

export interface CloudAppReleaseManifest {
  version: string
  notes?: string
  publishedAt: string
  downloads: Record<string, string>
}

export interface CloudPaymentProduct {
  id: number
  productCode: string
  name: string
  displayName: string
  planCode: string
  priceAmount: number
  currency: string
  durationDays: number
  status: 'active' | 'disabled'
  sortOrder: number
  description: string
  createdAt: string
  updatedAt: string
}

export type CloudPaymentPurchaseMode = 'standard' | 'upgrade_diff_all' | 'upgrade_replace_month'

export interface CloudPaymentQuote {
  productCode: string
  productDisplayName: string
  planCode: string
  purchaseMode: CloudPaymentPurchaseMode
  billingMonths: number
  amount: number
  currency: string
  durationDays: number
  title: string
  description: string
  allowed: boolean
  reason?: string
}

export interface CloudPaymentOrder {
  id: number
  orderNo: string
  userId: number
  productId: number
  productCode: string
  productName: string
  productDisplayName: string
  productDescription: string
  purchaseMode: CloudPaymentPurchaseMode
  billingMonths: number
  durationDays: number
  planCode: string
  paymentProvider: 'xunhu'
  amount: number
  currency: string
  status: 'pending' | 'paid' | 'closed' | 'failed' | 'refunded'
  providerOrderId: string | null
  providerTradeNo: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CloudPaymentCheckout {
  provider: 'xunhu'
  paymentEnabled: boolean
  codeUrl?: string
  providerOrderId?: string
  providerTradeNo?: string
  message?: string
}

export interface CloudCreatePaymentOrderResponse {
  order: CloudPaymentOrder
  product: CloudPaymentProduct
  checkout: CloudPaymentCheckout
}

export interface CloudQuotePaymentOrderResponse {
  product: CloudPaymentProduct
  quote: CloudPaymentQuote
}
