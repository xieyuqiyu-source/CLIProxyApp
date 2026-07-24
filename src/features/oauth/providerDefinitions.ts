import type { OAuthProvider, ProviderDefinition } from './types'

export const OAUTH_PROVIDER_IDS: OAuthProvider[] = [
  'codex',
  'anthropic',
  'antigravity',
  'gemini-cli',
  'xai',
  'kimi',
  'qwen'
]

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    subtitle: 'OpenAI / Codex OAuth 授权',
    accent: 'from-emerald-400 to-teal-500',
    callbackSupported: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude Code OAuth 授权',
    accent: 'from-orange-400 to-amber-500',
    callbackSupported: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    subtitle: 'Antigravity 浏览器授权',
    accent: 'from-cyan-400 to-sky-500',
    callbackSupported: true
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    subtitle: '支持项目 ID 的 Google 授权',
    accent: 'from-lime-400 to-green-500',
    callbackSupported: true,
    projectIdSupported: true
  },
  {
    id: 'xai',
    name: 'Grok / xAI',
    subtitle: 'xAI Grok OAuth 授权',
    accent: 'from-slate-500 to-zinc-800'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    subtitle: 'Moonshot Kimi OAuth 授权',
    accent: 'from-pink-400 to-rose-500'
  },
  {
    id: 'qwen',
    name: 'Qwen',
    subtitle: '通义 Qwen OAuth 授权',
    accent: 'from-violet-400 to-fuchsia-500'
  }
]
