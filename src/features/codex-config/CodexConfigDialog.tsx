import { memo, useEffect, useMemo, useState } from 'react'
import { cpaRuntime } from '../../lib/cpa/runtime'
import type { CodexConfigState } from '../../lib/cpa/types'

interface CodexConfigDialogProps {
  open: boolean
  onClose: () => void
  onNotify: (message: string) => void
  onError: (message: string | null) => void
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export const CodexConfigDialog = memo(function CodexConfigDialog({ open, onClose, onNotify, onError }: CodexConfigDialogProps) {
  const [loading, setLoading] = useState(false)
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [restoringDefault, setRestoringDefault] = useState(false)
  const [state, setState] = useState<CodexConfigState | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setLoading(true)
    void cpaRuntime
      .getCodexConfigState()
      .then((result) => {
        if (cancelled) {
          return
        }
        setState(result)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        onError(getErrorMessage(error))
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, onError])

  const availableModels = useMemo(() => state?.availableModels ?? [], [state])
  const hasEffectiveBaseUrl = Boolean(state?.currentBaseUrl?.trim())

  const handleSelectModel = async (model: string) => {
    try {
      setSavingModel(model)
      const result = await cpaRuntime.setCodexConfigModel(model)
      setState((current) =>
        current
          ? {
              ...current,
              exists: true,
              currentModel: result.model,
              currentBaseUrl: result.baseUrl,
              canRestoreDefault: true
            }
          : current
      )
      onNotify(`Codex 已切换到模型：${result.model}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSavingModel(null)
    }
  }

  const handleRestoreDefault = async () => {
    try {
      setRestoringDefault(true)
      const result = await cpaRuntime.restoreCodexConfigDefault()
      const nextState = await cpaRuntime.getCodexConfigState()
      setState(nextState)
      onNotify(`Codex 配置已恢复默认：${result.configPath}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setRestoringDefault(false)
    }
  }

  return (
    <dialog className={`modal ${open ? 'modal-open' : ''}`}>
      <div className="modal-box w-[min(92vw,460px)] max-w-[460px] p-0">
        <div className="flex items-center justify-between border-b border-base-200 px-4 py-3">
          <div>
            <h3 className="text-lg font-bold">Codex 配置</h3>
            <p className="mt-1 text-xs text-base-content/55">读取本机 Codex 配置，并切换默认模型。</p>
          </div>
          <button className="btn btn-ghost btn-sm btn-circle shrink-0" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-base-300 bg-base-100 px-3 py-3 text-sm text-base-content/65">
              <span className="loading loading-spinner loading-sm" />
              正在读取 Codex 配置和代理模型
            </div>
          ) : null}

          {!loading && state ? (
            <>
              <div className="rounded-2xl border border-base-300 bg-base-100 px-3 py-3 text-xs">
                <div className="text-[11px] uppercase tracking-[0.18em] text-base-content/40">Config Path</div>
                <div className="mt-1 break-all text-sm text-base-content/80">{state.configPath}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className={`badge badge-sm ${state.exists ? 'badge-success' : 'badge-warning'}`}>
                    {state.exists ? '已发现配置' : '将新建配置'}
                  </span>
                  <span className="badge badge-outline badge-sm">
                    当前模型 {state.currentModel?.trim() || '--'}
                  </span>
                </div>
                <div className="mt-2 text-sm text-base-content/65">
                  Base URL {state.currentBaseUrl?.trim() || '--'}
                </div>
              </div>

              {!hasEffectiveBaseUrl ? (
                <div className="rounded-2xl border border-warning/35 bg-warning/10 px-3 py-3 text-xs leading-5 text-warning-content">
                  Codex 会读取本机已有配置并高亮同名模型；如果上方 Base URL 还是 “--”，说明代理地址还没有写入，必须点击一次模型才会真正生效。
                </div>
              ) : null}

              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">代理可用模型</div>
                <div className="flex items-center gap-2">
                  {state.canRestoreDefault ? (
                    <button
                      className="btn btn-outline btn-xs"
                      onClick={() => void handleRestoreDefault()}
                      disabled={restoringDefault || Boolean(savingModel)}
                    >
                      {restoringDefault ? <span className="loading loading-spinner loading-xs" /> : null}
                      恢复默认
                    </button>
                  ) : null}
                  <div className="text-xs text-base-content/55">{availableModels.length} 个</div>
                </div>
              </div>

              <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
                {availableModels.length > 0 ? (
                  availableModels.map((model) => {
                    const modelMatchesConfig = state.currentModel === model
                    const active = modelMatchesConfig && hasEffectiveBaseUrl
                    const saving = savingModel === model
                    return (
                      <button
                        key={model}
                        className={`flex w-full items-center justify-between rounded-2xl border px-3 py-3 text-left transition ${
                          active
                            ? 'border-primary bg-primary/8 ring-1 ring-primary/20'
                            : modelMatchesConfig
                              ? 'border-warning/50 bg-warning/8 ring-1 ring-warning/20'
                            : 'border-base-300 bg-base-100 hover:border-primary/40'
                        }`}
                        onClick={() => void handleSelectModel(model)}
                        disabled={Boolean(savingModel)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{model}</div>
                          <div className="mt-1 text-xs text-base-content/55">
                            {active
                              ? '当前已生效'
                              : modelMatchesConfig
                                ? '模型已匹配，但需点击一次写入 Base URL'
                                : '点击后写入 Codex 默认模型和 Base URL'}
                          </div>
                        </div>
                        <div className="ml-3 shrink-0">
                          {saving ? (
                            <span className="loading loading-spinner loading-sm" />
                          ) : active ? (
                            <span className="badge badge-primary badge-sm">已选中</span>
                          ) : modelMatchesConfig ? (
                            <span className="badge badge-warning badge-sm">点击生效</span>
                          ) : (
                            <span className="badge badge-outline badge-sm">切换</span>
                          )}
                        </div>
                      </button>
                    )
                  })
                ) : (
                  <div className="rounded-2xl border border-dashed border-base-300 px-3 py-6 text-center text-sm text-base-content/55">
                    当前代理未返回任何模型，请先确认 CPA 已启动且认证可用。
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  )
}, (prev, next) => prev.open === next.open)
