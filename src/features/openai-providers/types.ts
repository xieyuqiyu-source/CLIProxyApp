export interface HeaderEntry {
  key: string
  value: string
}

export interface ModelAliasEntry {
  name: string
  alias?: string
}

export interface OpenAIApiKeyEntry {
  apiKey: string
  proxyUrl?: string
  headers?: Record<string, string>
}

export interface OpenAIProviderConfig {
  name: string
  prefix?: string
  baseUrl: string
  apiKeyEntries: OpenAIApiKeyEntry[]
  headers?: Record<string, string>
  models?: ModelAliasEntry[]
  priority?: number
  testModel?: string
}
