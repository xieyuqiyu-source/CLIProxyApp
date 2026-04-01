import { cpaRuntime } from '../../lib/cpa/runtime'
import type {
  IFlowCookieAuthResponse,
  OAuthProvider,
  OAuthStartResponse,
  OAuthStatusResponse,
  VertexImportResponse
} from './types'

const WEBUI_SUPPORTED: OAuthProvider[] = ['codex', 'anthropic', 'antigravity', 'gemini-cli']
const CALLBACK_PROVIDER_MAP: Partial<Record<OAuthProvider, string>> = {
  'gemini-cli': 'gemini'
}

export const oauthApi = {
  startAuth: (provider: OAuthProvider, options?: { projectId?: string }) => {
    const query: Array<[string, string]> = []
    if (WEBUI_SUPPORTED.includes(provider)) {
      query.push(['is_webui', 'true'])
    }
    if (provider === 'gemini-cli' && options?.projectId) {
      query.push(['project_id', options.projectId])
    }

    return cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: `${provider}-auth-url`,
      query
    }) as Promise<OAuthStartResponse>
  },

  getAuthStatus: (state: string) =>
    cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: 'get-auth-status',
      query: [['state', state]]
    }) as Promise<OAuthStatusResponse>,

  submitCallback: (provider: OAuthProvider, redirectUrl: string) =>
    cpaRuntime.proxyManagementRequest({
      method: 'POST',
      path: 'oauth-callback',
      body: {
        provider: CALLBACK_PROVIDER_MAP[provider] ?? provider,
        redirect_url: redirectUrl
      }
    }),

  iflowCookieAuth: (cookie: string) =>
    cpaRuntime.proxyManagementRequest({
      method: 'POST',
      path: 'iflow-auth-url',
      body: { cookie }
    }) as Promise<IFlowCookieAuthResponse>,

  importVertexCredential: (file: File, location?: string) =>
    file.arrayBuffer().then((buffer) =>
      cpaRuntime.importVertexCredential(
        {
          name: file.name,
          bytes: Array.from(new Uint8Array(buffer))
        },
        location
      ) as Promise<VertexImportResponse>
    )
}
