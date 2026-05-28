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
  const status = result.statusCode
  const withStatus = (message: string) => (status ? `${status} ${message}`.trim() : message)
  const summarizeText = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      return ''
    }
    if (/^<!doctype html\b|^<html[\s>]/i.test(trimmed)) {
      const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      const heading = trimmed.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
      const summary = (title ?? heading ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return summary || '远端返回了 HTML 错误页面'
    }
    return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed
  }

  const body = result.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    const error = record.error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const nested = error as Record<string, unknown>
      if (typeof nested.message === 'string' && nested.message.trim()) {
        return withStatus(nested.message.trim())
      }
    }
    if (typeof error === 'string' && error.trim()) {
      return withStatus(summarizeText(error))
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return withStatus(summarizeText(record.message))
    }
  }

  if (typeof body === 'string') {
    const message = summarizeText(body)
    if (message) {
      return withStatus(message)
    }
  }

  const fallback = summarizeText(result.bodyText)
  if (fallback) {
    return withStatus(fallback)
  }

  if (status) {
    return `HTTP ${status}`
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
