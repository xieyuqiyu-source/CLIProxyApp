import { useEffect, useMemo, useState } from 'react'
import { quotaApi, getApiCallErrorMessage } from './api'
import { authFilesApi } from '../auth-files/api'
import type {
  ApiCallResult,
  AuthFileItem,
  FileQuotaState,
  QuotaMetric,
  QuotaProvider,
  QuotaResult
} from './types'
import { PROVIDER_META, PROVIDER_ORDER } from './providerMeta'

const CLAUDE_USAGE_WINDOW_LABELS: Array<{ key: string; label: string }> = [
  { key: 'five_hour', label: '5 小时' },
  { key: 'seven_day', label: '7 天' },
  { key: 'seven_day_oauth_apps', label: '7 天 OAuth Apps' },
  { key: 'seven_day_opus', label: '7 天 Opus' },
  { key: 'seven_day_sonnet', label: '7 天 Sonnet' },
  { key: 'seven_day_cowork', label: '7 天 Cowork' },
  { key: 'iguana_necktie', label: 'Iguana' }
]

const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
]

const ANTIGRAVITY_GROUPS = [
  {
    label: 'Claude/GPT',
    identifiers: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']
  },
  {
    label: 'Gemini 3 Pro',
    identifiers: ['gemini-3-pro-high', 'gemini-3-pro-low']
  },
  {
    label: 'Gemini 3.1 Pro Series',
    identifiers: ['gemini-3.1-pro-high', 'gemini-3.1-pro-low']
  },
  {
    label: 'Gemini 2.5 Flash',
    identifiers: ['gemini-2.5-flash', 'gemini-2.5-flash-thinking']
  },
  {
    label: 'Gemini 2.5 Flash Lite',
    identifiers: ['gemini-2.5-flash-lite']
  },
  {
    label: 'Gemini 2.5 CU',
    identifiers: ['rev19-uic3-1p']
  },
  {
    label: 'Gemini 3 Flash',
    identifiers: ['gemini-3-flash']
  },
  {
    label: 'gemini-3.1-flash-image',
    identifiers: ['gemini-3.1-flash-image']
  }
]

const GEMINI_BUCKET_GROUPS: Array<{ label: string; modelIds: string[] }> = [
  { label: 'Gemini Flash Lite', modelIds: ['gemini-2.5-flash-lite'] },
  { label: 'Gemini Flash', modelIds: ['gemini-3-flash-preview', 'gemini-2.5-flash'] },
  { label: 'Gemini Pro', modelIds: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'] }
]

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function normalizeStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
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

function normalizeFractionPercent(value: unknown): number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.endsWith('%')) {
      const parsed = Number(trimmed.slice(0, -1))
      return Number.isFinite(parsed) ? parsed : null
    }
  }
  const normalized = normalizeNumberValue(value)
  if (normalized === null) {
    return null
  }
  return normalized <= 1 ? normalized * 100 : normalized
}

function normalizePlanType(value: unknown): string | null {
  const normalized = normalizeStringValue(value)
  return normalized ? normalized.toLowerCase().replace(/[_\s]+/g, '-') : null
}

function formatPercent(value: number | null) {
  if (value === null) {
    return '--'
  }
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`
}

function parsePercentDisplay(value: string) {
  const match = value.trim().match(/^(\d{1,3})%$/)
  if (!match) {
    return null
  }
  const numeric = Number(match[1])
  if (!Number.isFinite(numeric)) {
    return null
  }
  return Math.max(0, Math.min(100, numeric))
}

function getCompactPlanLabel(data: QuotaResult | undefined, provider: QuotaProvider) {
  if (!data) {
    return '--'
  }

  const badge = data.badges?.find(Boolean)
  if (badge) {
    return badge
  }

  const headline = data.headline?.trim()
  if (!headline) {
    return '--'
  }

  const providerLabel = PROVIDER_META[provider].label.toLowerCase()
  const normalizedHeadline = headline.toLowerCase()
  if (normalizedHeadline.startsWith(providerLabel)) {
    const stripped = headline.slice(PROVIDER_META[provider].label.length).trim()
    return stripped || '--'
  }

  return headline
}

function getMetricResetText(hint?: string) {
  if (!hint) {
    return '--'
  }
  return hint.replace(/^重置\s*/u, '').trim() || '--'
}

function isSharedAuthFile(file: AuthFileItem) {
  return file.name.startsWith('共享-')
}

function pickCompactMetrics(metrics: QuotaMetric[], provider: QuotaProvider) {
  if (provider === 'codex') {
    const fiveHour =
      metrics.find((metric) => metric.id === 'five-hour' || metric.id === 'five-hour-window') ?? null
    const oneWeek =
      metrics.find((metric) => metric.id === 'weekly' || metric.id === 'weekly-window') ?? null
    const selected = [fiveHour, oneWeek].filter((metric): metric is QuotaMetric => metric !== null)
    if (selected.length > 0) {
      return selected
    }
  }

  const normalized = metrics.map((metric) => ({
    metric,
    label: metric.label.replace(/\s+/g, '').toLowerCase()
  }))

  const fiveHour =
    normalized.find(({ label }) => label.includes('5小时') || label.includes('fivehour'))?.metric ?? null
  const oneWeek =
    normalized.find(({ label }) => label.includes('1周') || label.includes('7天') || label.includes('1week'))?.metric ?? null

  const selected = [fiveHour, oneWeek].filter((metric): metric is QuotaMetric => metric !== null)
  return selected.length > 0 ? selected : metrics.slice(0, 2)
}

function getCompactMetricLabel(metric: QuotaMetric, provider: QuotaProvider) {
  if (provider === 'codex') {
    if (metric.id === 'five-hour' || metric.id === 'five-hour-window') {
      return '5h'
    }
    if (metric.id === 'weekly' || metric.id === 'weekly-window') {
      return '1week'
    }
  }

  const normalizedLabel = metric.label.replace(/\s+/g, '').toLowerCase()
  return normalizedLabel.includes('5小时') || normalizedLabel.includes('fivehour') ? '5h' : '1week'
}

function formatResetTime(value?: string | null) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function formatUnixSeconds(value: number | null) {
  if (!value || value <= 0) {
    return '-'
  }
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleString(undefined, {
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

function createStatusError(message: string, status?: number) {
  const error = new Error(message) as Error & { status?: number }
  if (status) {
    error.status = status
  }
  return error
}

function resolveAuthProvider(file: AuthFileItem): QuotaProvider | null {
  const raw = String(file.provider ?? file.type ?? '')
    .trim()
    .toLowerCase()
  return PROVIDER_ORDER.includes(raw as QuotaProvider) ? (raw as QuotaProvider) : null
}

function isRuntimeOnlyAuthFile(file: AuthFileItem) {
  const raw = file.runtimeOnly ?? file.runtime_only
  if (typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'string') {
    return raw.trim().toLowerCase() === 'true'
  }
  return false
}

function isDisabledAuthFile(file: AuthFileItem) {
  const raw = file.disabled
  if (typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'number') {
    return raw !== 0
  }
  if (typeof raw === 'string') {
    return raw.trim().toLowerCase() === 'true'
  }
  return false
}

function normalizeAuthIndex(file: AuthFileItem) {
  return normalizeStringValue(file.authIndex ?? file.auth_index) ?? ''
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

function resolveCodexChatgptAccountId(file: AuthFileItem) {
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
    const accountId = normalizeStringValue(payload?.chatgpt_account_id ?? payload?.chatgptAccountId)
    if (accountId) {
      return accountId
    }
  }
  return null
}

function resolveCodexPlanType(file: AuthFileItem) {
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
    const normalized = normalizeStringValue(candidate)
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

function normalizeCodexWindowId(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
      normalizeStringValue(record.limit_name ?? record.limitName) ??
      normalizeStringValue(record.metered_feature ?? record.meteredFeature) ??
      `additional-${index + 1}`
    const idPrefix = normalizeCodexWindowId(limitName) || `additional-${index + 1}`
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

function resolveGeminiCliProjectId(file: AuthFileItem) {
  const metadata =
    file.metadata && typeof file.metadata === 'object' && !Array.isArray(file.metadata)
      ? (file.metadata as Record<string, unknown>)
      : null
  const attributes =
    file.attributes && typeof file.attributes === 'object' && !Array.isArray(file.attributes)
      ? (file.attributes as Record<string, unknown>)
      : null
  const candidates = [file.account, metadata?.account, attributes?.account]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue
    }
    const matches = Array.from(candidate.matchAll(/\(([^()]+)\)/g))
    const projectId = matches[matches.length - 1]?.[1]?.trim()
    if (projectId) {
      return projectId
    }
  }
  return null
}

function parseResponseJson<T = Record<string, unknown>>(result: ApiCallResult<T>) {
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

function ensureSuccess(result: ApiCallResult) {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result))
  }
}

function getStateBadgeClass(state?: FileQuotaState['status']) {
  switch (state) {
    case 'success':
      return 'badge-success'
    case 'error':
      return 'badge-error'
    case 'loading':
      return 'badge-warning'
    default:
      return 'badge-ghost'
  }
}

function getMetricToneClass(tone?: QuotaMetric['tone']) {
  switch (tone) {
    case 'success':
      return 'text-success'
    case 'warning':
      return 'text-warning'
    case 'error':
      return 'text-error'
    case 'info':
      return 'text-info'
    default:
      return 'text-base-content'
  }
}

export interface QuotaPanelProps {
  cpaRunning: boolean
  onNotify: (message: string) => void
  onError: (message: string | null) => void
  refreshToken?: number
  activeProvider?: QuotaProvider | 'all'
  sourceFilter?: 'all' | 'shared' | 'personal'
  onSourceFilterChange?: (value: 'all' | 'shared' | 'personal') => void
  showHeader?: boolean
  compactUserMode?: boolean
  maxEnabledAuthFiles?: number
  allowAutoRotation?: boolean
  onUpgradeVip?: () => void
  onOpenOauth?: () => void
  onProviderCountsChange?: (counts: Partial<Record<QuotaProvider, number>>) => void
}

async function fetchClaudeQuota(file: AuthFileItem): Promise<QuotaResult> {
  const authIndex = normalizeAuthIndex(file)
  if (!authIndex) {
    throw new Error('缺少 authIndex，无法查询 Claude 配额')
  }

  const headers = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'anthropic-beta': 'oauth-2025-04-20'
  }

  const [usageResult, profileResult] = await Promise.allSettled([
    quotaApi.apiCall({
      authIndex,
      method: 'GET',
      url: 'https://api.anthropic.com/api/oauth/usage',
      header: headers
    }),
    quotaApi.apiCall({
      authIndex,
      method: 'GET',
      url: 'https://api.anthropic.com/api/oauth/profile',
      header: headers
    })
  ])

  if (usageResult.status === 'rejected') {
    throw usageResult.reason
  }

  ensureSuccess(usageResult.value)

  const profile =
    profileResult.status === 'fulfilled' &&
    profileResult.value.statusCode >= 200 &&
    profileResult.value.statusCode < 300
      ? parseResponseJson(profileResult.value)
      : null
  const usage = parseResponseJson(usageResult.value)
  const account =
    profile?.account && typeof profile.account === 'object'
      ? (profile.account as Record<string, unknown>)
      : null
  const organization =
    profile?.organization && typeof profile.organization === 'object'
      ? (profile.organization as Record<string, unknown>)
      : null

  const hasClaudeMax = account?.has_claude_max === true || account?.hasClaudeMax === true
  const hasClaudePro = account?.has_claude_pro === true || account?.hasClaudePro === true
  const orgType = normalizeStringValue(organization?.organization_type ?? organization?.organizationType)?.toLowerCase()
  const subscriptionStatus = normalizeStringValue(
    organization?.subscription_status ?? organization?.subscriptionStatus
  )?.toLowerCase()

  let headline = 'Claude OAuth'
  if (hasClaudeMax) {
    headline = 'Claude Max'
  } else if (hasClaudePro) {
    headline = 'Claude Pro'
  } else if (orgType === 'claude_team' && subscriptionStatus === 'active') {
    headline = 'Claude Team'
  }

  const metrics: QuotaMetric[] = CLAUDE_USAGE_WINDOW_LABELS.flatMap(({ key, label }) => {
    const windowValue = usage?.[key]
    if (!windowValue || typeof windowValue !== 'object') {
      return []
    }
    const windowRecord = windowValue as Record<string, unknown>
    const utilization = normalizeFractionPercent(windowRecord.utilization)
    const remaining = utilization === null ? null : 100 - utilization
    return [
      {
        id: key,
        label,
        value: formatPercent(remaining),
        hint: `重置 ${formatResetTime(normalizeStringValue(windowRecord.resets_at))}`
      }
    ]
  })

  const extraUsage =
    usage?.extra_usage && typeof usage.extra_usage === 'object'
      ? (usage.extra_usage as Record<string, unknown>)
      : null
  if (extraUsage && extraUsage.is_enabled === true) {
    const limit = normalizeNumberValue(extraUsage.monthly_limit)
    const used = normalizeNumberValue(extraUsage.used_credits)
    metrics.push({
      id: 'extra-usage',
      label: 'Extra Usage',
      value: limit !== null && used !== null ? `${Math.max(0, limit - used)} credits` : '--',
      hint: `已用 ${used ?? '--'} / ${limit ?? '--'}`
    })
  }

  return {
    provider: 'claude',
    headline,
    summary: normalizeStringValue(account?.email) ?? normalizeStringValue(organization?.name) ?? undefined,
    badges: [
      normalizeStringValue(organization?.rate_limit_tier),
      normalizeStringValue(organization?.subscription_status)
    ].filter(Boolean) as string[],
    metrics
  }
}

async function fetchCodexQuota(file: AuthFileItem): Promise<QuotaResult> {
  const authIndex = normalizeAuthIndex(file)
  if (!authIndex) {
    throw new Error('缺少 authIndex，无法查询 Codex 配额')
  }

  const accountId = resolveCodexChatgptAccountId(file)
  const headers: Record<string, string> = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
  }
  if (accountId) {
    headers['Chatgpt-Account-Id'] = accountId
  }

  const result = await quotaApi.apiCall({
    authIndex,
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header: headers
  })

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode)
  }
  const payload = parseResponseJson(result)
  if (!payload) {
    throw new Error('Codex 配额响应为空')
  }

  const planType = resolveCodexUsagePlanType(payload) ?? normalizePlanType(resolveCodexPlanType(file))
  const metrics = buildCodexQuotaMetrics(payload)

  return {
    provider: 'codex',
    headline: planType ? `Codex ${planType}` : 'Codex',
    summary: accountId ?? undefined,
    badges: planType ? [planType] : [],
    metrics
  }
}

async function fetchGeminiCliQuota(file: AuthFileItem): Promise<QuotaResult> {
  const authIndex = normalizeAuthIndex(file)
  if (!authIndex) {
    throw new Error('缺少 authIndex，无法查询 Gemini CLI 配额')
  }

  const projectId = resolveGeminiCliProjectId(file)
  if (!projectId) {
    throw new Error('当前 Gemini CLI 认证文件缺少 project id')
  }

  const headers = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json'
  }

  const quotaResult = await quotaApi.apiCall({
    authIndex,
    method: 'POST',
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    header: headers,
    data: JSON.stringify({ project: projectId })
  })

  ensureSuccess(quotaResult)

  let codeAssistResult: ApiCallResult | null = null
  try {
    const result = await quotaApi.apiCall({
      authIndex,
      method: 'POST',
      url: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      header: headers,
      data: JSON.stringify({
        cloudaicompanionProject: projectId,
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
          duetProject: projectId
        }
      })
    })
    if (result.statusCode >= 200 && result.statusCode < 300) {
      codeAssistResult = result
    }
  } catch {
    codeAssistResult = null
  }

  const quotaPayload = parseResponseJson(quotaResult)
  const assistPayload = codeAssistResult ? parseResponseJson(codeAssistResult) : null
  const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : []
  const metrics: QuotaMetric[] = []

  GEMINI_BUCKET_GROUPS.forEach((group, index) => {
    const matches = buckets
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as Record<string, unknown>)
      .filter((bucket) => {
        const modelId = normalizeStringValue(bucket.modelId ?? bucket.model_id)
        return modelId ? group.modelIds.includes(modelId.replace(/_vertex$/i, '')) : false
      })

    if (matches.length === 0) {
      return
    }

    let bestRemaining: number | null = null
    let resetTime: string | null = null
    matches.forEach((bucket) => {
      const nextRemaining = normalizeFractionPercent(bucket.remainingFraction ?? bucket.remaining_fraction)
      if (nextRemaining !== null) {
        bestRemaining = bestRemaining === null ? nextRemaining : Math.min(bestRemaining, nextRemaining)
      }
      const nextReset = normalizeStringValue(bucket.resetTime ?? bucket.reset_time)
      if (!resetTime && nextReset) {
        resetTime = nextReset
      }
    })

    metrics.push({
      id: `gemini-group-${index}`,
      label: group.label,
      value: formatPercent(bestRemaining),
      hint: `重置 ${formatResetTime(resetTime)}`
    })
  })

  if (metrics.length === 0) {
    buckets.slice(0, 8).forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        return
      }
      const bucket = item as Record<string, unknown>
      const label = normalizeStringValue(bucket.modelId ?? bucket.model_id) ?? `Bucket ${index + 1}`
      const tokenType = normalizeStringValue(bucket.tokenType ?? bucket.token_type)
      metrics.push({
        id: `bucket-${index}`,
        label: tokenType ? `${label} / ${tokenType}` : label,
        value: formatPercent(normalizeFractionPercent(bucket.remainingFraction ?? bucket.remaining_fraction)),
        hint: `重置 ${formatResetTime(normalizeStringValue(bucket.resetTime ?? bucket.reset_time))}`
      })
    })
  }

  const currentTier =
    assistPayload?.currentTier && typeof assistPayload.currentTier === 'object'
      ? (assistPayload.currentTier as Record<string, unknown>)
      : assistPayload?.current_tier && typeof assistPayload.current_tier === 'object'
        ? (assistPayload.current_tier as Record<string, unknown>)
        : null
  const paidTier =
    assistPayload?.paidTier && typeof assistPayload.paidTier === 'object'
      ? (assistPayload.paidTier as Record<string, unknown>)
      : assistPayload?.paid_tier && typeof assistPayload.paid_tier === 'object'
        ? (assistPayload.paid_tier as Record<string, unknown>)
        : null
  const tier = paidTier ?? currentTier
  const tierId = normalizeStringValue(tier?.id)
  const credits = Array.isArray(tier?.availableCredits)
    ? tier?.availableCredits
    : Array.isArray(tier?.available_credits)
      ? tier?.available_credits
      : []
  const balance = credits
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as Record<string, unknown>)
    .filter((credit) => normalizeStringValue(credit.creditType ?? credit.credit_type) === 'GOOGLE_ONE_AI')
    .reduce((sum, credit) => sum + (normalizeNumberValue(credit.creditAmount ?? credit.credit_amount) ?? 0), 0)

  if (balance > 0) {
    metrics.unshift({
      id: 'credit-balance',
      label: 'Google One Credits',
      value: `${Math.round(balance)}`,
      tone: 'info'
    })
  }

  return {
    provider: 'gemini-cli',
    headline: tierId ? `Gemini CLI ${tierId}` : 'Gemini CLI',
    summary: projectId,
    badges: [tierId].filter(Boolean) as string[],
    metrics
  }
}

async function fetchAntigravityProjectId(file: AuthFileItem) {
  try {
    const payload = await quotaApi.downloadAuthFile(file.name)
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>
      const installed =
        record.installed && typeof record.installed === 'object'
          ? (record.installed as Record<string, unknown>)
          : null
      const web =
        record.web && typeof record.web === 'object' ? (record.web as Record<string, unknown>) : null
      return (
        normalizeStringValue(record.project_id ?? record.projectId) ??
        normalizeStringValue(installed?.project_id ?? installed?.projectId) ??
        normalizeStringValue(web?.project_id ?? web?.projectId) ??
        'bamboo-precept-lgxtn'
      )
    }
  } catch {
    return 'bamboo-precept-lgxtn'
  }
  return 'bamboo-precept-lgxtn'
}

async function fetchAntigravityQuota(file: AuthFileItem): Promise<QuotaResult> {
  const authIndex = normalizeAuthIndex(file)
  if (!authIndex) {
    throw new Error('缺少 authIndex，无法查询 Antigravity 配额')
  }

  const projectId = await fetchAntigravityProjectId(file)
  let successfulResult: ApiCallResult | null = null
  let lastError = ''
  let lastStatus: number | undefined
  let priorityStatus: number | undefined

  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const result = await quotaApi.apiCall({
        authIndex,
        method: 'POST',
        url,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.11.5 windows/amd64'
        },
        data: JSON.stringify({ project: projectId })
      })
      if (result.statusCode >= 200 && result.statusCode < 300) {
        successfulResult = result
        break
      }
      lastError = getApiCallErrorMessage(result)
      lastStatus = result.statusCode
      if (result.statusCode === 403 || result.statusCode === 404) {
        priorityStatus ??= result.statusCode
      }
    } catch (error) {
      lastError = getErrorMessage(error)
    }
  }

  if (!successfulResult) {
    throw createStatusError(lastError || 'Antigravity 配额接口未返回成功结果', priorityStatus ?? lastStatus)
  }

  const payload = parseResponseJson(successfulResult)
  const models =
    payload?.models && typeof payload.models === 'object'
      ? (payload.models as Record<string, unknown>)
      : null
  if (!models) {
    throw new Error('Antigravity 模型配额为空')
  }

  const metrics: QuotaMetric[] = []
  ANTIGRAVITY_GROUPS.forEach((group, index) => {
    const matched = group.identifiers
      .map((identifier) => [identifier, models[identifier]] as const)
      .filter((entry) => entry[1] && typeof entry[1] === 'object')

    if (matched.length === 0) {
      return
    }

    let remaining: number | null = null
    let resetTime: string | null = null
    matched.forEach(([, entry]) => {
      const record = entry as Record<string, unknown>
      const quotaInfo =
        record.quotaInfo && typeof record.quotaInfo === 'object'
          ? (record.quotaInfo as Record<string, unknown>)
          : record.quota_info && typeof record.quota_info === 'object'
            ? (record.quota_info as Record<string, unknown>)
            : null
      if (!quotaInfo) {
        return
      }
      const nextRemaining = normalizeFractionPercent(
        quotaInfo.remainingFraction ?? quotaInfo.remaining_fraction ?? quotaInfo.remaining
      )
      if (nextRemaining !== null) {
        remaining = remaining === null ? nextRemaining : Math.min(remaining, nextRemaining)
      }
      const nextReset = normalizeStringValue(quotaInfo.resetTime ?? quotaInfo.reset_time)
      if (!resetTime && nextReset) {
        resetTime = nextReset
      }
    })

    metrics.push({
      id: `ag-${index}`,
      label: group.label,
      value: formatPercent(remaining),
      hint: `重置 ${formatResetTime(resetTime)}`
    })
  })

  return {
    provider: 'antigravity',
    headline: 'Antigravity',
    summary: projectId,
    metrics
  }
}

function formatKimiResetHint(value: Record<string, unknown>) {
  const absolute = normalizeStringValue(value.reset_at ?? value.resetAt ?? value.reset_time ?? value.resetTime)
  if (absolute) {
    return formatResetTime(absolute)
  }
  const seconds = normalizeNumberValue(value.reset_in ?? value.resetIn ?? value.ttl)
  if (seconds && seconds > 0) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0 && minutes > 0) {
      return `${hours}h ${minutes}m`
    }
    if (hours > 0) {
      return `${hours}h`
    }
    if (minutes > 0) {
      return `${minutes}m`
    }
    return '<1m'
  }
  return '-'
}

async function fetchKimiQuota(file: AuthFileItem): Promise<QuotaResult> {
  const authIndex = normalizeAuthIndex(file)
  if (!authIndex) {
    throw new Error('缺少 authIndex，无法查询 Kimi 配额')
  }

  const result = await quotaApi.apiCall({
    authIndex,
    method: 'GET',
    url: 'https://api.kimi.com/coding/v1/usages',
    header: {
      Authorization: 'Bearer $TOKEN$'
    }
  })

  ensureSuccess(result)
  const payload = parseResponseJson(result)
  if (!payload) {
    throw new Error('Kimi 配额响应为空')
  }

  const metrics: QuotaMetric[] = []
  const usage =
    payload.usage && typeof payload.usage === 'object' ? (payload.usage as Record<string, unknown>) : null
  if (usage) {
    const used = normalizeNumberValue(usage.used)
    const limit = normalizeNumberValue(usage.limit)
    const remaining = normalizeNumberValue(usage.remaining)
    metrics.push({
      id: 'kimi-usage',
      label: '总额度',
      value: remaining !== null ? `${remaining} / ${limit ?? '--'}` : `${used ?? '--'} / ${limit ?? '--'}`,
      hint: `重置 ${formatKimiResetHint(usage)}`
    })
  }

  const limits = Array.isArray(payload.limits) ? payload.limits : []
  limits.slice(0, 8).forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return
    }
    const record = item as Record<string, unknown>
    const detail =
      record.detail && typeof record.detail === 'object' ? (record.detail as Record<string, unknown>) : record
    const label = normalizeStringValue(record.name ?? record.title ?? record.scope) ?? `窗口 ${index + 1}`
    const used = normalizeNumberValue(detail.used)
    const limit = normalizeNumberValue(detail.limit)
    const remaining = normalizeNumberValue(detail.remaining)
    metrics.push({
      id: `kimi-limit-${index}`,
      label,
      value:
        remaining !== null
          ? `${remaining} / ${limit ?? '--'}`
          : `${used ?? '--'} / ${limit ?? '--'}`,
      hint: `重置 ${formatKimiResetHint(detail)}`
    })
  })

  return {
    provider: 'kimi',
    headline: 'Kimi',
    metrics
  }
}

async function fetchXaiQuota(file: AuthFileItem): Promise<QuotaResult> {
  const authIndex = normalizeAuthIndex(file)
  return {
    provider: 'xai',
    headline: file.email ? `Grok / xAI ${file.email}` : 'Grok / xAI',
    summary: '已导入 xAI OAuth 认证，可通过本地代理使用 Grok 模型。',
    metrics: [
      {
        id: 'proxy-status',
        label: '代理',
        value: '可用',
        hint: authIndex ? `Auth Index ${authIndex}` : 'xAI 暂无本地额度查询',
        tone: 'success'
      }
    ]
  }
}

async function fetchQuotaForFile(file: AuthFileItem) {
  const provider = resolveAuthProvider(file)
  if (!provider) {
    throw new Error('当前认证文件类型不支持配额查询')
  }

  switch (provider) {
    case 'claude':
      return fetchClaudeQuota(file)
    case 'codex':
      return fetchCodexQuota(file)
    case 'gemini-cli':
      return fetchGeminiCliQuota(file)
    case 'antigravity':
      return fetchAntigravityQuota(file)
    case 'xai':
      return fetchXaiQuota(file)
    case 'kimi':
      return fetchKimiQuota(file)
  }
}

export function QuotaPanel({
  cpaRunning,
  onNotify,
  onError,
  refreshToken = 0,
  activeProvider = 'all',
  sourceFilter = 'all',
  showHeader = true,
  compactUserMode = false,
  maxEnabledAuthFiles,
  allowAutoRotation,
  onUpgradeVip,
  onOpenOauth,
  onProviderCountsChange
}: QuotaPanelProps) {
  const [files, setFiles] = useState<AuthFileItem[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [states, setStates] = useState<Record<string, FileQuotaState>>({})
  const [syncingAuthName, setSyncingAuthName] = useState<string | null>(null)
  const [deletingAuthName, setDeletingAuthName] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AuthFileItem | null>(null)

  const visibleFiles = useMemo(
    () =>
      files.filter((file) => {
        if (!resolveAuthProvider(file) || isRuntimeOnlyAuthFile(file)) {
          return false
        }
        const isShared = isSharedAuthFile(file)
        if (sourceFilter === 'shared') {
          return isShared
        }
        if (sourceFilter === 'personal') {
          return !isShared
        }
        return true
      }),
    [files, sourceFilter]
  )

  const sections = useMemo(() => {
    if (compactUserMode && activeProvider === 'all') {
      return [
        {
          key: 'all',
          provider: 'all' as const,
          meta: null,
          files: visibleFiles
        }
      ]
    }

    return PROVIDER_ORDER.map((provider) => ({
      key: provider,
      provider,
      meta: PROVIDER_META[provider],
      files: visibleFiles.filter((file) => resolveAuthProvider(file) === provider)
    })).filter((section) => activeProvider === 'all' || section.provider === activeProvider)
  }, [activeProvider, compactUserMode, visibleFiles])

  const providerCounts = useMemo(
    () =>
      PROVIDER_ORDER.reduce((acc, provider) => {
        acc[provider] = visibleFiles.filter((file) => resolveAuthProvider(file) === provider).length
        return acc
      }, {} as Record<QuotaProvider, number>),
    [visibleFiles]
  )

  const enabledFiles = useMemo(
    () => visibleFiles.filter((file) => !isDisabledAuthFile(file)),
    [visibleFiles]
  )

  const activeVisibleFiles = useMemo(
    () =>
      visibleFiles.filter(
        (file) => activeProvider === 'all' || resolveAuthProvider(file) === activeProvider
      ),
    [activeProvider, visibleFiles]
  )

  const autoRotationEnabled = useMemo(() => enabledFiles.length > 1, [enabledFiles.length])

  useEffect(() => {
    onProviderCountsChange?.(providerCounts)
  }, [onProviderCountsChange, providerCounts])

  const loadFiles = async () => {
    if (!cpaRunning) {
      setFiles([])
      return []
    }

    setLoadingFiles(true)
    try {
      const response = await quotaApi.listAuthFiles()
      const nextFiles = Array.isArray(response?.files) ? response.files : []
      setFiles(nextFiles)
      return nextFiles
    } catch (error) {
      onError(getErrorMessage(error))
      return []
    } finally {
      setLoadingFiles(false)
    }
  }

  const enableExclusive = async (targetFile: AuthFileItem) => {
    const otherEnabled = visibleFiles.filter((file) => file.name !== targetFile.name && !isDisabledAuthFile(file))
    await Promise.all([
      ...otherEnabled.map((file) => authFilesApi.setStatus(file.name, true)),
      authFilesApi.setStatus(targetFile.name, false)
    ])
  }

  const enableFile = async (targetFile: AuthFileItem) => {
    if (!cpaRunning) {
      onError('请先启动 CPA')
      return
    }

    try {
      setSyncingAuthName(targetFile.name)
      onError(null)

      if (maxEnabledAuthFiles === 1) {
        await enableExclusive(targetFile)
        onNotify(`已启用 ${targetFile.name}`)
      } else {
        await authFilesApi.setStatus(targetFile.name, false)
        onNotify(`已启用 ${targetFile.name}`)
      }

      const nextFiles = await loadFiles()
      const refreshedTarget = nextFiles.find((file) => file.name === targetFile.name)
      if (refreshedTarget && !isDisabledAuthFile(refreshedTarget)) {
        await refreshFileQuota(refreshedTarget)
      }
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSyncingAuthName(null)
    }
  }

  const toggleAutoRotation = async () => {
    if (!cpaRunning) {
      onError('请先启动 CPA')
      return
    }

    if (!allowAutoRotation) {
      onUpgradeVip?.()
      return
    }

    const availableFiles = visibleFiles.filter((file) => resolveAuthProvider(file))
    if (availableFiles.length === 0) {
      onError('当前没有可用的认证文件')
      return
    }

    try {
      setSyncingAuthName('__auto_rotation__')
      onError(null)

      if (autoRotationEnabled) {
        const keep = enabledFiles[0] ?? availableFiles[0]
        await enableExclusive(keep)
        onNotify('已关闭自动切换，当前仅保留一个认证文件启用')
      } else {
        await Promise.all(availableFiles.map((file) => authFilesApi.setStatus(file.name, false)))
        onNotify('已开启自动切换，当前认证文件全部启用')
      }

      await loadFiles()
      await refreshEnabledFilesForProvider()
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSyncingAuthName(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return
    }

    try {
      setDeletingAuthName(deleteTarget.name)
      onError(null)
      await authFilesApi.deleteFile(deleteTarget.name)
      setDeleteTarget(null)
      setStates((current) => {
        const next = { ...current }
        delete next[deleteTarget.name]
        return next
      })
      await loadFiles()
      onNotify(`已删除 ${deleteTarget.name}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setDeletingAuthName(null)
    }
  }

  const refreshFileQuota = async (file: AuthFileItem) => {
    if (!cpaRunning) {
      onError('请先启动 CPA，再查询配额')
      return
    }
    if (isDisabledAuthFile(file)) {
      onError('当前认证文件已被禁用')
      return
    }

    setStates((current) => ({
      ...current,
      [file.name]: { status: 'loading' }
    }))

    try {
      const data = await fetchQuotaForFile(file)
      setStates((current) => ({
        ...current,
        [file.name]: { status: 'success', data }
      }))
    } catch (error) {
      setStates((current) => ({
        ...current,
        [file.name]: { status: 'error', error: getErrorMessage(error) }
      }))
    }
  }

  const refreshAll = async (inputFiles?: AuthFileItem[]) => {
    const scopedFiles =
      inputFiles ??
      visibleFiles.filter((file) => activeProvider === 'all' || resolveAuthProvider(file) === activeProvider)
    const targetFiles = scopedFiles.filter((file) => !isDisabledAuthFile(file))
    if (targetFiles.length === 0) {
      onError('当前没有可查询配额的认证文件')
      return
    }
    await Promise.allSettled(targetFiles.map((file) => refreshFileQuota(file)))
    onNotify(`已刷新 ${targetFiles.length} 个认证文件的配额`)
  }

  const refreshEnabledFilesForProvider = async () => {
    const targetFiles = activeVisibleFiles.filter((file) => !isDisabledAuthFile(file))
    if (targetFiles.length === 0) {
      return
    }
    await Promise.allSettled(targetFiles.map((file) => refreshFileQuota(file)))
  }

  useEffect(() => {
    if (!cpaRunning) {
      setFiles([])
      setStates({})
      return
    }

    let cancelled = false
    void (async () => {
      const nextFiles = await loadFiles()
      if (cancelled || nextFiles.length === 0) {
        return
      }

      // 首次进入只加载认证文件，避免对全部 provider 并发打真实配额接口导致页面长时间卡顿。
      setStates((current) => {
        const nextStates = { ...current }
        nextFiles
          .filter((file) => !isRuntimeOnlyAuthFile(file))
          .forEach((file) => {
            if (!nextStates[file.name]) {
              nextStates[file.name] = { status: 'idle' }
            }
          })
        return nextStates
      })
    })()

    return () => {
      cancelled = true
    }
  }, [cpaRunning, refreshToken])

  useEffect(() => {
    if (!cpaRunning) {
      return
    }
    void refreshEnabledFilesForProvider()
  }, [activeProvider, cpaRunning])

  return (
    <div className="mt-4 flex flex-col gap-6">
      {showHeader ? (
        <div className="rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="badge badge-outline badge-primary">配额管理</div>
              <h2 className="text-3xl font-black">统一查看已接入认证的额度窗口</h2>
              <p className="max-w-3xl text-sm text-base-content/70">
                这里直接复用 CPA 的管理接口查询各 provider 的真实配额，不需要进入 CPM。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="stats border border-base-300 shadow-none">
                <div className="stat px-5 py-4">
                  <div className="stat-title">认证文件</div>
                  <div className="stat-value text-3xl">{visibleFiles.length}</div>
                  <div className="stat-desc">支持 Claude / Codex / Gemini CLI / Antigravity / Kimi</div>
                </div>
              </div>
              <button
                className={`btn btn-primary ${loadingFiles ? 'btn-disabled' : ''}`}
                onClick={() => void loadFiles()}
                disabled={!cpaRunning || loadingFiles}
              >
                刷新认证列表
              </button>
              <button
                className="btn btn-outline"
                onClick={() => void refreshAll()}
                disabled={!cpaRunning || visibleFiles.length === 0}
              >
                刷新全部配额
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div />

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              className={`btn btn-primary btn-sm btn-square ${loadingFiles ? 'btn-disabled' : ''}`}
              onClick={() => void loadFiles()}
              disabled={!cpaRunning || loadingFiles}
              title="刷新认证列表"
            >
              {loadingFiles ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2v6h-6" />
                  <path d="M3 12a9 9 0 0 1 15.55-6.36L21 8" />
                  <path d="M3 22v-6h6" />
                  <path d="M21 12a9 9 0 0 1-15.55 6.36L3 16" />
                </svg>
              )}
            </button>
            {compactUserMode ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={onOpenOauth}
                disabled={!cpaRunning}
              >
                登录账号
              </button>
            ) : null}
            <button
              className="btn btn-outline btn-sm"
              onClick={() => void refreshAll()}
              disabled={!cpaRunning || visibleFiles.length === 0}
            >
              刷新配额
            </button>
            {compactUserMode ? (
              <>
                <button
                  className={`btn btn-sm ${allowAutoRotation ? 'btn-secondary' : 'btn-warning'}`}
                  onClick={() => void toggleAutoRotation()}
                  disabled={!cpaRunning || syncingAuthName === '__auto_rotation__'}
                >
                  {syncingAuthName === '__auto_rotation__' ? <span className="loading loading-spinner loading-xs" /> : null}
                  {allowAutoRotation
                    ? autoRotationEnabled
                      ? '关闭自动切换'
                      : '开启自动切换'
                    : '开启自动切换'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}

      {!cpaRunning ? (
        <div className="hero rounded-box border border-dashed border-base-300 bg-base-100 py-20 shadow-sm">
          <div className="hero-content text-center">
            <div className="max-w-lg">
              <h3 className="text-3xl font-black opacity-70">CPA 未启动</h3>
              <p className="mt-3 text-base-content/60">启动 CPA 后，才能读取认证文件并查询实时配额。</p>
            </div>
          </div>
        </div>
      ) : null}

      {sections.map(({ key, meta, files: providerFiles }) => (
        <section
          key={key}
          className={compactUserMode ? '' : 'rounded-box border border-base-300 bg-base-100 shadow-sm'}
        >
          {!compactUserMode && meta ? (
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-base-200 px-6 py-5">
              <div className="space-y-1">
                <div className={`inline-flex rounded-full bg-gradient-to-r px-3 py-1 text-xs font-semibold text-white ${meta.accent}`}>
                  {meta.label}
                </div>
                <div className="text-sm text-base-content/65">{meta.description}</div>
              </div>
              <div className="badge badge-lg badge-outline">{providerFiles.length} 个认证</div>
            </div>
          ) : null}

          {providerFiles.length === 0 ? (
            <div className="px-6 py-12 text-center text-base-content/55">
              <div>当前没有可用的 {meta?.label ?? '该供应商'} 认证文件。</div>
              <div className="mt-2 text-xs text-base-content/45">
                你也可以自行登录完成认证，用本机 CPA 进行反代使用。
              </div>
            </div>
          ) : (
            <div className={`grid gap-2 ${compactUserMode ? 'grid-cols-1 p-1.5' : 'p-6 xl:grid-cols-2'}`}>
              {providerFiles.map((file) => {
                const state = states[file.name] ?? { status: 'idle' }
                const data = state.data
                const enabled = !isDisabledAuthFile(file)
                const shared = isSharedAuthFile(file)
                const resolvedProvider = resolveAuthProvider(file) ?? 'codex'
                const compactMetrics = pickCompactMetrics(data?.metrics ?? [], resolvedProvider)
                const compactStatusLabel = enabled ? (state.status === 'loading' ? '刷新中' : '正常') : '未启用'
                const compactStatusClass = enabled
                  ? state.status === 'loading'
                    ? 'text-warning'
                    : 'text-success'
                  : 'text-error'

                return (
                  <div
                    key={file.name}
                    className={`rounded-box border shadow-sm transition-all ${
                      compactUserMode
                        ? shared
                          ? 'rounded-2xl border-warning/30 bg-warning/10'
                          : 'rounded-2xl border-success/30 bg-success/10'
                        : enabled
                          ? 'border-success/40 bg-success/10 ring-1 ring-success/20'
                          : 'border-base-300 bg-base-100'
                    } ${syncingAuthName === file.name ? 'opacity-70' : 'cursor-pointer hover:border-primary/40'}`}
                    onClick={() => void enableFile(file)}
                  >
                    {compactUserMode ? (
                      <div className="space-y-1.5 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <div className={`text-base ${shared ? 'text-warning' : 'text-success'}`}>◉</div>
                            <div className="truncate text-sm font-semibold text-base-content">
                              {shared ? '共享账号' : '账号数据'}
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button
                              className={`btn btn-ghost btn-xs btn-square ${state.status === 'loading' ? 'btn-disabled' : ''}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                void refreshFileQuota(file)
                              }}
                              disabled={!cpaRunning || isDisabledAuthFile(file) || state.status === 'loading'}
                              title="刷新"
                            >
                              {state.status === 'loading' ? (
                                <span className="loading loading-spinner loading-[10px]" />
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 2v6h-6" />
                                  <path d="M3 12a9 9 0 0 1 15.55-6.36L21 8" />
                                  <path d="M3 22v-6h6" />
                                  <path d="M21 12a9 9 0 0 1-15.55 6.36L3 16" />
                                </svg>
                              )}
                            </button>
                            <button
                              className="btn btn-ghost btn-xs btn-square text-error"
                              onClick={(event) => {
                                event.stopPropagation()
                                setDeleteTarget(file)
                              }}
                              disabled={deletingAuthName === file.name}
                              title="删除"
                            >
                              {deletingAuthName === file.name ? (
                                <span className="loading loading-spinner loading-[10px]" />
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 6h18" />
                                  <path d="M8 6V4h8v2" />
                                  <path d="M19 6l-1 14H6L5 6" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>

                        <div className="grid gap-1.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-base-content/55">当前账号</span>
                            <span className="max-w-[12rem] truncate font-medium text-base-content" title={file.name}>
                              {file.name}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-base-content/55">状态</span>
                            <span className={`font-medium ${compactStatusClass}`}>{compactStatusLabel}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-base-content/55">类型</span>
                            <span className="badge badge-primary badge-sm border-0 font-normal px-2 h-4 text-[10px]">
                              {getCompactPlanLabel(data, resolvedProvider)}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-2 pt-1">
                          {state.status === 'error' ? (
                            <div className="alert alert-error py-1.5 px-2.5 text-[11px] rounded-lg">
                              <span>{state.error}</span>
                            </div>
                          ) : null}

                          {data && compactMetrics.length > 0 ? (
                            compactMetrics.map((metric) => {
                              const percentValue = parsePercentDisplay(metric.value)
                              return (
                                <div key={metric.id} className="space-y-1">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0 text-xs font-medium text-base-content/80">
                                      {getCompactMetricLabel(metric, resolvedProvider)}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                      <div className={`text-xs font-semibold ${getMetricToneClass(metric.tone)}`}>
                                        {metric.value}
                                      </div>
                                      <div className="text-[10px] text-base-content/45">{getMetricResetText(metric.hint)}</div>
                                    </div>
                                  </div>
                                  {percentValue !== null ? (
                                    <progress
                                      className={`progress ${metric.tone === 'error' ? 'progress-error' : metric.tone === 'warning' ? 'progress-warning' : metric.tone === 'info' ? 'progress-info' : 'progress-success'} h-1.5 w-full bg-base-content/10`}
                                      value={percentValue}
                                      max="100"
                                    />
                                  ) : (
                                    <div className="rounded-full bg-base-200 px-2 py-0.5 text-[10px] font-normal text-base-content/60">
                                      {metric.value}
                                    </div>
                                  )}
                                </div>
                              )
                            })
                          ) : state.status === 'loading' ? (
                            <div className="flex items-center gap-1.5 rounded-lg bg-base-200/70 px-2 py-1.5">
                              <span className="loading loading-spinner loading-[10px]" />
                              <span className="text-[11px] text-base-content/70">正在查询最新配额...</span>
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-base-300 px-2 py-2 text-[11px] text-base-content/55 text-center">
                              点击卡片即可启用并自动刷新配额
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                    <>
                    <div className={`flex flex-wrap items-start justify-between gap-3 border-b border-base-200 ${compactUserMode ? 'px-4 py-3' : 'px-5 py-4'}`}>
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <h3 className={`truncate font-bold ${compactUserMode ? 'max-w-[12rem] text-base' : 'max-w-[16rem] text-lg'}`} title={file.name}>
                            {file.name}
                          </h3>
                          <span className={`badge ${getStateBadgeClass(state.status)}`}>
                            {enabled
                              ? state.status === 'loading'
                                ? '启用中 / 查询中'
                                : '已启用'
                              : '未启用'}
                          </span>
                        </div>
                        {compactUserMode ? null : (
                          <>
                            {data?.headline ? <div className="text-sm font-medium text-base-content/80">{data.headline}</div> : null}
                            {data?.summary ? <div className="text-xs text-base-content/55">{data.summary}</div> : null}
                          </>
                        )}
                      </div>
                    </div>

                    <div className={`space-y-2.5 ${compactUserMode ? 'p-4' : 'p-5'}`}>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          className={`btn btn-sm ${state.status === 'loading' ? 'btn-disabled' : 'btn-outline'}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void refreshFileQuota(file)
                          }}
                          disabled={!cpaRunning || isDisabledAuthFile(file) || state.status === 'loading'}
                        >
                          刷新
                        </button>
                        <button
                          className="btn btn-outline btn-error btn-sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            setDeleteTarget(file)
                          }}
                          disabled={deletingAuthName === file.name}
                        >
                          {deletingAuthName === file.name ? <span className="loading loading-spinner loading-xs" /> : null}
                          删除
                        </button>
                      </div>

                      {state.status === 'error' ? (
                        <div className="alert alert-error py-3">
                          <span>{state.error}</span>
                        </div>
                      ) : null}

                      {data && data.metrics.length > 0 ? (
                        data.metrics.map((metric) => (
                          <div key={metric.id} className={`rounded-box bg-base-200/70 ${compactUserMode ? 'px-3 py-2.5' : 'px-4 py-3'}`}>
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <div className={`${compactUserMode ? 'text-xs' : 'text-sm'} font-semibold`}>{metric.label}</div>
                                {metric.hint ? <div className="mt-1 text-[11px] text-base-content/55">{metric.hint}</div> : null}
                              </div>
                              <div className="shrink-0 text-right">
                                {parsePercentDisplay(metric.value) !== null ? (
                                  <div className="flex min-w-[110px] flex-col items-end gap-1">
                                    <span className={`text-xs font-black ${getMetricToneClass(metric.tone)}`}>
                                      {metric.value}
                                    </span>
                                    <progress
                                      className={`progress ${metric.tone === 'error' ? 'progress-error' : metric.tone === 'warning' ? 'progress-warning' : metric.tone === 'info' ? 'progress-info' : 'progress-success'} w-28`}
                                      value={parsePercentDisplay(metric.value) ?? 0}
                                      max="100"
                                    />
                                  </div>
                                ) : (
                                  <div className={`text-right ${compactUserMode ? 'text-base' : 'text-lg'} font-black ${getMetricToneClass(metric.tone)}`}>
                                    {metric.value}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      ) : state.status === 'loading' ? (
                        <div className={`flex items-center gap-3 rounded-box bg-base-200/70 ${compactUserMode ? 'px-3 py-3.5' : 'px-4 py-5'}`}>
                          <span className="loading loading-spinner loading-sm" />
                          <span className="text-sm text-base-content/70">正在查询最新配额...</span>
                        </div>
                      ) : (
                        <div className="rounded-box border border-dashed border-base-300 px-4 py-6 text-sm text-base-content/55">
                          点击刷新后显示真实配额。
                        </div>
                      )}
                    </div>
                    </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ))}

      <dialog className={`modal ${deleteTarget ? 'modal-open' : ''}`}>
        <div className="modal-box">
          <h3 className="text-lg font-bold">删除认证文件</h3>
          <p className="py-3 text-sm text-base-content/70">
            确认删除
            <span className="mx-1 font-semibold">{deleteTarget?.name}</span>
            吗？删除后将从本地认证目录移除。
          </p>
          <div className="modal-action">
            <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)} disabled={deletingAuthName !== null}>
              取消
            </button>
            <button className="btn btn-error" onClick={() => void confirmDelete()} disabled={deletingAuthName !== null}>
              {deletingAuthName ? <span className="loading loading-spinner loading-xs" /> : null}
              确认删除
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}
