import { OAUTH_PROVIDER_IDS, PROVIDERS } from './providerDefinitions'
import { mapQuotaProviderToOauthProvider, resolveOauthProviders } from '../user-workspace/providerMapping'

export const oauthProviderIdsIncludeXai: true = OAUTH_PROVIDER_IDS.includes('xai') as true

export const oauthProvidersIncludeXai: true = PROVIDERS.some((provider) => provider.id === 'xai') as true

export const quotaProviderMapsToXai: 'xai' = mapQuotaProviderToOauthProvider('xai')

export const allQuotaProvidersIncludeXai: true = resolveOauthProviders('all')?.includes('xai') as true
