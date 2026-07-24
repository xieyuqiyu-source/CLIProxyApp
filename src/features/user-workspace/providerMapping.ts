import { PROVIDER_ORDER } from '../quota/providerMeta'
import type { QuotaProvider } from '../quota/types'
import type { OAuthProvider } from '../oauth/types'

const QUOTA_TO_OAUTH_PROVIDER = {
  claude: 'anthropic',
  codex: 'codex',
  'gemini-cli': 'gemini-cli',
  antigravity: 'antigravity',
  xai: 'xai',
  kimi: 'kimi'
} as const satisfies Record<QuotaProvider, OAuthProvider>

export function mapQuotaProviderToOauthProvider<T extends QuotaProvider>(provider: T): (typeof QUOTA_TO_OAUTH_PROVIDER)[T] {
  return QUOTA_TO_OAUTH_PROVIDER[provider]
}

export function resolveOauthProviders(provider: QuotaProvider | 'all'): OAuthProvider[] | undefined {
  if (provider === 'all') {
    return PROVIDER_ORDER.map(mapQuotaProviderToOauthProvider)
  }
  return [mapQuotaProviderToOauthProvider(provider)]
}
