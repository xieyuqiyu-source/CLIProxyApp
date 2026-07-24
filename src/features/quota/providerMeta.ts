import type { QuotaProvider } from './types'

export const PROVIDER_ORDER: QuotaProvider[] = ['claude', 'codex', 'gemini-cli', 'antigravity', 'xai', 'kimi']

export const PROVIDER_META: Record<
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
  xai: {
    label: 'Grok',
    accent: 'from-slate-500 to-zinc-800',
    description: 'xAI Grok OAuth 账号和本地代理'
  },
  kimi: {
    label: 'Kimi',
    accent: 'from-pink-400 to-rose-500',
    description: 'Moonshot Kimi 使用额度'
  }
}
