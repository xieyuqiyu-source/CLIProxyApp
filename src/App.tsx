import { useEffect, useMemo, useRef, useState } from 'react'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { cpaRuntime } from './lib/cpa/runtime'
import { OAuthPanel } from './features/oauth/OAuthPanel'
import { QuotaPanel } from './features/quota/QuotaPanel'
import { AuthFilesPanel } from './features/auth-files/AuthFilesPanel'
import { CloudAdminPanel } from './features/cloud-admin/CloudAdminPanel'
import { OpenAIProvidersPanel } from './features/openai-providers/OpenAIProvidersPanel'
import { UserWorkspace } from './features/user-workspace/UserWorkspace'
import { authFilesApi } from './features/auth-files/api'
import { quotaApi, getApiCallErrorMessage } from './features/quota/api'
import { cloudClient } from './lib/cloud/client'
import { sharedImportRegistry } from './lib/cloud/sharedRegistry'
import type {
  CloudAdminUserSummary,
  CloudAgentStatus,
  CloudAgentTask,
  CloudFeatures,
  CloudAuthFile,
  CloudLoginChallengeResponse,
  CloudLoginConflictResponse,
  CloudLoginResponse,
  CloudPaymentOrder,
  CloudPaymentProduct,
  CloudPlan,
  CloudUser
} from './lib/cloud/types'
import { formatPlanLabel } from './lib/cloud/planLabels'
import type {
  AppState,
  AppUpdateDownloadResult,
  AppUpdateInfo,
  BootstrapSettings,
  CpaManagementInfo,
  CpaState,
  ImportAuthFilesResult
} from './lib/cpa/types'
import type { AuthFileItem as QuotaAuthFileItem } from './features/quota/types'
import type { QuotaMetric } from './features/quota/types'

type AdminTab = 'overview' | 'oauth' | 'auth-files' | 'quota' | 'openai-providers' | 'cloud-admin' | 'cpm'
type UserTab = 'overview' | 'oauth' | 'auth-files' | 'providers' | 'quota' | 'stats'
type DeveloperSurfaceMode = 'admin' | 'spadmin' | 'user'
type SpAdminTab = 'overview' | 'cloud-admin'
type SpCloudAdminTab = 'overview' | 'users' | 'payments' | 'publish'
type SharedCredentialMode = 'plain' | 'quota_card'

interface InvalidSharedAuthCandidate {
  file: CloudAuthFile
  reason: string
  status?: number
}

interface SharedPoolAgentCheckResult {
  checkedAt: string
  totalShared: number
  checkedCodexCount: number
  usableCount: number
  invalidCount: number
  skippedCount: number
  cards: SharedPoolQuotaCard[]
  invalid: Array<{
    id: number
    fileName: string
    displayName: string
    provider: string
    reason: string
    status?: number
  }>
}

interface SharedPoolQuotaCard {
  id: number
  fileName: string
  displayName: string
  provider: string
  planLabel: string
  accountLabel: string
  status: 'usable' | 'invalid' | 'unknown'
  reason?: string
  statusCode?: number
  metrics: QuotaMetric[]
  updatedAt: string
}

interface SpAdminOverviewData {
  users: CloudAdminUserSummary[]
  sharedFiles: CloudAuthFile[]
  paymentProducts: CloudPaymentProduct[]
  paymentOrders: CloudPaymentOrder[]
}

interface LoginSession {
  token: string
  user: CloudUser
  plan: CloudPlan
  features: CloudFeatures
  expiresAt?: string | null
}

const SESSION_KEY = 'cpapp-login-session'
const THEME_KEY = 'cpapp-theme'
const REMEMBERED_EMAIL_KEY = 'cpapp-remembered-email'
const SPADMIN_AGENT_ENABLED_KEY = 'cpapp-spadmin-agent-enabled'
const SPADMIN_AGENT_DEVICE_ID_KEY = 'cpapp-spadmin-agent-device-id'
const THEMES = ['light', 'dark', 'synthwave', 'cyberpunk'] as const
type Theme = typeof THEMES[number]

interface PendingLoginChallenge {
  email: string
  challengeId: string
  maskedEmail: string
  expiresAt: string
  debugCode?: string
}

interface PendingRegisterChallenge {
  email: string
  challengeId: string
  maskedEmail: string
  expiresAt: string
  debugCode?: string
}

const createEmptySettings = (): BootstrapSettings => ({
  apiPort: 8317,
  autoStart: true,
  binaryMode: 'development',
  explicitBinaryPath: null
})

const statusLabelMap: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '异常'
}

const MOBILE_WINDOW_SIZE = { width: 430, height: 920, minWidth: 390, minHeight: 760 }
const ADMIN_WINDOW_SIZE = { width: 1440, height: 920, minWidth: 1180, minHeight: 760 }

function normalizeTextValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

function normalizeMatchName(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.json$/i, '') ?? ''
}

function buildSpAdminCheckFileName(file: CloudAuthFile, fallbackName: string) {
  const baseName = fallbackName.trim() || file.fileName || `shared-${file.id}.json`
  const jsonName = /\.json$/i.test(baseName) ? baseName : `${baseName}.json`
  return `__spadmin_check_${file.id}_${jsonName}`
}

function isCloudAuthFileDownloadable(file: CloudAuthFile) {
  return file.distributionMode !== 'quota_card'
}

function formatSharedDistributionMode(file: CloudAuthFile) {
  return file.distributionMode === 'quota_card' ? '加密额度卡' : '普通凭证'
}

function resolveSpAdminAgentDeviceId() {
  const existing = window.localStorage.getItem(SPADMIN_AGENT_DEVICE_ID_KEY)
  if (existing) {
    return existing
  }
  const next = crypto.randomUUID()
  window.localStorage.setItem(SPADMIN_AGENT_DEVICE_ID_KEY, next)
  return next
}

function isAdminRole(role: unknown) {
  return String(role ?? '').trim().toLowerCase() === 'admin'
}

function getQuotaAuthIndex(file: QuotaAuthFileItem) {
  return normalizeTextValue(file.authIndex ?? file.auth_index) ?? ''
}

function isCodexLikeAuthFile(file: QuotaAuthFileItem | CloudAuthFile) {
  const raw = `${'provider' in file ? file.provider : ''} ${'type' in file ? file.type ?? '' : ''} ${'fileName' in file ? file.fileName : ''} ${'name' in file ? file.name : ''}`
    .toLowerCase()
  return raw.includes('codex') || raw.includes('chatgpt') || raw.includes('openai')
}

function normalizeNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizePlanType(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    return trimmed ? trimmed.replace(/[_\s]+/g, '-') : null
  }
  return null
}

function formatPercent(value: number | null) {
  if (value === null) {
    return '--'
  }
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`
}

function formatUnixSeconds(value: number | null) {
  if (!value || value <= 0) {
    return '-'
  }
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function formatCodexReset(window?: Record<string, unknown> | null) {
  if (!window) {
    return '-'
  }
  const resetAt = normalizeNumberValue(window.reset_at ?? window.resetAt)
  if (resetAt && resetAt > 0) {
    return formatUnixSeconds(resetAt)
  }
  const resetAfter = normalizeNumberValue(window.reset_after_seconds ?? window.resetAfterSeconds)
  if (resetAfter && resetAfter > 0) {
    return formatUnixSeconds(Math.floor(Date.now() / 1000 + resetAfter))
  }
  return '-'
}

function parseResponseJson<T = Record<string, unknown>>(result: { body: T | null; bodyText: string }) {
  if (result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
    return result.body as Record<string, unknown>
  }
  const source = typeof result.body === 'string' ? result.body : result.bodyText
  if (!source.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(source)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function resolveCodexPlanType(file: QuotaAuthFileItem) {
  const metadata =
    file.metadata && typeof file.metadata === 'object' && !Array.isArray(file.metadata)
      ? (file.metadata as Record<string, unknown>)
      : null
  const attributes =
    file.attributes && typeof file.attributes === 'object' && !Array.isArray(file.attributes)
      ? (file.attributes as Record<string, unknown>)
      : null
  const candidates = [
    file.plan_type,
    file.planType,
    metadata?.plan_type,
    metadata?.planType,
    attributes?.plan_type,
    attributes?.planType
  ]
  for (const candidate of candidates) {
    const normalized = normalizePlanType(candidate)
    if (normalized) {
      return normalized
    }
  }
  return null
}

function resolveCodexUsagePlanType(payload: Record<string, unknown>) {
  return normalizePlanType(payload.plan_type ?? payload.planType)
}

function getCodexWindowSeconds(windowValue?: Record<string, unknown> | null) {
  if (!windowValue) {
    return null
  }
  return normalizeNumberValue(windowValue.limit_window_seconds ?? windowValue.limitWindowSeconds)
}

function pickCodexClassifiedWindows(limitInfo?: Record<string, unknown> | null) {
  const primaryWindow =
    limitInfo?.primary_window && typeof limitInfo.primary_window === 'object'
      ? (limitInfo.primary_window as Record<string, unknown>)
      : limitInfo?.primaryWindow && typeof limitInfo.primaryWindow === 'object'
        ? (limitInfo.primaryWindow as Record<string, unknown>)
        : null
  const secondaryWindow =
    limitInfo?.secondary_window && typeof limitInfo.secondary_window === 'object'
      ? (limitInfo.secondary_window as Record<string, unknown>)
      : limitInfo?.secondaryWindow && typeof limitInfo.secondaryWindow === 'object'
        ? (limitInfo.secondaryWindow as Record<string, unknown>)
        : null

  let fiveHourWindow: Record<string, unknown> | null = null
  let weeklyWindow: Record<string, unknown> | null = null
  for (const windowValue of [primaryWindow, secondaryWindow]) {
    const seconds = getCodexWindowSeconds(windowValue)
    if (seconds === 18000 && !fiveHourWindow) {
      fiveHourWindow = windowValue
    } else if (seconds === 604800 && !weeklyWindow) {
      weeklyWindow = windowValue
    }
  }

  if (!fiveHourWindow) {
    fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null
  }
  if (!weeklyWindow) {
    weeklyWindow = secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null
  }

  return { fiveHourWindow, weeklyWindow }
}

function readCodexRateLimitInfo(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readCodexWindow(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function buildCodexQuotaMetrics(payload: Record<string, unknown>) {
  const metrics: QuotaMetric[] = []
  const rateLimit = readCodexRateLimitInfo(payload.rate_limit ?? payload.rateLimit)
  const codeReviewLimit = readCodexRateLimitInfo(payload.code_review_rate_limit ?? payload.codeReviewRateLimit)
  const additionalRateLimits = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : Array.isArray(payload.additionalRateLimits)
      ? payload.additionalRateLimits
      : []

  const addWindowMetric = (
    id: string,
    label: string,
    windowValue: unknown,
    limitReached?: unknown,
    allowed?: unknown
  ) => {
    const windowRecord = readCodexWindow(windowValue)
    if (!windowRecord) {
      return
    }

    const resetLabel = formatCodexReset(windowRecord)
    const usedPercentRaw = normalizeNumberValue(windowRecord.used_percent ?? windowRecord.usedPercent)
    const isLimitReached = Boolean(limitReached) || allowed === false
    const usedPercent = usedPercentRaw ?? (isLimitReached && resetLabel !== '-' ? 100 : null)
    const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent)

    metrics.push({
      id,
      label,
      value: formatPercent(remainingPercent),
      hint: `重置 ${resetLabel}`
    })
  }

  const rateWindows = pickCodexClassifiedWindows(rateLimit)
  const rateLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached
  const rateAllowed = rateLimit?.allowed
  addWindowMetric('five-hour', '5 小时', rateWindows.fiveHourWindow, rateLimitReached, rateAllowed)
  addWindowMetric('weekly', '1 周', rateWindows.weeklyWindow, rateLimitReached, rateAllowed)

  const codeReviewWindows = pickCodexClassifiedWindows(codeReviewLimit)
  const codeReviewLimitReached = codeReviewLimit?.limit_reached ?? codeReviewLimit?.limitReached
  const codeReviewAllowed = codeReviewLimit?.allowed
  addWindowMetric(
    'code-review-five-hour',
    'Code Review 5 小时',
    codeReviewWindows.fiveHourWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  )
  addWindowMetric(
    'code-review-weekly',
    'Code Review 1 周',
    codeReviewWindows.weeklyWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  )

  additionalRateLimits.forEach((item, index) => {
    const record = readCodexRateLimitInfo(item)
    const rateInfo = readCodexRateLimitInfo(record?.rate_limit ?? record?.rateLimit)
    if (!record || !rateInfo) {
      return
    }

    const limitName =
      normalizeTextValue(record.limit_name ?? record.limitName) ??
      normalizeTextValue(record.metered_feature ?? record.meteredFeature) ??
      `additional-${index + 1}`
    const idPrefix = limitName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `additional-${index + 1}`
    const additionalLimitReached = rateInfo.limit_reached ?? rateInfo.limitReached
    const additionalAllowed = rateInfo.allowed

    addWindowMetric(
      `${idPrefix}-five-hour-${index}`,
      `${limitName} 5 小时`,
      rateInfo.primary_window ?? rateInfo.primaryWindow,
      additionalLimitReached,
      additionalAllowed
    )
    addWindowMetric(
      `${idPrefix}-weekly-${index}`,
      `${limitName} 1 周`,
      rateInfo.secondary_window ?? rateInfo.secondaryWindow,
      additionalLimitReached,
      additionalAllowed
    )
  })

  return metrics
}

function formatCompactDate(value?: string | null) {
  if (!value) {
    return '--'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function formatCurrencyCny(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`
}

function getOrderStatusLabel(status: CloudPaymentOrder['status']) {
  switch (status) {
    case 'paid':
      return '已支付'
    case 'pending':
      return '待支付'
    case 'closed':
      return '已关闭'
    case 'failed':
      return '失败'
    case 'refunded':
      return '已退款'
    default:
      return status
  }
}

function getOrderStatusBadgeClass(status: CloudPaymentOrder['status']) {
  switch (status) {
    case 'paid':
      return 'badge-success'
    case 'pending':
      return 'badge-warning'
    case 'failed':
    case 'refunded':
      return 'badge-error'
    default:
      return 'badge-ghost'
  }
}

function getPlanBadgeClass(planCode: string) {
  switch (planCode) {
    case 'admin':
      return 'badge-info'
    case 'vip2':
      return 'badge-secondary'
    case 'vip1':
      return 'badge-success'
    case 'free':
      return 'badge-ghost'
    default:
      return 'badge-outline'
  }
}

function getRoleBadgeClass(role: string) {
  return role === 'admin' ? 'badge-info' : 'badge-neutral'
}

function parseIdTokenPayload(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // continue
  }
  const parts = trimmed.split('.')
  if (parts.length < 2) {
    return null
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const parsed = JSON.parse(window.atob(padded))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function resolveCodexChatgptAccountId(file: QuotaAuthFileItem) {
  const metadata =
    file.metadata && typeof file.metadata === 'object' && !Array.isArray(file.metadata)
      ? (file.metadata as Record<string, unknown>)
      : null
  const attributes =
    file.attributes && typeof file.attributes === 'object' && !Array.isArray(file.attributes)
      ? (file.attributes as Record<string, unknown>)
      : null
  const candidates = [file.id_token, metadata?.id_token, attributes?.id_token]
  for (const candidate of candidates) {
    const payload = parseIdTokenPayload(candidate)
    const accountId = normalizeTextValue(payload?.chatgpt_account_id ?? payload?.chatgptAccountId)
    if (accountId) {
      return accountId
    }
  }
  return null
}

function classifyInvalidAuthError(status: number, message: string) {
  const normalized = message.toLowerCase()
  if (status === 401 || status === 402) {
    return true
  }
  return [
    'invalid_token',
    'invalid token',
    'unauthorized',
    'authentication failed',
    'account_deactivated',
    'account disabled',
    'account_disabled',
    'subscription_required',
    'subscription required',
    'payment required'
  ].some((needle) => normalized.includes(needle))
}

async function fetchCodexQuotaCard(
  file: QuotaAuthFileItem,
  cloudFile: CloudAuthFile
): Promise<SharedPoolQuotaCard> {
  const authIndex = getQuotaAuthIndex(file)
  const accountLabel = cloudFile.displayName || cloudFile.fileName || file.name
  const planLabel = resolveCodexPlanType(file) ?? 'plus'

  if (!authIndex) {
    return {
      id: cloudFile.id,
      fileName: cloudFile.fileName,
      displayName: accountLabel,
      provider: cloudFile.provider || 'codex',
      planLabel,
      accountLabel,
      status: 'unknown',
      reason: '缺少 authIndex',
      metrics: [],
      updatedAt: new Date().toISOString()
    }
  }

  const headers: Record<string, string> = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
  }
  const accountId = resolveCodexChatgptAccountId(file)
  if (accountId) {
    headers['Chatgpt-Account-Id'] = accountId
  }

  const result = await quotaApi.apiCall({
    authIndex,
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header: headers
  })

  if (result.statusCode >= 200 && result.statusCode < 300) {
    const payload = parseResponseJson(result)
    const metrics = payload ? buildCodexQuotaMetrics(payload) : []
    const nextPlanLabel = payload ? resolveCodexUsagePlanType(payload) ?? planLabel : planLabel
    return {
      id: cloudFile.id,
      fileName: cloudFile.fileName,
      displayName: accountLabel,
      provider: cloudFile.provider || 'codex',
      planLabel: nextPlanLabel,
      accountLabel,
      status: 'usable',
      metrics,
      updatedAt: new Date().toISOString()
    }
  }

  const reason = getApiCallErrorMessage(result)
  const invalid = classifyInvalidAuthError(result.statusCode, reason)
  return {
    id: cloudFile.id,
    fileName: cloudFile.fileName,
    displayName: accountLabel,
    provider: cloudFile.provider || 'codex',
    planLabel,
    accountLabel,
    status: invalid ? 'invalid' : 'unknown',
    reason,
    statusCode: result.statusCode,
    metrics: [],
    updatedAt: new Date().toISOString()
  }
}

interface SpAdminPanelProps {
  token: string
  recentLogs: string
  pendingAction: string | null
  onRefreshLogs: () => void
  onNotify: (message: string) => void
  onError: (message: string | null) => void
}

function SpAdminPanel({ token, recentLogs, pendingAction, onRefreshLogs, onNotify, onError }: SpAdminPanelProps) {
  const releaseInputRef = useRef<HTMLInputElement | null>(null)
  const [activeTab, setActiveTab] = useState<SpAdminTab>('overview')
  const [cloudTab, setCloudTab] = useState<SpCloudAdminTab>('overview')
  const [sharedCloudFiles, setSharedCloudFiles] = useState<CloudAuthFile[]>([])
  const [overviewData, setOverviewData] = useState<SpAdminOverviewData | null>(null)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [spUsers, setSpUsers] = useState<CloudAdminUserSummary[]>([])
  const [spPlans, setSpPlans] = useState<CloudPlan[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [savingSpUserId, setSavingSpUserId] = useState<number | null>(null)
  const [spUserSearch, setSpUserSearch] = useState('')
  const [spUserPage, setSpUserPage] = useState(1)
  const [spDraftRoles, setSpDraftRoles] = useState<Record<number, 'user' | 'admin'>>({})
  const [spDraftPlans, setSpDraftPlans] = useState<Record<number, string>>({})
  const [spDraftExpiresAt, setSpDraftExpiresAt] = useState<Record<number, string>>({})
  const [spPaymentProducts, setSpPaymentProducts] = useState<CloudPaymentProduct[]>([])
  const [spPaymentOrders, setSpPaymentOrders] = useState<CloudPaymentOrder[]>([])
  const [loadingPayments, setLoadingPayments] = useState(false)
  const [spPaymentStatusFilter, setSpPaymentStatusFilter] = useState<'all' | CloudPaymentOrder['status']>('all')
  const [spPaymentQuery, setSpPaymentQuery] = useState('')
  const [regrantingSpOrderNo, setRegrantingSpOrderNo] = useState<string | null>(null)
  const [loadingPublish, setLoadingPublish] = useState(false)
  const [uploadingShared, setUploadingShared] = useState(false)
  const [clearingSharedPool, setClearingSharedPool] = useState(false)
  const [checkingInvalidShared, setCheckingInvalidShared] = useState(false)
  const [deletingInvalidShared, setDeletingInvalidShared] = useState(false)
  const [deletingSharedFileId, setDeletingSharedFileId] = useState<number | null>(null)
  const [invalidSharedCandidates, setInvalidSharedCandidates] = useState<InvalidSharedAuthCandidate[]>([])
  const [sharedCredentialMode, setSharedCredentialMode] = useState<SharedCredentialMode>('plain')
  const [sharedQuotaLimit, setSharedQuotaLimit] = useState(200)
  const [uploadingRelease, setUploadingRelease] = useState(false)
  const [releaseVersion, setReleaseVersion] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [agentEnabled, setAgentEnabled] = useState(() => window.localStorage.getItem(SPADMIN_AGENT_ENABLED_KEY) === 'true')
  const [agentStatus, setAgentStatus] = useState<CloudAgentStatus | null>(null)
  const [agentTasks, setAgentTasks] = useState<CloudAgentTask[]>([])
  const [agentLoading, setAgentLoading] = useState(false)
  const [creatingAgentTask, setCreatingAgentTask] = useState(false)
  const [agentRunningTaskId, setAgentRunningTaskId] = useState<number | null>(null)
  const agentRunningTaskIdRef = useRef<number | null>(null)
  const logLines = recentLogs && recentLogs !== '当前还没有日志。' && recentLogs !== '等待运行日志...'
    ? recentLogs.split('\n')
    : null

  const loadOverviewData = async (notify = false) => {
    try {
      setLoadingOverview(true)
      const [usersResponse, sharedResponse, productsResponse, ordersResponse] = await Promise.all([
        cloudClient.adminListUsers(token),
        cloudClient.listSharedAuthFiles(token),
        cloudClient.adminListPaymentProducts(token),
        cloudClient.adminListPaymentOrders(token, { limit: 50 })
      ])
      setOverviewData({
        users: Array.isArray(usersResponse.users) ? usersResponse.users : [],
        sharedFiles: Array.isArray(sharedResponse.files) ? sharedResponse.files : [],
        paymentProducts: Array.isArray(productsResponse.products) ? productsResponse.products : [],
        paymentOrders: Array.isArray(ordersResponse.orders) ? ordersResponse.orders : []
      })
      if (notify) {
        onNotify('总览数据已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingOverview(false)
    }
  }

  const loadUsersData = async (notify = false) => {
    try {
      setLoadingUsers(true)
      const [usersResponse, plansResponse] = await Promise.all([
        cloudClient.adminListUsers(token),
        cloudClient.adminListPlans(token)
      ])
      const nextUsers = Array.isArray(usersResponse.users) ? usersResponse.users : []
      setSpUsers(nextUsers)
      setSpPlans(Array.isArray(plansResponse.plans) ? plansResponse.plans : [])
      setSpUserPage(1)
      setSpDraftRoles((current) => {
        const next = { ...current }
        nextUsers.forEach((item) => {
          if (!next[item.user.id]) {
            next[item.user.id] = item.user.role === 'admin' ? 'admin' : 'user'
          }
        })
        return next
      })
      setSpDraftPlans((current) => {
        const next = { ...current }
        nextUsers.forEach((item) => {
          if (!next[item.user.id]) {
            next[item.user.id] = item.plan.planCode
          }
        })
        return next
      })
      setSpDraftExpiresAt((current) => {
        const next = { ...current }
        nextUsers.forEach((item) => {
          if (!(item.user.id in next)) {
            next[item.user.id] = item.expiresAt ? item.expiresAt.slice(0, 16) : ''
          }
        })
        return next
      })
      if (notify) {
        onNotify('用户数据已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingUsers(false)
    }
  }

  const loadPaymentsData = async (notify = false, options?: { status?: 'all' | CloudPaymentOrder['status']; query?: string }) => {
    const status = options?.status ?? spPaymentStatusFilter
    const query = options?.query ?? spPaymentQuery
    try {
      setLoadingPayments(true)
      const [productsResponse, ordersResponse] = await Promise.all([
        cloudClient.adminListPaymentProducts(token),
        cloudClient.adminListPaymentOrders(token, {
          limit: 50,
          status,
          query: query.trim()
        })
      ])
      setSpPaymentProducts(Array.isArray(productsResponse.products) ? productsResponse.products : [])
      setSpPaymentOrders(Array.isArray(ordersResponse.orders) ? ordersResponse.orders : [])
      if (notify) {
        onNotify('支付数据已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingPayments(false)
    }
  }

  const loadPublishData = async (notify = false) => {
    try {
      setLoadingPublish(true)
      const response = await cloudClient.listSharedAuthFiles(token)
      setSharedCloudFiles(Array.isArray(response.files) ? response.files : [])
      setInvalidSharedCandidates([])
      if (notify) {
        onNotify('发布数据已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingPublish(false)
    }
  }

  const loadAgentTasks = async (notify = false) => {
    try {
      setAgentLoading(true)
      const response = await cloudClient.adminListAgentTasks(token, { limit: 10 })
      setAgentStatus(response.agent)
      setAgentTasks(Array.isArray(response.tasks) ? response.tasks : [])
      if (notify) {
        onNotify('Agent 状态已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setAgentLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'cloud-admin' && cloudTab === 'publish') {
      void loadPublishData()
    }
  }, [activeTab, cloudTab, token])

  useEffect(() => {
    if (activeTab === 'cloud-admin' && cloudTab === 'overview') {
      void loadOverviewData()
      void loadAgentTasks()
    }
  }, [activeTab, cloudTab, token])

  useEffect(() => {
    if (activeTab === 'cloud-admin' && cloudTab === 'users') {
      void loadUsersData()
    }
  }, [activeTab, cloudTab, token])

  useEffect(() => {
    if (activeTab === 'cloud-admin' && cloudTab === 'payments') {
      void loadPaymentsData()
    }
  }, [activeTab, cloudTab, token])

  const overviewUsers = overviewData?.users ?? []
  const overviewSharedFiles = overviewData?.sharedFiles ?? []
  const overviewProducts = overviewData?.paymentProducts ?? []
  const overviewOrders = overviewData?.paymentOrders ?? []
  const adminUserCount = overviewUsers.filter((item) => item.user.role === 'admin').length
  const paidUserCount = overviewUsers.filter((item) => ['vip1', 'vip2'].includes(item.plan.planCode)).length
  const proMaxUserCount = overviewUsers.filter((item) => item.plan.planCode === 'vip2').length
  const activeProductCount = overviewProducts.filter((item) => item.status === 'active').length
  const paidOrders = overviewOrders.filter((item) => item.status === 'paid')
  const pendingOrderCount = overviewOrders.filter((item) => item.status === 'pending').length
  const paidRevenueCents = paidOrders.reduce((sum, order) => sum + order.amount, 0)
  const codexSharedCount = overviewSharedFiles.filter(isCodexLikeAuthFile).length
  const recentOverviewOrders = overviewOrders.slice(0, 4)
  const recentOverviewUsers = overviewUsers.slice(0, 4)
  const latestPaidOrder = [...overviewOrders]
    .filter((order) => order.status === 'paid')
    .sort((a, b) => new Date(b.paidAt ?? b.createdAt).getTime() - new Date(a.paidAt ?? a.createdAt).getTime())[0]
  const normalizedUserSearch = spUserSearch.trim().toLowerCase()
  const filteredSpUsers = spUsers.filter((item) => {
    if (!normalizedUserSearch) {
      return true
    }
    return `${item.user.email} ${item.user.id} ${item.user.role} ${item.plan.planCode} ${item.plan.name}`
      .toLowerCase()
      .includes(normalizedUserSearch)
  })
  const spUserPageSize = 10
  const spUserTotalPages = Math.max(1, Math.ceil(filteredSpUsers.length / spUserPageSize))
  const currentSpUserPage = Math.min(spUserPage, spUserTotalPages)
  const visibleSpUsers = filteredSpUsers.slice((currentSpUserPage - 1) * spUserPageSize, currentSpUserPage * spUserPageSize)
  const spPaidUsers = spUsers.filter((item) => ['vip1', 'vip2'].includes(item.plan.planCode)).length
  const spActiveProducts = spPaymentProducts.filter((item) => item.status === 'active').length
  const spPaidOrders = spPaymentOrders.filter((item) => item.status === 'paid')
  const spPendingOrders = spPaymentOrders.filter((item) => item.status === 'pending').length
  const spPaymentRevenueCents = spPaidOrders.reduce((sum, order) => sum + order.amount, 0)
  const agentLastPollAt = agentStatus?.heartbeat?.lastPollAt ?? null
  const agentIsOnline = agentEnabled && Boolean(agentStatus?.online)
  const latestAgentTask = agentTasks[0] ?? null
  const agentOfflineAfterSeconds = agentStatus?.offlineAfterSeconds ?? 60
  const formatAgentTaskSummary = (task: CloudAgentTask) => {
    if (task.status === 'completed' && task.result) {
      const result = task.result as Partial<SharedPoolAgentCheckResult>
      return `检测 ${result.checkedCodexCount ?? 0} 个 · 不可用 ${result.invalidCount ?? 0} 个`
    }
    if (task.status === 'failed') {
      return task.errorMessage || '任务失败'
    }
    if (task.status === 'expired') {
      return '任务已过期'
    }
    return task.status === 'running' ? '正在本机检测' : '等待本机轮询'
  }

  const saveSpUser = async (item: CloudAdminUserSummary) => {
    const role = spDraftRoles[item.user.id] ?? item.user.role
    const planCode = spDraftPlans[item.user.id] ?? item.plan.planCode
    const expiresAt = spDraftExpiresAt[item.user.id]?.trim() || null
    try {
      setSavingSpUserId(item.user.id)
      if (role !== item.user.role) {
        await cloudClient.adminUpdateUserRole(token, item.user.id, { role })
      }
      await cloudClient.adminAssignPlan(token, item.user.id, {
        plan_code: planCode,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null
      })
      await loadUsersData()
      onNotify(`已更新 ${item.user.email}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSpUserId(null)
    }
  }

  const regrantSpOrder = async (order: CloudPaymentOrder) => {
    try {
      setRegrantingSpOrderNo(order.orderNo)
      await cloudClient.adminRegrantPaymentOrder(token, order.orderNo)
      await loadPaymentsData()
      onNotify(`已重新发放订单 ${order.orderNo}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRegrantingSpOrderNo(null)
    }
  }

  const uploadSharedFiles = async (selectedFiles: Array<{ name: string; bytes: number[] }>) => {
    if (!selectedFiles || selectedFiles.length === 0) {
      return
    }
    try {
      setUploadingShared(true)
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
      await loadPublishData()
      onNotify(`已上传 ${selectedFiles.length} 个共享认证`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploadingShared(false)
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
      await loadPublishData()
      onNotify(`已清空共享号池，共删除 ${result.deleted} 个文件`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setClearingSharedPool(false)
    }
  }

  const runSharedPoolCheck = async (files: CloudAuthFile[]): Promise<{
    result: SharedPoolAgentCheckResult
    candidates: InvalidSharedAuthCandidate[]
  }> => {
    if (files.length === 0) {
      throw new Error('当前共享号池为空')
    }
    let beforeLocalNames = new Set<string>()
    const downloadedFiles: Array<{ cloudFile: CloudAuthFile; localName: string; bytes: number[] }> = []
    let checkedCodexCount = 0
    let skippedCount = 0
    let usableCount = 0
    const cards: SharedPoolQuotaCard[] = []
    const nextInvalid: InvalidSharedAuthCandidate[] = []

    try {
      beforeLocalNames = new Set(
        ((await quotaApi.listAuthFiles()).files ?? []).map((file) => normalizeMatchName(file.name))
      )

      for (const file of files.filter(isCloudAuthFileDownloadable)) {
        const payload = await cloudClient.downloadSharedAuthFile(token, file.id)
        downloadedFiles.push({
          cloudFile: file,
          localName: buildSpAdminCheckFileName(file, payload.fileName || file.fileName),
          bytes: payload.bytes
        })
      }

      if (downloadedFiles.length === 0) {
        return {
          result: {
            checkedAt: new Date().toISOString(),
            totalShared: files.length,
            checkedCodexCount: 0,
            usableCount: 0,
            invalidCount: 0,
            skippedCount: files.length,
            cards: [],
            invalid: []
          },
          candidates: []
        }
      }

      await cpaRuntime.importAuthFiles(
        downloadedFiles.map((item) => ({
          name: item.localName,
          bytes: item.bytes
        }))
      )

      const localFiles = ((await quotaApi.listAuthFiles()).files ?? []) as QuotaAuthFileItem[]
      for (const item of downloadedFiles) {
        const candidates = [
          normalizeMatchName(item.localName),
          normalizeMatchName(item.cloudFile.fileName),
          normalizeMatchName(item.cloudFile.displayName)
        ].filter(Boolean)
        const localFile = localFiles.find((file) => candidates.includes(normalizeMatchName(file.name)))
        if (!localFile || !isCodexLikeAuthFile(localFile)) {
          skippedCount += 1
          continue
        }
        checkedCodexCount += 1
        const card = await fetchCodexQuotaCard(localFile, item.cloudFile)
        cards.push(card)
        if (card.status === 'usable') {
          usableCount += 1
        }
        if (card.status === 'invalid') {
          nextInvalid.push({
            file: item.cloudFile,
            reason: card.reason ?? '认证不可用',
            status: card.statusCode
          })
        }
      }

      return {
        candidates: nextInvalid,
        result: {
          checkedAt: new Date().toISOString(),
          totalShared: files.length,
          checkedCodexCount,
          usableCount,
          invalidCount: nextInvalid.length,
          skippedCount,
          cards,
          invalid: nextInvalid.map((candidate) => ({
            id: candidate.file.id,
            fileName: candidate.file.fileName,
            displayName: candidate.file.displayName || candidate.file.fileName,
            provider: candidate.file.provider || 'unknown',
            reason: candidate.reason,
            status: candidate.status
          }))
        }
      }
    } finally {
      try {
        const afterLocalFiles = ((await quotaApi.listAuthFiles()).files ?? []) as QuotaAuthFileItem[]
        const cleanupFiles = afterLocalFiles.filter((file) => {
          const normalized = normalizeMatchName(file.name)
          return normalized && !beforeLocalNames.has(normalized) && downloadedFiles.some((item) => normalizeMatchName(item.localName) === normalized)
        })
        await Promise.allSettled(cleanupFiles.map((file) => authFilesApi.deleteFile(file.name)))
      } catch {
        // 检测失败时不阻塞界面恢复；下次检测仍会使用独立临时文件名。
      }
    }
  }

  const checkInvalidSharedFiles = async () => {
    if (sharedCloudFiles.length === 0) {
      onError('当前共享号池为空')
      return
    }
    try {
      setCheckingInvalidShared(true)
      setInvalidSharedCandidates([])
      const { result, candidates } = await runSharedPoolCheck(sharedCloudFiles)

      setInvalidSharedCandidates(candidates)
      if (result.checkedCodexCount === 0) {
        onNotify('当前没有可检测的 Codex 共享认证')
        return
      }
      if (candidates.length === 0) {
        onNotify(`已检测 ${result.checkedCodexCount} 个 Codex 共享认证，未发现明确不可用账号`)
      } else {
        onNotify(`发现 ${candidates.length} 个明确不可用共享认证`)
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckingInvalidShared(false)
    }
  }

  const setCurrentAgentTaskId = (taskId: number | null) => {
    agentRunningTaskIdRef.current = taskId
    setAgentRunningTaskId(taskId)
  }

  const executeAgentTask = async (task: CloudAgentTask) => {
    if (agentRunningTaskIdRef.current !== null) {
      return
    }
    setCurrentAgentTaskId(task.id)
    try {
      if (task.type !== 'check_shared_pool') {
        await cloudClient.agentSubmitTaskResult(token, task.id, {
          status: 'failed',
          result: {},
          error: `不支持的任务类型：${task.type}`
        })
        return
      }

      const sharedResponse = await cloudClient.listSharedAuthFiles(token)
      const files = Array.isArray(sharedResponse.files) ? sharedResponse.files : []
      setSharedCloudFiles(files)
      const { result, candidates } = await runSharedPoolCheck(files)
      setInvalidSharedCandidates(candidates)
      await cloudClient.agentSubmitTaskResult(token, task.id, {
        status: 'completed',
        result: result as unknown as Record<string, unknown>
      })
      onNotify(`远程检测完成：检测 ${result.checkedCodexCount} 个，发现 ${result.invalidCount} 个不可用`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await cloudClient.agentSubmitTaskResult(token, task.id, {
        status: 'failed',
        result: {},
        error: message
      }).catch(() => undefined)
      onError(message)
    } finally {
      setCurrentAgentTaskId(null)
      void loadAgentTasks()
    }
  }

  const pollAgentOnce = async () => {
    if (!agentEnabled || agentRunningTaskIdRef.current !== null) {
      return
    }
    try {
      const response = await cloudClient.agentPollTask(token, resolveSpAdminAgentDeviceId(), 'CPSwitch SpAdmin')
      setAgentStatus(response.agent)
      if (response.task) {
        await executeAgentTask(response.task)
      }
    } catch (error) {
      setAgentStatus((current) => current ? { ...current, online: false } : current)
    }
  }

  const createAgentCheckTask = async () => {
    try {
      setCreatingAgentTask(true)
      const response = await cloudClient.adminCreateAgentTask(token, {
        source: 'spadmin',
        requestedAt: new Date().toISOString()
      })
      setAgentStatus(response.agent)
      await loadAgentTasks()
      onNotify(`已发起远程检测任务 #${response.task.id}`)
      void pollAgentOnce()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreatingAgentTask(false)
    }
  }

  useEffect(() => {
    window.localStorage.setItem(SPADMIN_AGENT_ENABLED_KEY, agentEnabled ? 'true' : 'false')
    if (!agentEnabled) {
      return
    }
    void pollAgentOnce()
    const timer = window.setInterval(() => {
      void pollAgentOnce()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [agentEnabled, token])

  const deleteInvalidSharedFiles = async () => {
    if (invalidSharedCandidates.length === 0) {
      onError('当前没有可删除的不可用认证')
      return
    }
    try {
      setDeletingInvalidShared(true)
      for (const candidate of invalidSharedCandidates) {
        await cloudClient.adminDeleteSharedAuthFile(token, candidate.file.id)
      }
      onNotify(`已删除 ${invalidSharedCandidates.length} 个不可用共享认证`)
      setInvalidSharedCandidates([])
      await loadPublishData()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingInvalidShared(false)
    }
  }

  const deleteSharedFile = async (file: CloudAuthFile) => {
    try {
      setDeletingSharedFileId(file.id)
      await cloudClient.adminDeleteSharedAuthFile(token, file.id)
      await loadPublishData()
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
      onNotify(`已上传更新包：${response.manifest.version}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploadingRelease(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-3 px-3 py-3">
      <input
        ref={releaseInputRef}
        type="file"
        className="hidden"
        accept=".dmg,.exe,.zip"
        onChange={(event) => void handleReleaseUploadSelection(event)}
      />
      <div role="tablist" className="tabs tabs-boxed bg-base-100 p-1 shadow-sm">
        <button
          role="tab"
          className={`tab flex-1 text-sm font-semibold ${activeTab === 'overview' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          概览
        </button>
        <button
          role="tab"
          className={`tab flex-1 text-sm font-semibold ${activeTab === 'cloud-admin' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('cloud-admin')}
        >
          后台管理
        </button>
      </div>

      {activeTab === 'overview' ? (
        <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-3">
            <div>
              <h2 className="text-base font-bold">日志</h2>
              <p className="mt-1 text-xs text-base-content/55">CPA 运行输出</p>
            </div>
            <button
              className="btn btn-outline btn-xs"
              disabled={pendingAction !== null}
              onClick={onRefreshLogs}
            >
              {pendingAction === 'refresh-logs' ? <span className="loading loading-spinner loading-xs"></span> : null}
              刷新
            </button>
          </div>
          <div className="mockup-code h-[calc(100vh-12rem)] min-h-96 overflow-auto rounded-none bg-base-300/50 text-xs leading-relaxed text-base-content/80">
            {logLines ? (
              logLines.map((line, idx) => {
                const lowerLine = line.toLowerCase()
                let lineClass = 'whitespace-pre-wrap break-all '
                if (lowerLine.includes('error') || lowerLine.includes('fail') || lowerLine.includes('crit')) {
                  lineClass += 'text-error font-bold'
                } else if (lowerLine.includes('warn')) {
                  lineClass += 'text-warning font-semibold'
                } else if (lowerLine.includes('info') || lowerLine.includes('success')) {
                  lineClass += 'text-info'
                } else {
                  lineClass += 'opacity-80'
                }
                return (
                  <pre key={idx} data-prefix={idx + 1} className={lineClass}>
                    <code>{line || ' '}</code>
                  </pre>
                )
              })
            ) : (
              <pre data-prefix=">"><code>{recentLogs || '等待运行日志...'}</code></pre>
            )}
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <div role="tablist" className="tabs tabs-boxed bg-base-100 p-1 shadow-sm">
            <button
              role="tab"
              className={`tab flex-1 text-xs font-semibold ${cloudTab === 'overview' ? 'tab-active' : ''}`}
              onClick={() => setCloudTab('overview')}
            >
              总览
            </button>
            <button
              role="tab"
              className={`tab flex-1 text-xs font-semibold ${cloudTab === 'users' ? 'tab-active' : ''}`}
              onClick={() => setCloudTab('users')}
            >
              用户
            </button>
            <button
              role="tab"
              className={`tab flex-1 text-xs font-semibold ${cloudTab === 'payments' ? 'tab-active' : ''}`}
              onClick={() => setCloudTab('payments')}
            >
              支付
            </button>
            <button
              role="tab"
              className={`tab flex-1 text-xs font-semibold ${cloudTab === 'publish' ? 'tab-active' : ''}`}
              onClick={() => setCloudTab('publish')}
            >
              发布
            </button>
          </div>

          {cloudTab === 'overview' ? (
            <div className="flex flex-col gap-3">
              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-base-300 px-4 py-3">
                  <div>
                    <h2 className="text-base font-bold">总览</h2>
                    <p className="mt-1 text-xs text-base-content/55">
                      {overviewData ? `最近订单 ${overviewOrders.length} 条` : '云端后台数据'}
                    </p>
                  </div>
                  <button
                    className="btn btn-outline btn-xs"
                    disabled={loadingOverview}
                    onClick={() => void loadOverviewData(true)}
                  >
                    {loadingOverview ? <span className="loading loading-spinner loading-xs"></span> : null}
                    刷新
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 p-3">
                  <div className="rounded-box bg-base-200/70 p-3">
                    <div className="text-[11px] font-semibold text-base-content/55">用户</div>
                    <div className="mt-1 text-2xl font-black">{overviewUsers.length}</div>
                    <div className="mt-1 text-[11px] text-base-content/50">Admin {adminUserCount} · 付费 {paidUserCount}</div>
                  </div>
                  <div className="rounded-box bg-base-200/70 p-3">
                    <div className="text-[11px] font-semibold text-base-content/55">Pro Max</div>
                    <div className="mt-1 text-2xl font-black">{proMaxUserCount}</div>
                    <div className="mt-1 text-[11px] text-base-content/50">高级订阅用户</div>
                  </div>
                  <div className="rounded-box bg-base-200/70 p-3">
                    <div className="text-[11px] font-semibold text-base-content/55">共享号池</div>
                    <div className="mt-1 text-2xl font-black">{overviewSharedFiles.length}</div>
                    <div className="mt-1 text-[11px] text-base-content/50">Codex {codexSharedCount}</div>
                  </div>
                  <div className="rounded-box bg-base-200/70 p-3">
                    <div className="text-[11px] font-semibold text-base-content/55">支付商品</div>
                    <div className="mt-1 text-2xl font-black">{overviewProducts.length}</div>
                    <div className="mt-1 text-[11px] text-base-content/50">上架 {activeProductCount}</div>
                  </div>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-2">
                <div className="rounded-box border border-success/25 bg-success/10 p-3 shadow-sm">
                  <div className="text-[11px] font-semibold text-success">近 50 单收入</div>
                  <div className="mt-1 text-xl font-black">{formatCurrencyCny(paidRevenueCents)}</div>
                  <div className="mt-1 text-[11px] text-base-content/50">已支付 {paidOrders.length} 单</div>
                </div>
                <div className="rounded-box border border-warning/30 bg-warning/10 p-3 shadow-sm">
                  <div className="text-[11px] font-semibold text-warning">待处理订单</div>
                  <div className="mt-1 text-xl font-black">{pendingOrderCount}</div>
                  <div className="mt-1 text-[11px] text-base-content/50">
                    最近支付 {latestPaidOrder ? formatCompactDate(latestPaidOrder.paidAt ?? latestPaidOrder.createdAt) : '--'}
                  </div>
                </div>
              </section>

              <section className={`rounded-box border bg-base-100 shadow-sm ${agentIsOnline ? 'border-success/30' : agentEnabled ? 'border-warning/40' : 'border-base-300'}`}>
                <div className="flex items-center justify-between gap-2 border-b border-base-300 px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-bold">本机 Agent</h2>
                    <p className="mt-1 truncate text-xs text-base-content/55">
                      {agentEnabled
                        ? agentIsOnline
                          ? `在线 · 最近轮询 ${agentLastPollAt ? formatCompactDate(agentLastPollAt) : '--'}`
                          : `离线 · 超过 ${agentOfflineAfterSeconds} 秒未轮询`
                        : '已关闭 · 手机触发不会执行'}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    className="toggle toggle-success"
                    checked={agentEnabled}
                    onChange={(event) => setAgentEnabled(event.target.checked)}
                  />
                </div>
                <div className="grid gap-2 p-3">
                  {agentEnabled && !agentIsOnline ? (
                    <div className="rounded-box border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-semibold text-warning-content">
                      Agent 当前离线。请确认电脑没有休眠、CPSwitch 正在运行，并保持此开关打开。
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      className="btn btn-outline btn-xs"
                      disabled={agentLoading}
                      onClick={() => void loadAgentTasks(true)}
                    >
                      {agentLoading ? <span className="loading loading-spinner loading-xs"></span> : null}
                      刷新状态
                    </button>
                    <button
                      className="btn btn-primary btn-xs"
                      disabled={creatingAgentTask || agentRunningTaskId !== null}
                      onClick={() => void createAgentCheckTask()}
                    >
                      {creatingAgentTask || agentRunningTaskId !== null ? <span className="loading loading-spinner loading-xs"></span> : null}
                      发起检测
                    </button>
                  </div>
                  {latestAgentTask ? (
                    <div className="rounded-box bg-base-200/70 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-bold">最近任务 #{latestAgentTask.id}</div>
                        <div className={`badge badge-xs ${
                          latestAgentTask.status === 'completed'
                            ? 'badge-success'
                            : latestAgentTask.status === 'failed' || latestAgentTask.status === 'expired'
                              ? 'badge-error'
                              : 'badge-warning'
                        }`}>
                          {latestAgentTask.status}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-base-content/60">{formatAgentTaskSummary(latestAgentTask)}</div>
                      <div className="mt-1 text-[10px] text-base-content/45">
                        创建 {formatCompactDate(latestAgentTask.createdAt)}
                        {latestAgentTask.completedAt ? ` · 完成 ${formatCompactDate(latestAgentTask.completedAt)}` : ''}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-box border border-dashed border-base-300 px-3 py-4 text-center text-xs text-base-content/45">
                      暂无远程检测任务
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="border-b border-base-300 px-4 py-3">
                  <h2 className="text-base font-bold">最近订单</h2>
                  <p className="mt-1 text-xs text-base-content/55">支付状态和金额</p>
                </div>
                <div className="divide-y divide-base-200">
                  {recentOverviewOrders.length > 0 ? recentOverviewOrders.map((order) => (
                    <div key={order.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold">{order.productDisplayName || order.productName || order.planCode}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-base-content/45">{order.orderNo}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-black">{formatCurrencyCny(order.amount)}</div>
                        <div className={`badge badge-xs mt-1 ${getOrderStatusBadgeClass(order.status)}`}>
                          {getOrderStatusLabel(order.status)}
                        </div>
                      </div>
                    </div>
                  )) : (
                    <div className="px-4 py-6 text-center text-xs text-base-content/45">暂无订单</div>
                  )}
                </div>
              </section>

              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="border-b border-base-300 px-4 py-3">
                  <h2 className="text-base font-bold">最近用户</h2>
                  <p className="mt-1 text-xs text-base-content/55">账号角色和套餐</p>
                </div>
                <div className="divide-y divide-base-200">
                  {recentOverviewUsers.length > 0 ? recentOverviewUsers.map((item) => (
                    <div key={item.user.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold">{item.user.email}</div>
                        <div className="mt-0.5 text-[11px] text-base-content/45">
                          注册 {formatCompactDate(item.user.createdAt)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`badge badge-sm ${getPlanBadgeClass(item.plan.planCode)}`}>{item.plan.planCode}</div>
                        <div className="mt-1 text-[11px] text-base-content/50">{item.user.role}</div>
                      </div>
                    </div>
                  )) : (
                    <div className="px-4 py-6 text-center text-xs text-base-content/45">暂无用户</div>
                  )}
                </div>
              </section>
            </div>
          ) : cloudTab === 'users' ? (
            <div className="flex flex-col gap-3">
              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-base-300 px-4 py-3">
                  <div>
                    <h2 className="text-base font-bold">用户</h2>
                    <p className="mt-1 text-xs text-base-content/55">
                      共 {spUsers.length} 个 · 付费 {spPaidUsers} 个
                    </p>
                  </div>
                  <button
                    className="btn btn-outline btn-xs"
                    disabled={loadingUsers}
                    onClick={() => void loadUsersData(true)}
                  >
                    {loadingUsers ? <span className="loading loading-spinner loading-xs"></span> : null}
                    刷新
                  </button>
                </div>
                <div className="grid gap-2 p-3">
                  <input
                    className="input input-bordered input-sm w-full"
                    placeholder="搜索邮箱 / ID / 角色 / 套餐"
                    value={spUserSearch}
                    onChange={(event) => {
                      setSpUserSearch(event.target.value)
                      setSpUserPage(1)
                    }}
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-box bg-base-200/70 p-2 text-center">
                      <div className="text-lg font-black">{spUsers.length}</div>
                      <div className="text-[10px] text-base-content/50">用户</div>
                    </div>
                    <div className="rounded-box bg-base-200/70 p-2 text-center">
                      <div className="text-lg font-black">{spPaidUsers}</div>
                      <div className="text-[10px] text-base-content/50">付费</div>
                    </div>
                    <div className="rounded-box bg-base-200/70 p-2 text-center">
                      <div className="text-lg font-black">{spUsers.filter((item) => item.user.role === 'admin').length}</div>
                      <div className="text-[10px] text-base-content/50">Admin</div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="grid gap-3">
                {visibleSpUsers.length > 0 ? visibleSpUsers.map((item) => {
                  const role = spDraftRoles[item.user.id] ?? item.user.role
                  const planCode = spDraftPlans[item.user.id] ?? item.plan.planCode
                  const expiresAt = spDraftExpiresAt[item.user.id] ?? ''
                  const changed = role !== item.user.role || planCode !== item.plan.planCode || expiresAt !== (item.expiresAt ? item.expiresAt.slice(0, 16) : '')
                  return (
                    <article key={item.user.id} className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                      <div className="border-b border-base-200 px-2.5 py-2">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-black leading-tight">{item.user.email}</div>
                            <div className="mt-0.5 text-[10px] leading-tight text-base-content/45">
                              ID {item.user.id} · 注册 {formatCompactDate(item.user.createdAt)}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <div className={`badge badge-xs ${getRoleBadgeClass(item.user.role)}`}>{item.user.role}</div>
                            <div className={`badge badge-xs ${getPlanBadgeClass(item.plan.planCode)}`}>{item.plan.planCode}</div>
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-2 p-2.5">
                        <div className="grid grid-cols-[0.85fr_0.9fr_1.25fr] gap-1.5">
                          <label className="grid gap-1">
                            <span className="text-[10px] font-semibold text-base-content/50">角色</span>
                            <select
                              className="select select-bordered select-xs h-8 min-h-8 w-full"
                              value={role}
                              onChange={(event) =>
                                setSpDraftRoles((current) => ({
                                  ...current,
                                  [item.user.id]: event.target.value === 'admin' ? 'admin' : 'user'
                                }))
                              }
                            >
                              <option value="user">user</option>
                              <option value="admin">admin</option>
                            </select>
                          </label>
                          <label className="grid gap-1">
                            <span className="text-[10px] font-semibold text-base-content/50">套餐</span>
                            <select
                              className="select select-bordered select-xs h-8 min-h-8 w-full"
                              value={planCode}
                              onChange={(event) =>
                                setSpDraftPlans((current) => ({
                                  ...current,
                                  [item.user.id]: event.target.value
                                }))
                              }
                            >
                              {spPlans.map((plan) => (
                                <option key={plan.id} value={plan.planCode}>
                                  {plan.planCode}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid gap-1">
                            <span className="text-[10px] font-semibold text-base-content/50">到期</span>
                            <input
                              type="datetime-local"
                              className="input input-bordered input-xs h-8 w-full min-w-0"
                              value={expiresAt}
                              onChange={(event) =>
                                setSpDraftExpiresAt((current) => ({
                                  ...current,
                                  [item.user.id]: event.target.value
                                }))
                              }
                            />
                          </label>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 truncate text-[10px] text-base-content/45">
                            {item.user.status} · 当前 {item.plan.name} · {item.expiresAt ? formatCompactDate(item.expiresAt) : '无到期'}
                          </div>
                          <button
                            className="btn btn-primary btn-xs h-7 min-h-7 shrink-0 px-3"
                            disabled={savingSpUserId === item.user.id || !changed}
                            onClick={() => void saveSpUser(item)}
                          >
                            {savingSpUserId === item.user.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                            保存
                          </button>
                        </div>
                      </div>
                    </article>
                  )
                }) : (
                  <div className="rounded-box border border-dashed border-base-300 bg-base-100 px-4 py-8 text-center text-xs text-base-content/45">
                    {loadingUsers ? '正在加载用户...' : '没有匹配用户'}
                  </div>
                )}
                {filteredSpUsers.length > 0 ? (
                  <div className="rounded-box border border-base-300 bg-base-100 px-3 py-2 shadow-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-base-content/55">
                        第 {currentSpUserPage} / {spUserTotalPages} 页 · 共 {filteredSpUsers.length} 个
                      </div>
                      <div className="join">
                        <button
                          className="btn btn-xs join-item"
                          disabled={currentSpUserPage <= 1}
                          onClick={() => setSpUserPage((page) => Math.max(1, page - 1))}
                        >
                          上一页
                        </button>
                        <button
                          className="btn btn-xs join-item"
                          disabled={currentSpUserPage >= spUserTotalPages}
                          onClick={() => setSpUserPage((page) => Math.min(spUserTotalPages, page + 1))}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          ) : cloudTab === 'publish' ? (
            <div className="flex flex-col gap-3">
              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-base-300 px-4 py-3">
                  <div>
                    <h2 className="text-base font-bold">共享号池</h2>
                    <p className="mt-1 text-xs text-base-content/55">{sharedCloudFiles.length} 个共享认证</p>
                  </div>
                  <button
                    className="btn btn-outline btn-xs"
                    disabled={loadingPublish}
                    onClick={() => void loadPublishData(true)}
                  >
                    {loadingPublish ? <span className="loading loading-spinner loading-xs"></span> : null}
                    刷新
                  </button>
                </div>

                <div className="grid gap-2 p-3">
                  <div className="grid grid-cols-[1fr_6.5rem] gap-2">
                    <select
                      className="select select-bordered select-sm h-9 min-h-9"
                      value={sharedCredentialMode}
                      onChange={(event) => setSharedCredentialMode(event.target.value === 'quota_card' ? 'quota_card' : 'plain')}
                    >
                      <option value="plain">普通凭证</option>
                      <option value="quota_card">加密额度卡</option>
                    </select>
                    <input
                      type="number"
                      min={1}
                      className="input input-bordered input-sm h-9 min-h-9"
                      disabled={sharedCredentialMode !== 'quota_card'}
                      value={sharedQuotaLimit}
                      onChange={(event) => setSharedQuotaLimit(Math.max(1, Number(event.target.value) || 1))}
                    />
                  </div>
                  <button
                    className="btn btn-primary btn-sm w-full"
                    disabled={uploadingShared}
                    onClick={() => void handleSharedUploadClick()}
                  >
                    {uploadingShared ? <span className="loading loading-spinner loading-xs"></span> : null}
                    上传共享认证
                  </button>
                  <button
                    className="btn btn-outline btn-warning btn-sm w-full"
                    disabled={checkingInvalidShared || sharedCloudFiles.length === 0}
                    onClick={() => void checkInvalidSharedFiles()}
                  >
                    {checkingInvalidShared ? <span className="loading loading-spinner loading-xs"></span> : null}
                    检测不可用
                  </button>
                  {invalidSharedCandidates.length > 0 ? (
                    <button
                      className="btn btn-warning btn-sm w-full"
                      disabled={deletingInvalidShared}
                      onClick={() => void deleteInvalidSharedFiles()}
                    >
                      {deletingInvalidShared ? <span className="loading loading-spinner loading-xs"></span> : null}
                      删除不可用（{invalidSharedCandidates.length}）
                    </button>
                  ) : null}
                  <button
                    className="btn btn-outline btn-error btn-sm w-full"
                    disabled={clearingSharedPool || sharedCloudFiles.length === 0}
                    onClick={() => void clearSharedPool()}
                  >
                    {clearingSharedPool ? <span className="loading loading-spinner loading-xs"></span> : null}
                    清空共享号池
                  </button>
                </div>

                {invalidSharedCandidates.length > 0 ? (
                  <div className="border-t border-base-300 bg-warning/10 p-2">
                    <div className="mb-2 text-xs font-bold text-warning-content">
                      待删除不可用认证
                    </div>
                    <div className="grid gap-2">
                      {invalidSharedCandidates.map((candidate) => (
                        <div key={candidate.file.id} className="rounded-box bg-base-100 p-2 text-xs">
                          <div className="truncate font-semibold">{candidate.file.displayName || candidate.file.fileName}</div>
                          <div className="mt-1 max-h-8 overflow-hidden text-[11px] leading-snug text-base-content/55">
                            {candidate.status ? `${candidate.status} · ` : ''}{candidate.reason}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="max-h-72 overflow-auto border-t border-base-300 p-2">
                  {sharedCloudFiles.length === 0 ? (
                    <div className="rounded-box border border-dashed border-base-300 px-4 py-6 text-center text-xs text-base-content/50">
                      当前共享号池为空
                    </div>
                  ) : (
                    <div className="divide-y divide-base-200 overflow-hidden rounded-box border border-base-200">
                      {sharedCloudFiles.map((file) => (
                        <div key={file.id} className="flex min-w-0 items-center gap-2 bg-base-100 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold leading-tight">{file.displayName || file.fileName}</div>
                            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight text-base-content/50">
                              <span className="shrink-0">{file.provider || 'unknown'}</span>
                              <span className="shrink-0">·</span>
                              <span className="min-w-0 truncate">{file.fileName}</span>
                            </div>
                            {file.planRequired ? (
                              <div className="mt-1 inline-flex rounded-full bg-base-200 px-2 py-0.5 text-[10px] font-semibold text-base-content/60">
                                {file.planRequired}
                              </div>
                            ) : null}
                            <div className="mt-1 flex flex-wrap gap-1">
                              <span className={`badge badge-xs ${file.distributionMode === 'quota_card' ? 'badge-warning' : 'badge-ghost'}`}>
                                {formatSharedDistributionMode(file)}
                              </span>
                              {file.distributionMode === 'quota_card' ? (
                                <span className="badge badge-xs badge-outline">
                                  {file.quotaUsed ?? 0}/{file.quotaLimit ?? 0}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <button
                            className="btn btn-outline btn-error btn-xs h-8 min-h-8 shrink-0 px-3"
                            disabled={deletingSharedFileId === file.id || clearingSharedPool}
                            onClick={() => void deleteSharedFile(file)}
                          >
                            {deletingSharedFileId === file.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="border-b border-base-300 px-4 py-3">
                  <h2 className="text-base font-bold">应用更新</h2>
                  <p className="mt-1 text-xs text-base-content/55">上传后自动更新 latest.json</p>
                </div>
                <div className="grid gap-3 p-3">
                  <label className="grid gap-1.5">
                    <span className="text-xs font-semibold text-base-content/65">版本号</span>
                    <input
                      className="input input-bordered input-sm w-full"
                      placeholder="例如 1.1.5"
                      value={releaseVersion}
                      onChange={(event) => setReleaseVersion(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-semibold text-base-content/65">更新说明</span>
                    <textarea
                      className="textarea textarea-bordered min-h-20 w-full resize-none text-sm"
                      placeholder="可选，写到 latest.json"
                      value={releaseNotes}
                      onChange={(event) => setReleaseNotes(event.target.value)}
                    />
                  </label>
                  <button
                    className="btn btn-secondary btn-sm w-full"
                    disabled={uploadingRelease}
                    onClick={() => releaseInputRef.current?.click()}
                  >
                    {uploadingRelease ? <span className="loading loading-spinner loading-xs"></span> : null}
                    上传安装包
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-base-300 px-4 py-3">
                  <div>
                    <h2 className="text-base font-bold">支付</h2>
                    <p className="mt-1 text-xs text-base-content/55">
                      近 50 单 · 商品 {spPaymentProducts.length} 个
                    </p>
                  </div>
                  <button
                    className="btn btn-outline btn-xs"
                    disabled={loadingPayments}
                    onClick={() => void loadPaymentsData(true)}
                  >
                    {loadingPayments ? <span className="loading loading-spinner loading-xs"></span> : null}
                    刷新
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2 p-3">
                  <div className="rounded-box bg-success/10 p-2 text-center">
                    <div className="truncate text-base font-black">{formatCurrencyCny(spPaymentRevenueCents)}</div>
                    <div className="text-[10px] text-base-content/50">收入</div>
                  </div>
                  <div className="rounded-box bg-warning/10 p-2 text-center">
                    <div className="text-base font-black">{spPendingOrders}</div>
                    <div className="text-[10px] text-base-content/50">待支付</div>
                  </div>
                  <div className="rounded-box bg-base-200/70 p-2 text-center">
                    <div className="text-base font-black">{spActiveProducts}</div>
                    <div className="text-[10px] text-base-content/50">上架</div>
                  </div>
                </div>
                <div className="grid gap-2 border-t border-base-200 p-3">
                  <div className="grid grid-cols-[0.85fr_minmax(0,1fr)] gap-2">
                    <select
                      className="select select-bordered select-sm w-full"
                      value={spPaymentStatusFilter}
                      onChange={(event) => {
                        const nextStatus = event.target.value as 'all' | CloudPaymentOrder['status']
                        setSpPaymentStatusFilter(nextStatus)
                        void loadPaymentsData(false, { status: nextStatus, query: spPaymentQuery })
                      }}
                    >
                      <option value="all">全部</option>
                      <option value="pending">待支付</option>
                      <option value="paid">已支付</option>
                      <option value="closed">已关闭</option>
                      <option value="failed">失败</option>
                      <option value="refunded">退款</option>
                    </select>
                    <input
                      className="input input-bordered input-sm w-full"
                      placeholder="搜索订单 / 用户"
                      value={spPaymentQuery}
                      onChange={(event) => setSpPaymentQuery(event.target.value)}
                    />
                  </div>
                  <button
                    className="btn btn-primary btn-sm w-full"
                    disabled={loadingPayments}
                    onClick={() => void loadPaymentsData(false, { status: spPaymentStatusFilter, query: spPaymentQuery })}
                  >
                    查询订单
                  </button>
                </div>
              </section>

              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="border-b border-base-300 px-4 py-3">
                  <h2 className="text-base font-bold">支付商品</h2>
                  <p className="mt-1 text-xs text-base-content/55">价格和上架状态</p>
                </div>
                <div className="divide-y divide-base-200">
                  {spPaymentProducts.length > 0 ? spPaymentProducts.map((product) => (
                    <div key={product.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold">{product.displayName}</div>
                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-base-content/45">
                          <span className={`badge badge-xs ${getPlanBadgeClass(product.planCode)}`}>{product.planCode}</span>
                          <span>{product.durationDays} 天</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-black">{formatCurrencyCny(product.priceAmount)}</div>
                        <div className={`badge badge-xs mt-1 ${product.status === 'active' ? 'badge-success' : 'badge-ghost'}`}>
                          {product.status === 'active' ? '上架' : '下架'}
                        </div>
                      </div>
                    </div>
                  )) : (
                    <div className="px-4 py-6 text-center text-xs text-base-content/45">
                      {loadingPayments ? '正在加载商品...' : '暂无支付商品'}
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                <div className="border-b border-base-300 px-4 py-3">
                  <h2 className="text-base font-bold">订单</h2>
                  <p className="mt-1 text-xs text-base-content/55">最近订单和补发</p>
                </div>
                <div className="divide-y divide-base-200">
                  {spPaymentOrders.length > 0 ? spPaymentOrders.map((order) => (
                    <div key={order.id} className="grid gap-2 px-3 py-2.5">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold">{order.productDisplayName || order.productName || order.planCode}</div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-base-content/45">{order.orderNo}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-black">{formatCurrencyCny(order.amount)}</div>
                          <div className={`badge badge-xs mt-1 ${getOrderStatusBadgeClass(order.status)}`}>
                            {getOrderStatusLabel(order.status)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 truncate text-[10px] text-base-content/45">
                          用户 {order.userId} · {formatCompactDate(order.createdAt)}
                        </div>
                        <button
                          className="btn btn-outline btn-xs h-7 min-h-7 shrink-0 px-2"
                          disabled={regrantingSpOrderNo === order.orderNo || order.status !== 'paid'}
                          onClick={() => void regrantSpOrder(order)}
                        >
                          {regrantingSpOrderNo === order.orderNo ? <span className="loading loading-spinner loading-xs"></span> : null}
                          补发
                        </button>
                      </div>
                    </div>
                  )) : (
                    <div className="px-4 py-6 text-center text-xs text-base-content/45">
                      {loadingPayments ? '正在加载订单...' : '暂无订单'}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </section>
      )}
    </main>
  )
}

function normalizeLoginIdentifier(value: string) {
  const normalized = value.trim()
  return normalized.includes('@') ? normalized.toLowerCase() : normalized
}

function App() {
  const passwordDialogRef = useRef<HTMLDialogElement | null>(null)
  const updateDialogRef = useRef<HTMLDialogElement | null>(null)
  const autoStartAttemptedRef = useRef(false)
  const lastCloudSessionRefreshRef = useRef(0)
  const [theme, setTheme] = useState<Theme>(() => {
    const raw = window.localStorage.getItem(THEME_KEY)
    if (THEMES.includes(raw as Theme)) {
      return raw as Theme
    }
    return 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    window.localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    void cpaRuntime.onAppUpdateDownloadProgress((progress) => {
      if (typeof progress.percent === 'number') {
        setUpdateDownloadProgress(Math.max(0, Math.min(100, progress.percent)))
      }
    }).then((cleanup) => {
      unlisten = cleanup
    })
    return () => {
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const raw = window.localStorage.getItem(REMEMBERED_EMAIL_KEY)
    if (!raw) {
      return
    }
    const rememberedEmail = normalizeLoginIdentifier(String(raw))
    if (!rememberedEmail) {
      window.localStorage.removeItem(REMEMBERED_EMAIL_KEY)
      return
    }
    setEmail(rememberedEmail)
  }, [])

  const [session, setSession] = useState<LoginSession | null>(() => {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as LoginSession
    } catch {
      return null
    }
  })

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [trustDevice, setTrustDevice] = useState(true)
  const [pendingChallenge, setPendingChallenge] = useState<PendingLoginChallenge | null>(null)
  const [pendingRegisterChallenge, setPendingRegisterChallenge] = useState<PendingRegisterChallenge | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [conflictDevice, setConflictDevice] = useState<CloudLoginConflictResponse['active_device'] | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [registerMode, setRegisterMode] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [cpaState, setCpaState] = useState<CpaState | null>(null)
  const [managementInfo, setManagementInfo] = useState<CpaManagementInfo | null>(null)
  const [recentLogs, setRecentLogs] = useState('等待运行日志...')
  const [settings, setSettings] = useState<BootstrapSettings>(createEmptySettings)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [errorToastMessage, setErrorToastMessage] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState(0)
  const [downloadedUpdate, setDownloadedUpdate] = useState<AppUpdateDownloadResult | null>(null)
  const [adminTab, setAdminTab] = useState<AdminTab>('overview')
  const [userTab, setUserTab] = useState<UserTab>('overview')
  const [developerSurfaceMode, setDeveloperSurfaceMode] = useState<DeveloperSurfaceMode>('user')
  const [normalizingFreeTier, setNormalizingFreeTier] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const cpmFrameRef = useRef<HTMLIFrameElement | null>(null)
  const errorToastTimerRef = useRef<number | null>(null)
  const trustedLoginAttemptedRef = useRef(false)

  const statusTone = useMemo(() => {
    switch (cpaState?.status) {
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
  }, [cpaState?.status])

  const cpmUrl = useMemo(() => {
    const apiBase = `http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}`
    const managementKey = managementInfo?.managementKey ?? ''
    const query = new URLSearchParams({
      apiBase,
      managementKey,
      target: '/cpm/index.html#/'
    })
    return `/cpm-bridge.html?${query.toString()}`
  }, [cpaState?.apiPort, managementInfo?.managementKey, settings.apiPort])

  const useNewUserWorkspace = true
  const sessionPlanLabel = useMemo(
    () => formatPlanLabel(session?.plan.planCode, session?.plan.name),
    [session?.plan.name, session?.plan.planCode]
  )

  const userDisplayName = useMemo(() => {
    if (!session?.user.email) {
      return ''
    }
    const [name] = session.user.email.split('@')
    return name || session.user.email
  }, [session?.user.email])
  const actualIsAdmin = isAdminRole(session?.user.role)
  const canUseDeveloperSwitch =
    actualIsAdmin || userDisplayName.trim().toLowerCase() === 'xieyuqi'
  const isSpAdminSurface = canUseDeveloperSwitch && developerSurfaceMode === 'spadmin'
  const effectiveIsAdmin = canUseDeveloperSwitch ? developerSurfaceMode !== 'user' : actualIsAdmin
  const isFullAdminSurface = effectiveIsAdmin && !isSpAdminSurface

  useEffect(() => {
    if (!session) {
      return
    }
    setDeveloperSurfaceMode(actualIsAdmin ? 'admin' : 'user')
  }, [actualIsAdmin, session?.user.id])

  const refreshSessionFromCloud = async () => {
    if (!session) {
      return null
    }
    const next = await cloudClient.me(session.token)
    const nextSession: LoginSession = {
      token: session.token,
      user: next.user,
      plan: next.plan,
      features: next.features,
      expiresAt: next.expiresAt ?? null
    }
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
    setSession(nextSession)
    lastCloudSessionRefreshRef.current = Date.now()
    return nextSession
  }

  const refresh = async () => {
    try {
      const [nextAppState, nextCpaState, nextManagementInfo, nextRecentLogs] = await Promise.all([
        cpaRuntime.getAppState(),
        cpaRuntime.getState(),
        cpaRuntime.getManagementInfo(),
        cpaRuntime.getRecentLogs(),
      ])

      setAppState(nextAppState)
      setCpaState(nextCpaState)
      setManagementInfo(nextManagementInfo)
      setRecentLogs(nextRecentLogs || '当前还没有日志。')
      setSettings(nextCpaState.bootstrap)
      handleLoadError(null)

      if (session && Date.now() - lastCloudSessionRefreshRef.current > 60_000) {
        await refreshSessionFromCloud()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    }
  }

  const checkForUpdates = async (silent = false) => {
    try {
      setCheckingUpdate(true)
      const info = await cpaRuntime.checkAppUpdate()
      setUpdateInfo(info)
      setDownloadedUpdate(null)
      setUpdateDownloadProgress(0)
      if (info.hasUpdate) {
        if (!silent) {
          showToast(`发现新版本 ${info.latestVersion}`)
        }
        updateDialogRef.current?.showModal()
        return
      }
      if (!silent) {
        showToast(`当前已是最新版 ${info.currentVersion}`)
      }
    } catch (error) {
      if (!silent) {
        const message = error instanceof Error ? error.message : String(error)
        handleLoadError(message)
      }
    } finally {
      setCheckingUpdate(false)
    }
  }

  const downloadUpdate = async () => {
    if (!updateInfo?.hasUpdate || !updateInfo.downloadUrl) {
      return
    }
    try {
      setDownloadingUpdate(true)
      setDownloadedUpdate(null)
      setUpdateDownloadProgress(0)
      const result = await cpaRuntime.downloadAppUpdate(updateInfo.downloadUrl, updateInfo.latestVersion)
      setDownloadedUpdate(result)
      setUpdateDownloadProgress(100)
      showToast('更新包下载完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      setDownloadingUpdate(false)
    }
  }

  const installDownloadedUpdate = async () => {
    if (!downloadedUpdate?.filePath) {
      return
    }
    try {
      setInstallingUpdate(true)
      await cpaRuntime.installDownloadedAppUpdate(downloadedUpdate.filePath)
    } catch (error) {
      setInstallingUpdate(false)
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    }
  }

  useEffect(() => {
    if (!session) return

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 3000)

    return () => window.clearInterval(timer)
  }, [session])

  useEffect(() => {
    if (!session) {
      return
    }
    void checkForUpdates(true)
  }, [session?.token])

  useEffect(() => {
    if (!session) {
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const next = await cloudClient.me(session.token)
        if (cancelled) {
          return
        }
        const nextSession: LoginSession = {
          token: session.token,
          user: next.user,
          plan: next.plan,
          features: next.features,
          expiresAt: next.expiresAt ?? null
        }
        window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
        setSession(nextSession)
        lastCloudSessionRefreshRef.current = Date.now()
      } catch (error) {
        console.error(error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (session || trustedLoginAttemptedRef.current) {
      return
    }
    trustedLoginAttemptedRef.current = true
    const trustedLogin = cloudClient.getTrustedDeviceLogin()
    if (!trustedLogin) {
      return
    }
    if (trustedLogin.trustedUntil && new Date(trustedLogin.trustedUntil).getTime() <= Date.now()) {
      cloudClient.clearTrustedDeviceLogin()
      return
    }

    setEmail(trustedLogin.email)
    void (async () => {
      try {
        setPendingAction('trusted-login')
        const response = await cloudClient.loginTrustedDevice(trustedLogin.email, trustedLogin.trustedToken)
        completeLogin(response, trustedLogin.email)
        showToast('已自动登录')
      } catch {
        cloudClient.clearTrustedDeviceLogin()
      } finally {
        setPendingAction(null)
      }
    })()
  }, [session])

  useEffect(() => {
    if (!session || cpaState?.status !== 'running' || session.features.max_enabled_auth_files !== 1) {
      return
    }

    let cancelled = false
    void (async () => {
      try {
        setNormalizingFreeTier(true)
        const response = await authFilesApi.list()
        const files = Array.isArray(response.files) ? response.files : []
        const enabledFiles = files.filter((file) => !`${file.disabled ?? ''}`.match(/^(true|1)$/i) && file.disabled !== true && file.disabled !== 1)

        if (enabledFiles.length === 0) {
          return
        }

        await Promise.all(enabledFiles.map((file) => authFilesApi.setStatus(file.name, true)))
        if (!cancelled) {
          showToast('免费版登录已自动禁用全部认证文件，请手动启用一个')
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          handleLoadError(message)
        }
      } finally {
        if (!cancelled) {
          setNormalizingFreeTier(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [session, cpaState?.status])

  useEffect(() => {
    if (!session || cpaState?.status !== 'running' || isAdminRole(session.user.role) || session.features.allow_shared_pool) {
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const trackedFiles = sharedImportRegistry.list()
        if (trackedFiles.length === 0) {
          return
        }
        const response = await authFilesApi.list()
        const files = Array.isArray(response.files) ? response.files : []
        const names = new Set(trackedFiles.map((item) => item.localFileName))
        const activeSharedFiles = files.filter((file) => names.has(file.name) && file.disabled !== true && file.disabled !== 1 && !`${file.disabled ?? ''}`.match(/^(true|1)$/i))

        if (activeSharedFiles.length === 0 || cancelled) {
          return
        }

        await Promise.all(activeSharedFiles.map((file) => authFilesApi.setStatus(file.name, true)))
        if (!cancelled) {
          showToast('当前套餐不可使用共享认证池，已自动禁用本地共享认证文件')
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          handleLoadError(message)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [session, cpaState?.status])

  const runAction = async (name: string, action: () => Promise<unknown>, successMsg?: string) => {
    try {
      setPendingAction(name)
      await action()
      await refresh()
      if (successMsg) {
        setToastMessage(successMsg)
        setTimeout(() => setToastMessage(null), 2000)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  useEffect(() => {
    const syncWindowShell = async () => {
      try {
        const appWindow = getCurrentWindow()
        const target = isFullAdminSurface ? ADMIN_WINDOW_SIZE : MOBILE_WINDOW_SIZE
        await appWindow.setMinSize(new LogicalSize(target.minWidth, target.minHeight))
        await appWindow.setSize(new LogicalSize(target.width, target.height))
        await appWindow.center()
      } catch {
        // Ignore browser mode or early Tauri runtime unavailability.
      }
    }

    void syncWindowShell()
  }, [isFullAdminSurface])

  useEffect(() => {
    if (!session || isAdminRole(session.user.role) || !settings.autoStart) {
      autoStartAttemptedRef.current = false
      return
    }
    if (cpaState?.status === 'running' || cpaState?.status === 'starting') {
      autoStartAttemptedRef.current = true
      return
    }
    if (pendingAction !== null || cpaState?.status !== 'stopped' || autoStartAttemptedRef.current) {
      return
    }

    autoStartAttemptedRef.current = true
    void runAction('start', () => cpaRuntime.start())
  }, [session, settings.autoStart, cpaState?.status, pendingAction])

  const savePort = async () => {
    const normalizedPort = Number(settings.apiPort)
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      handleLoadError('端口必须是 1 到 65535 之间的整数。')
      return
    }

    await runAction('save-port', async () => {
      await cpaRuntime.saveBootstrapSettings({
        ...settings,
        apiPort: normalizedPort
      })

      if (cpaState?.status === 'running') {
        await cpaRuntime.restart()
      }
    })
  }

  const submitLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setLoginError('请输入账号和密码。')
      return
    }

    try {
      setPendingAction('login')
      const normalizedEmail = normalizeLoginIdentifier(email)
      const response = await cloudClient.login(normalizedEmail, password, trustDevice)
      if (response.status === 'verification_required') {
        const challenge = response as CloudLoginChallengeResponse
        setPendingChallenge({
          email: normalizedEmail,
          challengeId: challenge.challenge_id,
          maskedEmail: challenge.masked_email,
          expiresAt: challenge.expires_at,
          debugCode: challenge.debug_code
        })
        setVerificationCode('')
        setConflictDevice(null)
        setLoginError(null)
        if (challenge.debug_code) {
          showToast(`本地调试验证码：${challenge.debug_code}`)
        } else {
          showToast(`验证码已发送到 ${challenge.masked_email}`)
        }
        return
      }
      completeLogin(response as CloudLoginResponse, normalizedEmail)
      showToast(`登录成功：${response.plan.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoginError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const submitVerification = async (forceLogoutExisting = false) => {
    if (!pendingChallenge) {
      return
    }
    if (!verificationCode.trim()) {
      setLoginError('请输入邮箱验证码。')
      return
    }
    try {
      setPendingAction(forceLogoutExisting ? 'kick-login' : 'verify-login')
      const response = await cloudClient.verifyLogin(
        pendingChallenge.email,
        pendingChallenge.challengeId,
        verificationCode.trim(),
        trustDevice,
        forceLogoutExisting
      )
      if (response.status === 'conflict') {
        setConflictDevice(response.active_device ?? null)
        setLoginError('该账号当前已有另一台设备在线。确认后将踢掉旧设备并继续登录。')
        return
      }
      completeLogin(response as CloudLoginResponse, pendingChallenge.email)
      setPendingChallenge(null)
      setVerificationCode('')
      setConflictDevice(null)
      showToast(`登录成功：${response.plan.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoginError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const submitRegister = async () => {
    if (!email.trim() || !password.trim()) {
      setLoginError('请输入账号和密码。')
      return
    }

    try {
      setPendingAction('register')
      const normalizedEmail = email.trim().toLowerCase()
      const challenge = await cloudClient.register(normalizedEmail, password)
      setPendingRegisterChallenge({
        email: normalizedEmail,
        challengeId: challenge.challenge_id,
        maskedEmail: challenge.masked_email,
        expiresAt: challenge.expires_at,
        debugCode: challenge.debug_code
      })
      setVerificationCode('')
      setLoginError(null)
      if (challenge.debug_code) {
        showToast(`本地调试验证码：${challenge.debug_code}`)
      } else {
        showToast(`注册验证码已发送到 ${challenge.masked_email}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoginError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const submitRegisterVerification = async () => {
    if (!pendingRegisterChallenge) {
      return
    }
    if (!verificationCode.trim()) {
      setLoginError('请输入注册验证码。')
      return
    }
    try {
      setPendingAction('register-verify')
      await cloudClient.verifyRegister(
        pendingRegisterChallenge.email,
        pendingRegisterChallenge.challengeId,
        verificationCode.trim()
      )
      setRegisterMode(false)
      setPendingRegisterChallenge(null)
      setVerificationCode('')
      setPassword('')
      setLoginError(null)
      showToast('注册成功，请使用新账号登录')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoginError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const logout = () => {
    if (session) {
      void cloudClient.logout(session.token).catch(() => undefined)
    }
    window.sessionStorage.removeItem(SESSION_KEY)
    cloudClient.clearTrustedDeviceLogin()
    setSession(null)
    setPassword('')
    setPendingChallenge(null)
    setPendingRegisterChallenge(null)
    setVerificationCode('')
    setConflictDevice(null)
    setLoginError(null)
  }

  const completeLogin = (response: CloudLoginResponse, loginEmail: string) => {
    const nextSession: LoginSession = {
      token: response.token,
      user: response.user,
      plan: response.plan,
      features: response.features,
      expiresAt: response.expiresAt ?? null
    }
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
    window.localStorage.setItem(REMEMBERED_EMAIL_KEY, loginEmail)
    if (response.trusted_token) {
      cloudClient.saveTrustedDeviceLogin({
        email: loginEmail,
        deviceId: cloudClient.getDeviceId(loginEmail),
        trustedToken: response.trusted_token,
        trustedUntil: response.trusted_until ?? null
      })
    } else {
      cloudClient.clearTrustedDeviceLogin()
    }
    setSession(nextSession)
    setLoginError(null)
    setPassword('')
  }

  const submitChangePassword = async () => {
    if (!session) {
      return
    }
    if (!currentPassword.trim() || !nextPassword.trim()) {
      handleLoadError('请输入当前密码和新密码。')
      return
    }
    try {
      setPendingAction('change-password')
      await cloudClient.changePassword(session.token, currentPassword, nextPassword)
      setCurrentPassword('')
      setNextPassword('')
      handleLoadError(null)
      showToast('密码修改成功，请使用新密码继续登录')
      passwordDialogRef.current?.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  const showToast = (message: string) => {
    setToastMessage(message)
    window.setTimeout(() => setToastMessage(null), 2500)
  }

  const handleLoadError = (message: string | null) => {
    setLoadError(message)
    if (!message) {
      setErrorToastMessage(null)
      if (errorToastTimerRef.current !== null) {
        window.clearTimeout(errorToastTimerRef.current)
        errorToastTimerRef.current = null
      }
      return
    }
    setErrorToastMessage(message)
    if (errorToastTimerRef.current !== null) {
      window.clearTimeout(errorToastTimerRef.current)
    }
    errorToastTimerRef.current = window.setTimeout(() => {
      setErrorToastMessage(null)
      errorToastTimerRef.current = null
    }, 3000)
  }

  const summarizeImportResult = (result: ImportAuthFilesResult) => {
    if (result.skipped.length > 0) {
      return `已导入 ${result.importedCount} 个认证文件，跳过 ${result.skipped.length} 个无效项目`
    }
    return `已导入 ${result.importedCount} 个认证文件`
  }

  const getExternalHref = (href: string, baseUrl: string) => {
    try {
      const url = new URL(href, baseUrl)
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        return null
      }
      return url.toString()
    } catch {
      return null
    }
  }

  const openExternalHref = async (href: string) => {
    await cpaRuntime.openExternalTarget(href)
  }

  const installExternalLinkHandler = (doc: Document | null, baseUrl: string) => {
    if (!doc) {
      return () => {}
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) {
        return
      }

      const href = anchor.getAttribute('href')
      if (!href) {
        return
      }

      const externalHref = getExternalHref(href, baseUrl)
      if (!externalHref) {
        return
      }

      event.preventDefault()
      void openExternalHref(externalHref)
    }

    doc.addEventListener('click', handleClick, true)
    return () => doc.removeEventListener('click', handleClick, true)
  }

  const handleImportSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files
    if (!selectedFiles || selectedFiles.length === 0) {
      return
    }

    try {
      setPendingAction('import-auth-files')
      handleLoadError(null)

      const payload = await Promise.all(
        Array.from(selectedFiles).map(async (file) => ({
          name: file.name,
          bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
        }))
      )

      const result = await cpaRuntime.importAuthFiles(payload)
      await refresh()
      showToast(summarizeImportResult(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      event.target.value = ''
      setPendingAction(null)
    }
  }

  const handleExportAuthFiles = async () => {
    try {
      setPendingAction('export-auth-files')
      handleLoadError(null)
      const archive = await cpaRuntime.exportAuthFilesArchive()
      if (!archive.savedPath) {
        return
      }
      showToast(`已导出 ${archive.fileCount} 个认证文件`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handleLoadError(message)
    } finally {
      setPendingAction(null)
    }
  }

  useEffect(() => {
    const cleanupMain = installExternalLinkHandler(document, window.location.href)
    return cleanupMain
  }, [])

  useEffect(() => {
    if (!effectiveIsAdmin || adminTab !== 'cpm') {
      return
    }

    const iframe = cpmFrameRef.current
    if (!iframe) {
      return
    }

    let cleanupFrame = () => {}
    const attachFrameHandler = () => {
      cleanupFrame()
      cleanupFrame = installExternalLinkHandler(iframe.contentDocument, iframe.src || window.location.href)
    }

    iframe.addEventListener('load', attachFrameHandler)
    attachFrameHandler()

    return () => {
      iframe.removeEventListener('load', attachFrameHandler)
      cleanupFrame()
    }
  }, [adminTab, cpmUrl, effectiveIsAdmin])

  if (!session) {
    return (
      <div className="min-h-screen bg-base-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-primary flex items-center justify-center text-primary-content shadow-lg mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </div>
            <h1 className="text-3xl font-black tracking-tight text-base-content mb-2">CPSwitch</h1>
            <p className="text-base-content/60 text-sm">极简高效的桌面代理工具</p>
          </div>

          <div className="card bg-base-200/80 shadow-xl border border-base-300 backdrop-blur-sm">
            <div className="card-body p-6 sm:p-8">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl font-bold text-base-content">{registerMode ? '创建账号' : '欢迎回来'}</h2>
                <button
                  className="btn btn-ghost btn-sm text-primary hover:bg-primary/10"
                  onClick={() => {
                    setRegisterMode((current) => !current)
                    setPendingChallenge(null)
                    setPendingRegisterChallenge(null)
                    setVerificationCode('')
                    setConflictDevice(null)
                    setLoginError(null)
                  }}
                >
                  {registerMode ? '直接登录' : '注册账号'}
                </button>
              </div>

              <div className="space-y-4">
                {!pendingChallenge && !pendingRegisterChallenge ? (
                  <>
                    <div className="form-control">
                      <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                          <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z" />
                        </svg>
                        <input
                          type="text"
                          className="grow"
                          placeholder="账号"
                          autoCapitalize="none"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void (registerMode ? submitRegister() : submitLogin())
                            }
                          }}
                        />
                      </label>
                    </div>

                    <div className="form-control">
                      <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                          <path fillRule="evenodd" d="M14 6a4 4 0 0 1-4.899 3.899l-1.955 1.955a.5.5 0 0 1-.353.146H5v1.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2.293a.5.5 0 0 1 .146-.353l3.955-3.955A4 4 0 1 1 14 6Zm-4-2a.75.75 0 0 0 0 1.5.5.5 0 0 1 .5.5.75.75 0 0 0 1.5 0 2 2 0 0 0-2-2Z" clipRule="evenodd" />
                        </svg>
                        <input
                          type="password"
                          className="grow"
                          placeholder="密码"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void (registerMode ? submitRegister() : submitLogin())
                            }
                          }}
                        />
                      </label>
                    </div>

                    {!registerMode ? (
                      <label className="label cursor-pointer justify-start gap-3 py-0">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-primary checkbox-sm"
                          checked={trustDevice}
                          onChange={(event) => setTrustDevice(event.target.checked)}
                        />
                        <span className="label-text text-sm text-base-content/70">信任本机 7 天</span>
                      </label>
                    ) : null}
                  </>
                ) : pendingChallenge ? (
                  <>
                    <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-base-content/80">
                      新设备登录，验证码已发送到 <span className="font-semibold">{pendingChallenge.maskedEmail}</span>
                      {pendingChallenge.debugCode ? (
                        <div className="mt-2 text-xs text-primary">本地调试验证码：{pendingChallenge.debugCode}</div>
                      ) : null}
                    </div>
                    <div className="form-control">
                      <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                          <path d="M15 4.5A3.5 3.5 0 0 0 11.5 1h-7A3.5 3.5 0 0 0 1 4.5v7A3.5 3.5 0 0 0 4.5 15h7a3.5 3.5 0 0 0 3.5-3.5v-7ZM4 5.75A.75.75 0 0 1 4.75 5h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 5.75Zm0 4a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5A.75.75 0 0 1 4 9.75Z" />
                        </svg>
                        <input
                          type="text"
                          className="grow"
                          placeholder="邮箱验证码"
                          value={verificationCode}
                          onChange={(event) => setVerificationCode(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void submitVerification(false)
                            }
                          }}
                        />
                      </label>
                    </div>
                    <label className="label cursor-pointer justify-start gap-3 py-0">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm"
                        checked={trustDevice}
                        onChange={(event) => setTrustDevice(event.target.checked)}
                      />
                      <span className="label-text text-sm text-base-content/70">验证后信任本机 7 天</span>
                    </label>
                    {conflictDevice ? (
                      <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-base-content/80">
                        当前在线设备：{conflictDevice.deviceName || '未知设备'}
                        {conflictDevice.platform ? ` · ${conflictDevice.platform}` : ''}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-base-content/80">
                      注册验证码已发送到 <span className="font-semibold">{pendingRegisterChallenge?.maskedEmail}</span>
                      {pendingRegisterChallenge?.debugCode ? (
                        <div className="mt-2 text-xs text-primary">本地调试验证码：{pendingRegisterChallenge.debugCode}</div>
                      ) : null}
                    </div>
                    <div className="form-control">
                      <label className="input input-bordered flex items-center gap-3 w-full focus-within:outline-none focus-within:border-primary transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 opacity-70">
                          <path d="M15 4.5A3.5 3.5 0 0 0 11.5 1h-7A3.5 3.5 0 0 0 1 4.5v7A3.5 3.5 0 0 0 4.5 15h7a3.5 3.5 0 0 0 3.5-3.5v-7ZM4 5.75A.75.75 0 0 1 4.75 5h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 5.75Zm0 4a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5A.75.75 0 0 1 4 9.75Z" />
                        </svg>
                        <input
                          type="text"
                          className="grow"
                          placeholder="注册验证码"
                          value={verificationCode}
                          onChange={(event) => setVerificationCode(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void submitRegisterVerification()
                            }
                          }}
                        />
                      </label>
                    </div>
                  </>
                )}

                {loginError && (
                  <div className="alert alert-error mt-4 py-2 text-sm rounded-lg">
                    <span>{loginError}</span>
                  </div>
                )}

                <div className="form-control mt-6">
                  <button
                    className="btn btn-primary w-full text-base"
                    disabled={pendingAction !== null}
                    onClick={() =>
                      void (
                        pendingChallenge
                          ? submitVerification(false)
                          : pendingRegisterChallenge
                            ? submitRegisterVerification()
                            : registerMode
                              ? submitRegister()
                              : submitLogin()
                      )
                    }
                  >
                    {pendingAction !== null ? <span className="loading loading-spinner loading-sm"></span> : null}
                    {pendingChallenge ? '验证并登录' : pendingRegisterChallenge ? '验证并创建账号' : registerMode ? '创建账号' : '立即登录'}
                  </button>
                  {pendingChallenge || pendingRegisterChallenge ? (
                    <div className="mt-3 flex gap-3">
                      <button
                        className="btn btn-outline flex-1"
                        disabled={pendingAction !== null}
                        onClick={() => {
                          setPendingChallenge(null)
                          setPendingRegisterChallenge(null)
                          setVerificationCode('')
                          setConflictDevice(null)
                          setLoginError(null)
                        }}
                      >
                        返回
                      </button>
                      {pendingChallenge && conflictDevice ? (
                        <button
                          className="btn btn-error flex-1"
                          disabled={pendingAction !== null}
                          onClick={() => void submitVerification(true)}
                        >
                          踢掉在线设备
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-base-200">
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.zip,application/json,application/zip"
        multiple
        className="hidden"
        onChange={(event) => void handleImportSelection(event)}
      />
      {isFullAdminSurface ? (
        <div className="navbar h-16 border-b border-base-300 bg-base-100 px-6 shadow-sm">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <div 
                className="flex items-center gap-2 text-2xl font-black tracking-tight cursor-pointer select-none hover:opacity-80 transition-opacity"
                onClick={() => {
                  const currentIndex = THEMES.indexOf(theme)
                  const nextIndex = (currentIndex + 1) % THEMES.length
                  setTheme(THEMES[nextIndex])
                }}
                title="点击切换主题"
              >
                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-content shadow-sm">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </div>
                CPM 管理入口
              </div>
              {canUseDeveloperSwitch ? (
                <div className="join join-horizontal">
                  <button
                    className={`join-item btn btn-xs ${developerSurfaceMode === 'user' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setDeveloperSurfaceMode('user')}
                  >
                    User
                  </button>
                  <button
                    className={`join-item btn btn-xs ${developerSurfaceMode === 'spadmin' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setDeveloperSurfaceMode('spadmin')}
                  >
                    SpAdmin
                  </button>
                  <button
                    className={`join-item btn btn-xs ${developerSurfaceMode === 'admin' ? 'btn-warning' : 'btn-outline btn-warning'}`}
                    onClick={() => setDeveloperSurfaceMode('admin')}
                  >
                    Admin
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex-none flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 rounded-full border border-base-300 bg-base-200 px-3 py-1.5 text-xs font-mono text-base-content/60 shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
              cli v{appState?.appVersion ?? '0.1.0'}
            </div>
            <div className="flex items-center gap-3 border-base-300 pl-2 sm:border-l sm:pl-4">
              <button
                className="btn btn-outline btn-sm"
                disabled={checkingUpdate}
                onClick={() => void checkForUpdates(false)}
              >
                {checkingUpdate ? <span className="loading loading-spinner loading-xs"></span> : null}
                检查更新
              </button>
              <div className="hidden text-right sm:block">
                <div className="text-sm font-bold leading-none">{session.user.email}</div>
                <div className="mt-1.5 text-[11px] font-medium tracking-wide text-base-content/55">
                  {sessionPlanLabel}
                </div>
              </div>
              <div className="avatar placeholder">
                <div className="w-10 rounded-full bg-neutral text-neutral-content">
                  <span className="text-lg">{userDisplayName.slice(0, 1).toUpperCase()}</span>
                </div>
              </div>
              <button
                className="ml-2 text-base-content/60 transition-colors hover:text-primary"
                onClick={() => passwordDialogRef.current?.showModal()}
                title="修改密码"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button
                className="ml-2 text-base-content/60 transition-colors hover:text-error"
                onClick={logout}
                title="退出登录"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full flex justify-between items-center pt-2 px-4" >
          <div 
            className="flex items-center gap-2 font-bold text-sm cursor-pointer select-none hover:opacity-80 transition-opacity" 
            onClick={() => {
              const currentIndex = THEMES.indexOf(theme)
              const nextIndex = (currentIndex + 1) % THEMES.length
              setTheme(THEMES[nextIndex])
            }}
            title="点击切换主题"
          >
            <div className="w-4 h-4 rounded-md bg-primary flex items-center justify-center text-primary-content shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </div>
            CPSwitch
          </div>
          <div className="flex items-center gap-1">
            {canUseDeveloperSwitch ? (
              <div className="join join-horizontal">
                <button
                  className={`join-item btn btn-xs ${developerSurfaceMode === 'user' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setDeveloperSurfaceMode('user')}
                >
                  User
                </button>
                <button
                  className={`join-item btn btn-xs ${developerSurfaceMode === 'spadmin' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setDeveloperSurfaceMode('spadmin')}
                >
                  SpAdmin
                </button>
                <button
                  className={`join-item btn btn-xs ${developerSurfaceMode === 'admin' ? 'btn-warning' : 'btn-outline btn-warning'}`}
                  onClick={() => setDeveloperSurfaceMode('admin')}
                >
                  Admin
                </button>
              </div>
            ) : null}
            <button
              className="btn btn-ghost btn-sm btn-square"
              disabled={checkingUpdate}
              onClick={() => void checkForUpdates(false)}
              title="检查更新"
            >
                {checkingUpdate ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/><path d="M12 7v5l3 3"/></svg>
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm btn-square"
                onClick={() => passwordDialogRef.current?.showModal()}
                title="修改密码"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button
              className="btn btn-ghost btn-sm btn-square text-error"
              onClick={logout}
              title="退出登录"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
            </button>
          </div>
        </div>
      )}

      <dialog ref={updateDialogRef} className="modal">
        <div className="modal-box max-w-xl">
          <h3 className="text-xl font-bold">版本更新</h3>
          <div className="mt-4 space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-box bg-base-200 px-4 py-3">
                <div className="text-xs text-base-content/60">当前版本</div>
                <div className="mt-1 font-mono font-semibold">{updateInfo?.currentVersion ?? '-'}</div>
              </div>
              <div className="rounded-box bg-base-200 px-4 py-3">
                <div className="text-xs text-base-content/60">最新版本</div>
                <div className="mt-1 font-mono font-semibold">{updateInfo?.latestVersion ?? '-'}</div>
              </div>
            </div>
            {updateInfo?.notes ? (
              <div className="rounded-box border border-base-300 bg-base-100 px-4 py-3 whitespace-pre-wrap">
                {updateInfo.notes}
              </div>
            ) : null}
            {!updateInfo?.hasUpdate ? (
              <div className="alert alert-success">
                <span>当前已是最新版本。</span>
              </div>
            ) : (
              <div className="alert alert-info">
                <span>
                  {downloadedUpdate
                    ? '更新包已下载完成，点击重启更新会打开安装包并退出当前应用。'
                    : '检测到新版本，确认后会在应用内下载安装包。'}
                </span>
              </div>
            )}
            {updateInfo?.hasUpdate ? (
              <div className="rounded-box border border-base-300 bg-base-100 px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-base-content/60">
                  <span>{downloadedUpdate ? downloadedUpdate.fileName : downloadingUpdate ? '正在下载更新包' : '等待确认更新'}</span>
                  <span>{Math.round(updateDownloadProgress)}%</span>
                </div>
                <progress className="progress progress-primary w-full" value={updateDownloadProgress} max={100}></progress>
              </div>
            ) : null}
          </div>
          <div className="modal-action">
            <button className="btn" disabled={downloadingUpdate || installingUpdate} onClick={() => updateDialogRef.current?.close()}>
              关闭
            </button>
            {downloadedUpdate ? (
              <button
                className="btn btn-primary"
                disabled={installingUpdate}
                onClick={() => void installDownloadedUpdate()}
              >
                {installingUpdate ? <span className="loading loading-spinner loading-xs"></span> : null}
                重启更新
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={!updateInfo?.hasUpdate || !updateInfo.downloadUrl || downloadingUpdate}
                onClick={() => void downloadUpdate()}
              >
                {downloadingUpdate ? <span className="loading loading-spinner loading-xs"></span> : null}
                确认更新
              </button>
            )}
          </div>
        </div>
      </dialog>

      {effectiveIsAdmin ? (
        <>
          <div className={isSpAdminSurface ? '' : 'hidden'} aria-hidden={isSpAdminSurface ? undefined : true}>
            <SpAdminPanel
              token={session.token}
              recentLogs={recentLogs}
              pendingAction={pendingAction}
              onRefreshLogs={() =>
                void runAction('refresh-logs', async () => {
                  const logs = await cpaRuntime.getRecentLogs()
                  setRecentLogs(logs || '当前还没有日志。')
                }, '日志刷新成功')
              }
              onNotify={showToast}
              onError={handleLoadError}
            />
          </div>
          {!isSpAdminSurface ? (
            <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4">
          <div role="tablist" className="tabs tabs-lift">
            <button
              role="tab"
              className={`tab ${adminTab === 'overview' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('overview')}
            >
              概览
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'oauth' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('oauth')}
            >
              OAuth
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'auth-files' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('auth-files')}
            >
              认证文件
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'quota' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('quota')}
            >
              配额
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'openai-providers' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('openai-providers')}
            >
              OpenAI兼容
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'cloud-admin' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('cloud-admin')}
            >
              后台管理
            </button>
            <button
              role="tab"
              className={`tab ${adminTab === 'cpm' ? 'tab-active' : ''}`}
              onClick={() => setAdminTab('cpm')}
            >
              CPM
            </button>
          </div>

          <div className="flex flex-col gap-4 bg-base-100 p-4 rounded-box shadow-sm mt-1">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="badge badge-primary badge-outline badge-lg px-4">
                  {adminTab === 'overview'
                    ? '桌面宿主概览'
                    : adminTab === 'oauth'
                      ? 'OAuth 授权'
                      : adminTab === 'auth-files'
                        ? '认证文件'
                      : adminTab === 'quota'
                        ? '配额管理'
                        : adminTab === 'openai-providers'
                          ? 'OpenAI 兼容提供商'
                        : adminTab === 'cloud-admin'
                          ? '云用户与共享池'
                        : '原始 CPM 管理页'}
                </div>
                <div className={`badge badge-lg px-4 ${statusTone}`}>
                  {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">端口</div>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    className="join-item input input-bordered input-sm w-20 px-2 font-mono text-center"
                    value={settings.apiPort}
                    onChange={(event) => {
                      setSettings((current) => ({
                        ...current,
                        apiPort: Number(event.target.value || 0)
                      }))
                    }}
                  />
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void savePort()}>
                    保存
                  </button>
                </div>

                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">密钥</div>
                  <input
                    type="text"
                    readOnly
                    className="join-item input input-bordered input-sm w-24 sm:w-32 px-2 font-mono text-xs opacity-60"
                    value={managementInfo?.managementKey ?? '等待生成...'}
                  />
                  <button
                    className="join-item btn btn-outline btn-sm font-normal"
                    disabled={!managementInfo?.managementKey}
                    onClick={() => void navigator.clipboard.writeText(managementInfo?.managementKey ?? '')}
                  >
                    复制
                  </button>
                </div>

                <div className="join shadow-sm">
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('start', () => cpaRuntime.start())}>启动</button>
                  <button className="join-item btn btn-secondary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('restart', () => cpaRuntime.restart())}>重启</button>
                  <button className="join-item btn btn-warning btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('stop', () => cpaRuntime.stop())}>停止</button>
                </div>

                <button
                  className="btn btn-outline btn-sm font-normal"
                  disabled={pendingAction !== null || cpaState?.status !== 'running'}
                  onClick={() => importInputRef.current?.click()}
                >
                  {pendingAction === 'import-auth-files' && <span className="loading loading-spinner loading-xs"></span>}
                  批量导入认证
                </button>

                <button
                  className="btn btn-outline btn-sm font-normal"
                  disabled={pendingAction !== null}
                  onClick={() => void handleExportAuthFiles()}
                >
                  {pendingAction === 'export-auth-files' && <span className="loading loading-spinner loading-xs"></span>}
                  批量导出认证
                </button>

                <button className="btn btn-outline btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('refresh', refresh)}>刷新状态</button>
              </div>
            </div>
          </div>

          {cpaState?.lastError ? (
            <div className="alert alert-error mt-4">
              <span>最近一次运行错误：{cpaState.lastError}</span>
            </div>
          ) : null}

          {loadError ? (
            <div className="alert alert-error mt-4">
              <span>界面错误：{loadError}</span>
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">账号</div>
                <div className="stat-value text-lg">{session.user.email}</div>
                <div className="stat-desc">{session.user.role}</div>
              </div>
            </div>
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">套餐</div>
                <div className="stat-value text-secondary text-lg">{sessionPlanLabel}</div>
                <div className="stat-desc">{session.plan.planCode}</div>
              </div>
            </div>
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">自动切换</div>
                <div className="stat-value text-lg">{session.features.allow_auto_rotation ? '开启' : '关闭'}</div>
                <div className="stat-desc">个人云：{session.features.allow_personal_cloud_sync ? '可用' : '禁用'}</div>
              </div>
            </div>
            <div className="stats border border-base-300 bg-base-100 shadow-sm">
              <div className="stat">
                <div className="stat-title">共享池</div>
                <div className="stat-value text-lg">{session.features.allow_shared_pool ? '可用' : '不可用'}</div>
                <div className="stat-desc">最大设备：{session.features.max_devices}</div>
              </div>
            </div>
          </div>

          {adminTab === 'overview' ? (
            <div className="flex flex-col gap-6 mt-4">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">管理密钥</div>
                    <div className="text-sm text-base-content/50">配置面板</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">AI 提供商</div>
                    <div className="text-sm text-base-content/50">G:0 C:0 Cl:0 O:0</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m11.5 15.5 3-3"/><path d="m5.5 9.5 3-3"/><path d="m15.5 11.5 3-3"/><path d="m9.5 5.5 3-3"/><path d="M21.16 3.84a2 2 0 0 0-2.83 0l-5.3 5.3a2 2 0 0 0-.58 1.41V14a2 2 0 0 1-2 2H7a2 2 0 0 0-1.41.59l-5.3 5.3a2 2 0 1 0 2.83 2.82l5.3-5.3A2 2 0 0 0 9 17v-3.5a2 2 0 0 1 2-2h3.5a2 2 0 0 0 1.41-.59l5.3-5.3a2 2 0 0 0 0-2.82Z"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">16</h2>
                    <div className="text-base font-medium mt-1">可用模型</div>
                    <div className="text-sm text-base-content/50">所有提供商的模型总数</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">2</h2>
                    <div className="text-base font-medium mt-1">认证文件</div>
                    <div className="text-sm text-base-content/50">OAuth 凭证</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4 lg:flex-row">
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">代理地址 (Proxy URL)</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-80" value={`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`} />
                      <button className="join-item btn btn-outline font-normal" onClick={() => { void navigator.clipboard.writeText(`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`); setToastMessage('代理地址已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">外部 API KEY</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-60" value={managementInfo?.managementKey ?? '等待生成...'} />
                      <button className="join-item btn btn-outline font-normal" disabled={!managementInfo?.managementKey} onClick={() => { void navigator.clipboard.writeText(managementInfo?.managementKey ?? ''); setToastMessage('API KEY 已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card bg-base-100 shadow-sm border border-base-200">
                <div className="card-body gap-4">
                  <div className="space-y-2 flex justify-between items-center">
                    <div>
                      <h3 className="card-title text-base">最近日志</h3>
                      <p className="text-sm text-base-content/60">
                        实时查看当前 CPA 守护进程的标准与错误输出
                      </p>
                    </div>
                    <button
                      className="btn btn-outline btn-sm font-normal"
                      disabled={pendingAction !== null}
                      onClick={() =>
                        void runAction('refresh-logs', async () => {
                          const logs = await cpaRuntime.getRecentLogs()
                          setRecentLogs(logs || '当前还没有日志。')
                        }, '日志刷新成功')
                      }
                    >
                      {pendingAction === 'refresh-logs' && <span className="loading loading-spinner loading-xs"></span>}
                      刷新日志
                    </button>
                  </div>

                  <div className="mockup-code w-full h-[28rem] overflow-auto shadow-inner bg-base-300/50 text-base-content/80 text-xs sm:text-sm leading-relaxed">
                    {(!recentLogs || recentLogs === '当前还没有日志。' || recentLogs === '等待运行日志...') ? (
                      <pre data-prefix=">"><code>{recentLogs || '等待运行日志...'}</code></pre>
                    ) : (
                      recentLogs.split('\n').map((line, idx) => {
                        let tagClass = 'whitespace-pre-wrap break-all '
                        const lowerLine = line.toLowerCase()
                        if (lowerLine.includes('error') || lowerLine.includes('fail') || lowerLine.includes('crit')) {
                          tagClass += 'text-error font-bold'
                        } else if (lowerLine.includes('warn')) {
                          tagClass += 'text-warning font-semibold'
                        } else if (lowerLine.includes('info') || lowerLine.includes('success')) {
                          tagClass += 'text-info'
                        } else {
                          tagClass += 'opacity-80'
                        }
                        return (
                          <pre key={idx} data-prefix={idx + 1} className={tagClass}>
                            <code>{line || ' '}</code>
                          </pre>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : adminTab === 'oauth' ? (
            <OAuthPanel
              canManage={true}
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : adminTab === 'auth-files' ? (
            <AuthFilesPanel
              cpaRunning={cpaState?.status === 'running'}
              pendingAction={pendingAction}
              planCode={session.plan.planCode}
              cloudToken={session.token}
              maxEnabledAuthFiles={session.features.max_enabled_auth_files}
              allowAutoRotation={session.features.allow_auto_rotation}
              allowPersonalCloudSync={session.features.allow_personal_cloud_sync}
              allowSharedPool={session.features.allow_shared_pool}
              onNotify={showToast}
              onError={handleLoadError}
              onImportClick={() => importInputRef.current?.click()}
              onExportClick={() => void handleExportAuthFiles()}
              onOpenConfigDir={() => void cpaRuntime.openConfigDir()}
            />
          ) : adminTab === 'quota' ? (
            <QuotaPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : adminTab === 'openai-providers' ? (
            <OpenAIProvidersPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : adminTab === 'cloud-admin' ? (
            <CloudAdminPanel
              token={session.token}
              onNotify={showToast}
              onError={handleLoadError}
            />
          ) : (
            <div className="mt-4">
              {cpaState?.status !== 'running' ? (
                <div className="hero rounded-box bg-base-100 shadow-xl">
                  <div className="hero-content py-16 text-center">
                    <div className="max-w-2xl">
                      <h2 className="text-3xl font-black">先启动 CPA，才能进入原始 CPM 管理页</h2>
                      <p className="py-4 text-base-content/65">
                        当前 `CPA` 还没有处于运行中，所以先启动服务，再加载 `management.html`。
                      </p>
                      <button
                        className="btn btn-primary"
                        disabled={pendingAction !== null}
                        onClick={() => void runAction('start', () => cpaRuntime.start())}
                      >
                        立即启动 CPA
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="card bg-base-100 shadow-xl">
                  <div className="card-body p-2">
                    <iframe
                      ref={cpmFrameRef}
                      key={cpmUrl}
                      src={cpmUrl}
                      title="CPM 管理页面"
                      className="h-[calc(100vh-17rem)] w-full rounded-box border border-base-300 bg-base-100"
                    />
                  </div>
                </div>
              )}
            </div>
            )}
            </main>
          ) : null}
        </>
      ) : useNewUserWorkspace ? (
        <UserWorkspace
          plan={session.plan}
          features={session.features}
          planExpiresAt={session.expiresAt ?? null}
          userKey={session.user.email}
          isAdminAccount={actualIsAdmin}
          cloudToken={session.token}
          cpaState={cpaState}
          loadError={loadError}
          pendingAction={pendingAction}
          normalizingFreeTier={normalizingFreeTier}
          onRefreshSession={refreshSessionFromCloud}
          onStart={() => runAction('start', () => cpaRuntime.start(), '启动指令已发送')}
          onRestart={() => runAction('restart', () => cpaRuntime.restart(), '重启指令已发送')}
          onStop={() => runAction('stop', () => cpaRuntime.stop(), '停止指令已发送')}
          onRefresh={() => runAction('refresh', refresh, '状态刷新完毕')}
          onNotify={showToast}
          onError={handleLoadError}
        />
      ) : (
        <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4">
          <div role="tablist" className="tabs tabs-lift">
            <button
              role="tab"
              className={`tab ${userTab === 'overview' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('overview')}
            >
              概览
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'oauth' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('oauth')}
            >
              OAuth 登录
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'auth-files' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('auth-files')}
            >
              认证文件
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'providers' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('providers')}
            >
              AI 提供商
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'quota' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('quota')}
            >
              配额管理
            </button>
            <button
              role="tab"
              className={`tab ${userTab === 'stats' ? 'tab-active' : ''}`}
              onClick={() => setUserTab('stats')}
            >
              使用统计
            </button>
          </div>

          {/* Top Control Bar is shared across roles! */}
          <div className="flex flex-col gap-4 bg-base-100 p-4 rounded-box shadow-sm mt-1">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="badge badge-primary badge-outline badge-lg px-4">
                  {userTab === 'overview' ? '普通系统概览' : '用户模块'}
                </div>
                <div className={`badge badge-lg px-4 ${statusTone}`}>
                  {statusLabelMap[cpaState?.status ?? 'stopped'] ?? '未知'}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">端口</div>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    className="join-item input input-bordered input-sm w-20 px-2 font-mono text-center"
                    value={settings.apiPort}
                    onChange={(event) => {
                      setSettings((current) => ({
                        ...current,
                        apiPort: Number(event.target.value || 0)
                      }))
                    }}
                  />
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void savePort()}>
                    保存
                  </button>
                </div>

                <div className="join shadow-sm lg:mr-2">
                  <div className="join-item flex items-center bg-base-200 px-3 text-sm border border-base-300">密钥</div>
                  <input
                    type="text"
                    readOnly
                    className="join-item input input-bordered input-sm w-24 sm:w-32 px-2 font-mono text-xs opacity-60"
                    value={managementInfo?.managementKey ?? '等待生成...'}
                  />
                  <button
                    className="join-item btn btn-outline btn-sm font-normal"
                    disabled={!managementInfo?.managementKey}
                    onClick={() => { void navigator.clipboard.writeText(managementInfo?.managementKey ?? ''); setToastMessage('密钥已复制'); setTimeout(() => setToastMessage(null), 2000) }}
                  >
                    复制
                  </button>
                </div>

                <div className="join shadow-sm">
                  <button className="join-item btn btn-primary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('start', () => cpaRuntime.start(), '启动指令已发送')}>启动</button>
                  <button className="join-item btn btn-secondary btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('restart', () => cpaRuntime.restart(), '重启指令已发送')}>重启</button>
                  <button className="join-item btn btn-warning btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('stop', () => cpaRuntime.stop(), '停止指令已发送')}>停止</button>
                </div>

                <button className="btn btn-outline btn-sm font-normal" disabled={pendingAction !== null} onClick={() => void runAction('refresh', refresh, '状态刷新完毕')}>
                  {pendingAction === 'refresh' && <span className="loading loading-spinner loading-xs"></span>}
                  刷新状态
                </button>
              </div>
            </div>
          </div>

          {cpaState?.lastError ? (
            <div className="alert alert-error mt-4">
              <span>最近一次运行错误：{cpaState.lastError}</span>
            </div>
          ) : null}

          {loadError ? (
            <div className="alert alert-error mt-4">
              <span>界面错误：{loadError}</span>
            </div>
          ) : null}

          {userTab === 'overview' && (
            <div className="flex flex-col gap-6 mt-4">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">账号</div>
                    <div className="stat-value text-lg">{session.user.email}</div>
                    <div className="stat-desc">设备：{cloudClient.getDeviceId(session.user.email).slice(0, 8)}</div>
                  </div>
                </div>

                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">套餐</div>
                    <div className="stat-value text-primary">{sessionPlanLabel}</div>
                    <div className="stat-desc">{session.plan.planCode}</div>
                  </div>
                </div>

                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">最大启用认证</div>
                    <div className="stat-value text-secondary">
                      {session.features.max_enabled_auth_files >= 999 ? '∞' : session.features.max_enabled_auth_files}
                    </div>
                    <div className="stat-desc">免费版登录后默认禁用全部</div>
                  </div>
                </div>

                <div className="stats border border-base-300 bg-base-100 shadow-sm">
                  <div className="stat">
                    <div className="stat-title">云能力</div>
                    <div className="stat-value text-lg">{session.features.allow_personal_cloud_sync ? '个人云' : '本地'}</div>
                    <div className="stat-desc">共享池：{session.features.allow_shared_pool ? '可用' : '不可用'}</div>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">管理密钥</div>
                    <div className="text-sm text-base-content/50">配置面板</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">0</h2>
                    <div className="text-base font-medium mt-1">AI 提供商</div>
                    <div className="text-sm text-base-content/50">G:0 C:0 Cl:0 O:0</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m11.5 15.5 3-3"/><path d="m5.5 9.5 3-3"/><path d="m15.5 11.5 3-3"/><path d="m9.5 5.5 3-3"/><path d="M21.16 3.84a2 2 0 0 0-2.83 0l-5.3 5.3a2 2 0 0 0-.58 1.41V14a2 2 0 0 1-2 2H7a2 2 0 0 0-1.41.59l-5.3 5.3a2 2 0 1 0 2.83 2.82l5.3-5.3A2 2 0 0 0 9 17v-3.5a2 2 0 0 1 2-2h3.5a2 2 0 0 0 1.41-.59l5.3-5.3a2 2 0 0 0 0-2.82Z"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">16</h2>
                    <div className="text-base font-medium mt-1">可用模型</div>
                    <div className="text-sm text-base-content/50">所有提供商的模型总数</div>
                  </div>
                </div>

                <div className="card bg-base-100 shadow-sm border border-base-200">
                  <div className="card-body p-6">
                    <div className="w-12 h-12 rounded-xl bg-base-200 flex items-center justify-center text-base-content/60 mb-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
                    </div>
                    <h2 className="card-title text-4xl font-black mt-2">2</h2>
                    <div className="text-base font-medium mt-1">认证文件</div>
                    <div className="text-sm text-base-content/50">OAuth 凭证</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4 lg:flex-row">
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">代理地址 (Proxy URL)</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-80" value={`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`} />
                      <button className="join-item btn btn-outline font-normal" onClick={() => { void navigator.clipboard.writeText(`http://127.0.0.1:${cpaState?.apiPort ?? settings.apiPort ?? 8317}/v1`); setToastMessage('代理地址已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
                <div className="card bg-base-100 shadow-sm flex-1 border border-base-200">
                  <div className="card-body p-5">
                    <div className="text-sm font-medium text-base-content/70 mb-2">外部 API KEY</div>
                    <div className="join w-full shadow-sm rounded-md">
                      <input type="text" readOnly className="join-item input input-bordered w-full font-mono text-sm opacity-60" value={managementInfo?.managementKey ?? '等待生成...'} />
                      <button className="join-item btn btn-outline font-normal" disabled={!managementInfo?.managementKey} onClick={() => { void navigator.clipboard.writeText(managementInfo?.managementKey ?? ''); setToastMessage('API KEY 已复制'); setTimeout(() => setToastMessage(null), 2000) }}>复制</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card bg-base-100 shadow-sm border border-base-200">
                <div className="card-body gap-4">
                  <div className="space-y-2 flex justify-between items-center">
                    <div>
                      <h3 className="card-title text-base">最近日志</h3>
                      <p className="text-sm text-base-content/60">
                        实时查看当前 CPA 守护进程的标准与错误输出
                      </p>
                    </div>
                    <button
                      className="btn btn-outline btn-sm font-normal"
                      disabled={pendingAction !== null}
                      onClick={() =>
                        void runAction('refresh-logs', async () => {
                          const logs = await cpaRuntime.getRecentLogs()
                          setRecentLogs(logs || '当前还没有日志。')
                        }, '日志刷新成功')
                      }
                    >
                      {pendingAction === 'refresh-logs' && <span className="loading loading-spinner loading-xs"></span>}
                      刷新日志
                    </button>
                  </div>

                  <div className="mockup-code w-full h-[28rem] overflow-auto shadow-inner bg-base-300/50 text-base-content/80 text-xs sm:text-sm leading-relaxed">
                    {(!recentLogs || recentLogs === '当前还没有日志。' || recentLogs === '等待运行日志...') ? (
                      <pre data-prefix=">"><code>{recentLogs || '等待运行日志...'}</code></pre>
                    ) : (
                      recentLogs.split('\n').map((line, idx) => {
                        let tagClass = 'whitespace-pre-wrap break-all '
                        const lowerLine = line.toLowerCase()
                        if (lowerLine.includes('error') || lowerLine.includes('fail') || lowerLine.includes('crit')) {
                          tagClass += 'text-error font-bold'
                        } else if (lowerLine.includes('warn')) {
                          tagClass += 'text-warning font-semibold'
                        } else if (lowerLine.includes('info') || lowerLine.includes('success')) {
                          tagClass += 'text-info'
                        } else {
                          tagClass += 'opacity-80'
                        }
                        return (
                          <pre key={idx} data-prefix={idx + 1} className={tagClass}>
                            <code>{line || ' '}</code>
                          </pre>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {userTab === 'oauth' && (
            <OAuthPanel
              canManage={false}
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          )}

          {userTab === 'providers' && (
            <div className="hero rounded-box bg-base-100 shadow-sm py-28 mt-1 border border-dashed border-base-300">
              <div className="hero-content text-center">
                <div className="max-w-md">
                  <h2 className="text-3xl font-black opacity-40">AI 提供商管理</h2>
                  <p className="py-4 text-base-content/50">模块开发中：汇聚并配置多源或自建的模型端点</p>
                </div>
              </div>
            </div>
          )}

          {userTab === 'auth-files' && (
            <AuthFilesPanel
              cpaRunning={cpaState?.status === 'running'}
              pendingAction={pendingAction}
              planCode={session.plan.planCode}
              cloudToken={session.token}
              maxEnabledAuthFiles={session.features.max_enabled_auth_files}
              allowAutoRotation={session.features.allow_auto_rotation}
              allowPersonalCloudSync={session.features.allow_personal_cloud_sync}
              allowSharedPool={session.features.allow_shared_pool}
              onNotify={showToast}
              onError={handleLoadError}
              onImportClick={() => importInputRef.current?.click()}
              onExportClick={() => void handleExportAuthFiles()}
              onOpenConfigDir={() => void cpaRuntime.openConfigDir()}
            />
          )}

          {userTab === 'quota' && (
            <QuotaPanel
              cpaRunning={cpaState?.status === 'running'}
              onNotify={showToast}
              onError={handleLoadError}
            />
          )}

          {userTab === 'stats' && (
            <div className="hero rounded-box bg-base-100 shadow-sm py-28 mt-1 border border-dashed border-base-300">
              <div className="hero-content text-center">
                <div className="max-w-md">
                  <h2 className="text-3xl font-black opacity-40">使用统计</h2>
                  <p className="py-4 text-base-content/50">模块开发中：聚合呈现分时账单与实时调用流水图表</p>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* GLOBAL TOAST HANDLER */}
      {toastMessage && (
        <div className="toast toast-top toast-center z-[1100]">
          <div className="alert alert-success shadow-lg">
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {errorToastMessage && (
        <div className="toast toast-top toast-center z-[1200] top-3">
          <div className="alert alert-error shadow-2xl">
            <span>{errorToastMessage}</span>
          </div>
        </div>
      )}

      <dialog ref={passwordDialogRef} className="modal">
        <div className="modal-box max-w-lg">
          <div className="space-y-1">
            <h3 className="text-2xl font-black">修改密码</h3>
            <p className="text-sm text-base-content/60">当前账号：{session?.user.email}</p>
          </div>
          <div className="mt-6 space-y-5">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-base-content/70">当前密码</span>
              <input
                type="password"
                className="input input-bordered h-12"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-base-content/70">新密码</span>
              <input
                type="password"
                className="input input-bordered h-12"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
              />
            </label>
          </div>
          <div className="modal-action mt-8">
            <form method="dialog">
              <button className="btn">取消</button>
            </form>
            <button
              className="btn btn-primary"
              disabled={pendingAction === 'change-password'}
              onClick={() => void submitChangePassword()}
            >
              {pendingAction === 'change-password' ? <span className="loading loading-spinner loading-xs"></span> : null}
              保存新密码
            </button>
          </div>
        </div>
      </dialog>

      {normalizingFreeTier ? (
        <div className="toast toast-bottom toast-end z-[90]">
          <div className="alert">
            <span>免费版登录限制同步中：正在禁用本地认证文件</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
