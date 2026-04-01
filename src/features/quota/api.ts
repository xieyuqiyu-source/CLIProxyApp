import { cpaRuntime } from '../../lib/cpa/runtime'
import type { ApiCallRequest, ApiCallResult, AuthFilesResponse } from './types'

function normalizeBody(input: unknown): { bodyText: string; body: unknown | null } {
  if (input === undefined || input === null) {
    return { bodyText: '', body: null }
  }

  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) {
      return { bodyText: input, body: null }
    }
    try {
      return { bodyText: input, body: JSON.parse(trimmed) }
    } catch {
      return { bodyText: input, body: input }
    }
  }

  try {
    return { bodyText: JSON.stringify(input), body: input }
  } catch {
    return { bodyText: String(input), body: input }
  }
}

export function getApiCallErrorMessage(result: ApiCallResult) {
  const body = result.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string' && record.error.trim()) {
      return `${result.statusCode} ${record.error}`.trim()
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return `${result.statusCode} ${record.message}`.trim()
    }
  }

  if (typeof body === 'string' && body.trim()) {
    return `${result.statusCode} ${body}`.trim()
  }

  if (result.bodyText.trim()) {
    return `${result.statusCode} ${result.bodyText}`.trim()
  }

  if (result.statusCode) {
    return `HTTP ${result.statusCode}`
  }

  return 'Request failed'
}

export const quotaApi = {
  listAuthFiles: () =>
    cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: 'auth-files'
    }) as Promise<AuthFilesResponse>,

  downloadAuthFile: (name: string) =>
    cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: 'auth-files/download',
      query: [['name', name]]
    }) as Promise<unknown>,

  apiCall: async (payload: ApiCallRequest): Promise<ApiCallResult> => {
    const response = (await cpaRuntime.proxyManagementRequest({
      method: 'POST',
      path: 'api-call',
      body: payload
    })) as Record<string, unknown>

    const statusCode = Number(response?.status_code ?? response?.statusCode ?? 0)
    const header = (response?.header ?? response?.headers ?? {}) as Record<string, string[]>
    const { bodyText, body } = normalizeBody(response?.body)

    return {
      statusCode,
      header,
      bodyText,
      body
    }
  }
}
