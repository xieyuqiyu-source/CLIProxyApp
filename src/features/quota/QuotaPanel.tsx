import { useEffect, useMemo, useState } from 'react'
import { quotaApi, getApiCallErrorMessage } from './api'
import type {
  ApiCallResult,
  AuthFileItem,
  FileQuotaState,
  QuotaMetric,
  QuotaProvider,
  QuotaResult
} from './types'

const PROVIDER_ORDER: QuotaProvider[] = ['claude', 'codex', 'gemini-cli', 'antigravity', 'kimi']

const PROVIDER_META: Record<
  QuotaProvider,
  { label: string; accent: string; description: string }
> = {
  claude: {
    label: 'Claude',
    accent: 'from-orange-400 to-amber-500',
    description: 'Anthropic OAuth 配额窗口'
  },
  codex: {
    label: 'Codex',
    accent: 'from-emerald-400 to-teal-500',
    description: 'OpenAI / Codex 额度与限流窗口'
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    accent: 'from-lime-400 to-green-500',
    description: 'Google CLI 项目配额与 credits'
  },
  antigravity: {
    label: 'Antigravity',
    accent: 'from-cyan-400 to-sky-500',
    description: 'Antigravity 模型可用剩余额度'
  },
  kimi: {
    label: 'Kimi',
    accent: 'from-pink-400 to-rose-500',
    description: 'Moonshot Kimi 使用额度'
  }
}

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
    label: 'Gemini 3.1 Pro',
    identifiers: ['gemini-3.1-pro-high', 'gemini-3.1-pro-low']
  },
  {
    label: 'Gemini 3 Pro',
    identifiers: ['gemini-3-pro-high', 'gemini-3-pro-low']
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
  const normalized = normalizeNumberValue(value)
  if (normalized === null) {
    return null
  }
  return normalized <= 1 ? normalized * 100 : normalized
}

function formatPercent(value: number | null) {
  if (value === null) {
    return '--'
  }
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`
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

  const [profileResult, usageResult] = await Promise.all([
    quotaApi.apiCall({
      authIndex,
      method: 'GET',
      url: 'https://api.anthropic.com/api/oauth/profile',
      header: headers
    }),
    quotaApi.apiCall({
      authIndex,
      method: 'GET',
      url: 'https://api.anthropic.com/api/oauth/usage',
      header: headers
    })
  ])

  ensureSuccess(usageResult)

  const profile = parseResponseJson(profileResult)
  const usage = parseResponseJson(usageResult)
  const account =
    profile?.account && typeof profile.account === 'object'
      ? (profile.account as Record<string, unknown>)
      : null
  const organization =
    profile?.organization && typeof profile.organization === 'object'
      ? (profile.organization as Record<string, unknown>)
      : null

  let headline = 'Claude OAuth'
  if (account?.has_claude_max === true) {
    headline = 'Claude Max'
  } else if (account?.has_claude_pro === true) {
    headline = 'Claude Pro'
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
  if (!accountId) {
    throw new Error('当前 Codex 认证文件缺少 ChatGPT account id')
  }

  const result = await quotaApi.apiCall({
    authIndex,
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header: {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
      'Chatgpt-Account-Id': accountId
    }
  })

  ensureSuccess(result)
  const payload = parseResponseJson(result)
  if (!payload) {
    throw new Error('Codex 配额响应为空')
  }

  const planType = normalizeStringValue(payload.plan_type ?? payload.planType) ?? resolveCodexPlanType(file)
  const metrics: QuotaMetric[] = []

  const addWindowMetric = (
    label: string,
    id: string,
    windowValue: unknown,
    allowed?: unknown,
    limitReached?: unknown
  ) => {
    if (!windowValue || typeof windowValue !== 'object') {
      return
    }
    const windowRecord = windowValue as Record<string, unknown>
    const usedPercent = normalizeFractionPercent(windowRecord.used_percent ?? windowRecord.usedPercent)
    const remainingPercent =
      usedPercent === null
        ? limitReached === true || allowed === false
          ? 0
          : null
        : 100 - usedPercent
    metrics.push({
      id,
      label,
      value: formatPercent(remainingPercent),
      hint: `重置 ${formatCodexReset(windowRecord)}`
    })
  }

  const rateLimit =
    payload.rate_limit && typeof payload.rate_limit === 'object'
      ? (payload.rate_limit as Record<string, unknown>)
      : payload.rateLimit && typeof payload.rateLimit === 'object'
        ? (payload.rateLimit as Record<string, unknown>)
        : null
  const codeReviewRateLimit =
    payload.code_review_rate_limit && typeof payload.code_review_rate_limit === 'object'
      ? (payload.code_review_rate_limit as Record<string, unknown>)
      : payload.codeReviewRateLimit && typeof payload.codeReviewRateLimit === 'object'
        ? (payload.codeReviewRateLimit as Record<string, unknown>)
        : null

  addWindowMetric(
    '主窗口',
    'primary-window',
    rateLimit?.primary_window ?? rateLimit?.primaryWindow,
    rateLimit?.allowed,
    rateLimit?.limit_reached ?? rateLimit?.limitReached
  )
  addWindowMetric(
    '次窗口',
    'secondary-window',
    rateLimit?.secondary_window ?? rateLimit?.secondaryWindow,
    rateLimit?.allowed,
    rateLimit?.limit_reached ?? rateLimit?.limitReached
  )
  addWindowMetric(
    'Code Review 主窗口',
    'code-review-primary-window',
    codeReviewRateLimit?.primary_window ?? codeReviewRateLimit?.primaryWindow,
    codeReviewRateLimit?.allowed,
    codeReviewRateLimit?.limit_reached ?? codeReviewRateLimit?.limitReached
  )
  addWindowMetric(
    'Code Review 次窗口',
    'code-review-secondary-window',
    codeReviewRateLimit?.secondary_window ?? codeReviewRateLimit?.secondaryWindow,
    codeReviewRateLimit?.allowed,
    codeReviewRateLimit?.limit_reached ?? codeReviewRateLimit?.limitReached
  )

  const additionalRateLimits = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : Array.isArray(payload.additionalRateLimits)
      ? payload.additionalRateLimits
      : []
  additionalRateLimits.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return
    }
    const record = item as Record<string, unknown>
    const rateInfo =
      record.rate_limit && typeof record.rate_limit === 'object'
        ? (record.rate_limit as Record<string, unknown>)
        : record.rateLimit && typeof record.rateLimit === 'object'
          ? (record.rateLimit as Record<string, unknown>)
          : null
    if (!rateInfo) {
      return
    }
    const label =
      normalizeStringValue(record.limit_name ?? record.limitName ?? record.metered_feature ?? record.meteredFeature) ??
      `附加限制 ${index + 1}`
    addWindowMetric(
      `${label} 主窗口`,
      `additional-primary-${index}`,
      rateInfo.primary_window ?? rateInfo.primaryWindow,
      rateInfo.allowed,
      rateInfo.limit_reached ?? rateInfo.limitReached
    )
    addWindowMetric(
      `${label} 次窗口`,
      `additional-secondary-${index}`,
      rateInfo.secondary_window ?? rateInfo.secondaryWindow,
      rateInfo.allowed,
      rateInfo.limit_reached ?? rateInfo.limitReached
    )
  })

  return {
    provider: 'codex',
    headline: planType ? `Codex ${planType}` : 'Codex',
    summary: accountId,
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

  const [quotaResult, codeAssistResult] = await Promise.all([
    quotaApi.apiCall({
      authIndex,
      method: 'POST',
      url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      header: headers,
      data: JSON.stringify({ project: projectId })
    }),
    quotaApi.apiCall({
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
  ])

  ensureSuccess(quotaResult)

  const quotaPayload = parseResponseJson(quotaResult)
  const assistPayload = parseResponseJson(codeAssistResult)
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

  for (const url of ANTIGRAVITY_QUOTA_URLS) {
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
  }

  if (!successfulResult) {
    throw new Error('Antigravity 配额接口未返回成功结果')
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
    case 'kimi':
      return fetchKimiQuota(file)
  }
}

export function QuotaPanel({ cpaRunning, onNotify, onError }: QuotaPanelProps) {
  const [files, setFiles] = useState<AuthFileItem[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [states, setStates] = useState<Record<string, FileQuotaState>>({})

  const visibleFiles = useMemo(
    () => files.filter((file) => resolveAuthProvider(file) && !isRuntimeOnlyAuthFile(file)),
    [files]
  )

  const sections = useMemo(
    () =>
      PROVIDER_ORDER.map((provider) => ({
        provider,
        meta: PROVIDER_META[provider],
        files: visibleFiles.filter((file) => resolveAuthProvider(file) === provider)
      })),
    [visibleFiles]
  )

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
    const targetFiles = (inputFiles ?? visibleFiles).filter((file) => !isDisabledAuthFile(file))
    if (targetFiles.length === 0) {
      onError('当前没有可查询配额的认证文件')
      return
    }
    await Promise.allSettled(targetFiles.map((file) => refreshFileQuota(file)))
    onNotify(`已刷新 ${targetFiles.length} 个认证文件的配额`)
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
      await refreshAll(nextFiles.filter((file) => !isRuntimeOnlyAuthFile(file)))
    })()

    return () => {
      cancelled = true
    }
  }, [cpaRunning])

  return (
    <div className="mt-4 flex flex-col gap-6">
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

      {sections.map(({ provider, meta, files: providerFiles }) => (
        <section key={provider} className="rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-base-200 px-6 py-5">
            <div className="space-y-1">
              <div className={`inline-flex rounded-full bg-gradient-to-r px-3 py-1 text-xs font-semibold text-white ${meta.accent}`}>
                {meta.label}
              </div>
              <div className="text-sm text-base-content/65">{meta.description}</div>
            </div>
            <div className="badge badge-lg badge-outline">{providerFiles.length} 个认证</div>
          </div>

          {providerFiles.length === 0 ? (
            <div className="px-6 py-12 text-center text-base-content/55">当前没有可用的 {meta.label} 认证文件。</div>
          ) : (
            <div className="grid gap-4 p-6 xl:grid-cols-2">
              {providerFiles.map((file) => {
                const state = states[file.name] ?? { status: 'idle' }
                const data = state.data
                const badgeItems = [
                  isDisabledAuthFile(file) ? 'disabled' : null,
                  normalizeAuthIndex(file) ? `auth:${normalizeAuthIndex(file)}` : null,
                  ...(data?.badges ?? [])
                ].filter(Boolean) as string[]

                return (
                  <div key={file.name} className="rounded-box border border-base-300 bg-base-100 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-base-200 px-5 py-4">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-bold">{file.name}</h3>
                          <span className={`badge ${getStateBadgeClass(state.status)}`}>
                            {state.status === 'success'
                              ? '已刷新'
                              : state.status === 'error'
                                ? '失败'
                                : state.status === 'loading'
                                  ? '查询中'
                                  : '待查询'}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {badgeItems.map((item) => (
                            <span key={item} className="badge badge-outline badge-sm">
                              {item}
                            </span>
                          ))}
                        </div>
                        {data?.headline ? <div className="text-sm font-medium text-base-content/80">{data.headline}</div> : null}
                        {data?.summary ? <div className="text-xs text-base-content/55">{data.summary}</div> : null}
                      </div>

                      <button
                        className={`btn btn-sm ${state.status === 'loading' ? 'btn-disabled' : 'btn-outline'}`}
                        onClick={() => void refreshFileQuota(file)}
                        disabled={!cpaRunning || isDisabledAuthFile(file) || state.status === 'loading'}
                      >
                        刷新
                      </button>
                    </div>

                    <div className="space-y-3 p-5">
                      {state.status === 'error' ? (
                        <div className="alert alert-error py-3">
                          <span>{state.error}</span>
                        </div>
                      ) : null}

                      {data && data.metrics.length > 0 ? (
                        data.metrics.map((metric) => (
                          <div key={metric.id} className="rounded-box bg-base-200/70 px-4 py-3">
                            <div className="flex items-center justify-between gap-4">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold">{metric.label}</div>
                                {metric.hint ? <div className="mt-1 text-xs text-base-content/55">{metric.hint}</div> : null}
                              </div>
                              <div className={`shrink-0 text-right text-lg font-black ${getMetricToneClass(metric.tone)}`}>
                                {metric.value}
                              </div>
                            </div>
                          </div>
                        ))
                      ) : state.status === 'loading' ? (
                        <div className="flex items-center gap-3 rounded-box bg-base-200/70 px-4 py-5">
                          <span className="loading loading-spinner loading-sm" />
                          <span className="text-sm text-base-content/70">正在查询最新配额...</span>
                        </div>
                      ) : (
                        <div className="rounded-box border border-dashed border-base-300 px-4 py-6 text-sm text-base-content/55">
                          点击刷新后显示真实配额。
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
