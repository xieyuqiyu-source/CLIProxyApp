import { cpaRuntime } from '../../lib/cpa/runtime'
import { quotaApi, getApiCallErrorMessage } from '../quota/api'
import type { OpenAIProviderConfig } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const next = Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => [String(key).trim(), String(headerValue ?? '').trim()])
      .filter(([key, headerValue]) => key && headerValue)
  )
  return Object.keys(next).length > 0 ? next : undefined
}

function normalizeProvider(item: unknown): OpenAIProviderConfig | null {
  if (!isRecord(item)) {
    return null
  }
  const name = String(item.name ?? '').trim()
  const baseUrl = String(item['base-url'] ?? item.baseUrl ?? '').trim()
  if (!name || !baseUrl) {
    return null
  }
  const apiKeyEntriesRaw: unknown[] = Array.isArray(item['api-key-entries'] ?? item.apiKeyEntries)
    ? ((item['api-key-entries'] ?? item.apiKeyEntries) as unknown[])
    : []
  const apiKeyEntries = apiKeyEntriesRaw
    .map((entry: unknown) => {
      if (!isRecord(entry)) {
        return null
      }
      return {
        apiKey: String(entry['api-key'] ?? entry.apiKey ?? '').trim(),
        proxyUrl: String(entry['proxy-url'] ?? entry.proxyUrl ?? '').trim() || undefined,
        headers: normalizeHeaders(entry.headers)
      }
    })
    .filter(Boolean) as OpenAIProviderConfig['apiKeyEntries']

  const modelsRaw = Array.isArray(item.models) ? item.models : []
  const models = modelsRaw
    .map((entry) => {
      if (!isRecord(entry)) {
        return null
      }
      const modelName = String(entry.name ?? '').trim()
      if (!modelName) {
        return null
      }
      const alias = String(entry.alias ?? '').trim()
      return { name: modelName, alias: alias || undefined }
    })
    .filter(Boolean) as OpenAIProviderConfig['models']

  const priorityValue = item.priority
  const priority = Number.isFinite(Number(priorityValue)) ? Number(priorityValue) : undefined
  const prefix = String(item.prefix ?? '').trim() || undefined
  const testModel = String(item['test-model'] ?? item.testModel ?? '').trim() || undefined

  return {
    name,
    baseUrl,
    prefix,
    priority,
    testModel,
    headers: normalizeHeaders(item.headers),
    apiKeyEntries: apiKeyEntries.length > 0 ? apiKeyEntries : [{ apiKey: '', proxyUrl: '' }],
    models
  }
}

function serializeProvider(provider: OpenAIProviderConfig) {
  const payload: Record<string, unknown> = {
    name: provider.name.trim(),
    'base-url': provider.baseUrl.trim(),
    'api-key-entries': provider.apiKeyEntries.map((entry) => {
      const next: Record<string, unknown> = {
        'api-key': entry.apiKey.trim()
      }
      if (entry.proxyUrl?.trim()) {
        next['proxy-url'] = entry.proxyUrl.trim()
      }
      if (entry.headers && Object.keys(entry.headers).length > 0) {
        next.headers = entry.headers
      }
      return next
    })
  }
  if (provider.prefix?.trim()) {
    payload.prefix = provider.prefix.trim()
  }
  if (provider.priority !== undefined && Number.isFinite(provider.priority)) {
    payload.priority = provider.priority
  }
  if (provider.headers && Object.keys(provider.headers).length > 0) {
    payload.headers = provider.headers
  }
  if (provider.models && provider.models.length > 0) {
    payload.models = provider.models
      .map((model) => {
        const name = model.name.trim()
        if (!name) return null
        const alias = String(model.alias ?? '').trim()
        return alias && alias !== name ? { name, alias } : { name }
      })
      .filter(Boolean)
  }
  if (provider.testModel?.trim()) {
    payload['test-model'] = provider.testModel.trim()
  }
  return payload
}

function normalizeBaseUrl(baseUrl: string) {
  let trimmed = String(baseUrl || '').trim()
  if (!trimmed) return ''
  trimmed = trimmed.replace(/\/?v0\/management\/?$/i, '')
  trimmed = trimmed.replace(/\/+$/g, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`
  }
  return trimmed
}

function dedupeEndpoints(values: string[]) {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)))
}

function buildModelsEndpoints(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return []
  if (/\/v1\/models$/i.test(normalized) || /\/models$/i.test(normalized)) {
    return [normalized]
  }
  if (/\/v1$/i.test(normalized)) {
    return dedupeEndpoints([`${normalized}/models`, normalized.replace(/\/v1$/i, '/models')])
  }
  return dedupeEndpoints([`${normalized}/v1/models`, `${normalized}/models`])
}

function buildChatCompletionsEndpoints(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return []
  if (/\/v1\/chat\/completions$/i.test(normalized) || /\/chat\/completions$/i.test(normalized)) {
    return [normalized]
  }
  if (/\/v1$/i.test(normalized)) {
    return dedupeEndpoints([
      `${normalized}/chat/completions`,
      normalized.replace(/\/v1$/i, '/chat/completions')
    ])
  }
  return dedupeEndpoints([
    `${normalized}/v1/chat/completions`,
    `${normalized}/chat/completions`
  ])
}

function mergeHeaders(
  providerHeaders?: Record<string, string>,
  entryHeaders?: Record<string, string>,
  apiKey?: string
) {
  const headers: Record<string, string> = {
    ...(providerHeaders ?? {}),
    ...(entryHeaders ?? {})
  }
  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
  if (apiKey && !hasAuthorization) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

function normalizeModelsPayload(payload: unknown): string[] {
  const items = isRecord(payload) && Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : []
  const values = items
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry.trim()
      }
      if (isRecord(entry)) {
        return String(entry.id ?? entry.name ?? '').trim()
      }
      return ''
    })
    .filter(Boolean)
  return Array.from(new Set(values))
}

function formatAttemptError(endpoint: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
  return `${endpoint} -> ${message}`
}

export const openaiProvidersApi = {
  list: async (): Promise<OpenAIProviderConfig[]> => {
    const response = (await cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: 'openai-compatibility'
    })) as unknown
    const list = Array.isArray(response)
      ? response
      : isRecord(response) && Array.isArray(response['openai-compatibility'])
        ? response['openai-compatibility']
        : []
    return list.map(normalizeProvider).filter(Boolean) as OpenAIProviderConfig[]
  },

  saveAll: async (providers: OpenAIProviderConfig[]) =>
    cpaRuntime.proxyManagementRequest({
      method: 'PUT',
      path: 'openai-compatibility',
      body: providers.map(serializeProvider)
  }),

  testProvider: async (provider: OpenAIProviderConfig) => {
    const endpoints = buildChatCompletionsEndpoints(provider.baseUrl)
    if (endpoints.length === 0) {
      throw new Error('请填写正确的 Base URL')
    }
    const entry = provider.apiKeyEntries.find((item) => item.apiKey.trim()) ?? provider.apiKeyEntries[0]
    const apiKey = entry?.apiKey?.trim()
    if (!apiKey) {
      throw new Error('请至少填写一个 API Key')
    }
    const model = provider.testModel?.trim() || provider.models?.find((item) => item.name.trim())?.name || ''
    if (!model) {
      throw new Error('请先填写测试模型或至少配置一个模型')
    }
    const headers = mergeHeaders(provider.headers, entry.headers, apiKey)
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      max_tokens: 8
    })
    const attemptErrors: string[] = []

    for (const endpoint of endpoints) {
      try {
        const result = await quotaApi.apiCall({
          method: 'POST',
          url: endpoint,
          header: {
            'Content-Type': 'application/json',
            ...headers
          },
          data: payload
        })
        if (result.statusCode >= 200 && result.statusCode < 300) {
          return result
        }
        attemptErrors.push(`${endpoint} -> ${getApiCallErrorMessage(result)}`)
      } catch (error) {
        attemptErrors.push(formatAttemptError(endpoint, error))
      }
    }

    throw new Error(`测试失败，已尝试：${attemptErrors.join(' | ')}`)
  },

  fetchModels: async (provider: OpenAIProviderConfig) => {
    const endpoints = buildModelsEndpoints(provider.baseUrl)
    if (endpoints.length === 0) {
      throw new Error('请填写正确的 Base URL')
    }
    const entry = provider.apiKeyEntries.find((item) => item.apiKey.trim()) ?? provider.apiKeyEntries[0]
    const headers = mergeHeaders(provider.headers, entry?.headers, entry?.apiKey?.trim())
    const attemptErrors: string[] = []

    for (const endpoint of endpoints) {
      try {
        const result = await quotaApi.apiCall({
          method: 'GET',
          url: endpoint,
          header: headers
        })
        if (result.statusCode >= 200 && result.statusCode < 300) {
          return normalizeModelsPayload(result.body ?? result.bodyText)
        }
        attemptErrors.push(`${endpoint} -> ${getApiCallErrorMessage(result)}`)
      } catch (error) {
        attemptErrors.push(formatAttemptError(endpoint, error))
      }
    }

    throw new Error(`获取模型失败，已尝试：${attemptErrors.join(' | ')}`)
  }
}
