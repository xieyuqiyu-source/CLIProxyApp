import { memo, useEffect, useMemo, useState } from 'react'
import { cpaRuntime } from '../../lib/cpa/runtime'
import type { ContinueConfigState } from '../../lib/cpa/types'

interface ContinueConfigDialogProps {
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

export const ContinueConfigDialog = memo(function ContinueConfigDialog({
  open,
  onClose,
  onNotify,
  onError
}: ContinueConfigDialogProps) {
  const [loading, setLoading] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [restoringDefault, setRestoringDefault] = useState(false)
  const [state, setState] = useState<ContinueConfigState | null>(null)
  const [selectedChatModel, setSelectedChatModel] = useState('')
  const [selectedAutocompleteModel, setSelectedAutocompleteModel] = useState('')

  const syncSelectedModels = (nextState: ContinueConfigState) => {
    setSelectedChatModel(
      nextState.chatModel?.trim() || nextState.recommendedChatModel?.trim() || nextState.availableModels[0] || ''
    )
    setSelectedAutocompleteModel(
      nextState.autocompleteModel?.trim()
        || nextState.recommendedAutocompleteModel?.trim()
        || nextState.recommendedChatModel?.trim()
        || nextState.availableModels[0]
        || ''
    )
  }

  const refreshState = async () => {
    setLoading(true)
    try {
      const result = await cpaRuntime.getContinueConfigState()
      setState(result)
      syncSelectedModels(result)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) {
      return
    }
    void refreshState()
  }, [open])

  const recommendedModels = useMemo(() => {
    if (!state) {
      return []
    }
    return [
      { label: '聊天 / 编辑 / 应用', model: state.recommendedChatModel },
      { label: '补全', model: state.recommendedAutocompleteModel }
    ]
  }, [state])

  const handleSetup = async () => {
    try {
      setConfiguring(true)
      const result = await cpaRuntime.setupContinueConfig({
        chatModel: selectedChatModel,
        autocompleteModel: selectedAutocompleteModel
      })
      const nextState = await cpaRuntime.getContinueConfigState()
      setState(nextState)
      syncSelectedModels(nextState)
      onNotify(`Continue 已写入：聊天 ${result.chatModel}，补全 ${result.autocompleteModel}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setConfiguring(false)
    }
  }

  const handleRestoreDefault = async () => {
    try {
      setRestoringDefault(true)
      const result = await cpaRuntime.restoreContinueConfigDefault()
      const nextState = await cpaRuntime.getContinueConfigState()
      setState(nextState)
      syncSelectedModels(nextState)
      onNotify(`Continue 配置已恢复默认：${result.configPath}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setRestoringDefault(false)
    }
  }

  return (
    <dialog className={`modal ${open ? 'modal-open' : ''}`}>
      <div className="modal-box w-[min(92vw,520px)] max-w-[520px] p-0">
        <div className="flex items-center justify-between border-b border-base-200 px-4 py-3">
          <div>
            <h3 className="text-lg font-bold">Continue 配置</h3>
            <p className="mt-1 text-xs text-base-content/55">一键把当前本地代理写入 Continue 的本地配置。</p>
          </div>
          <button className="btn btn-ghost btn-sm btn-circle shrink-0" onClick={onClose}>
            ✕
          </button>
        </div>

	      <div className="space-y-3 px-4 py-4">
	          <div className="rounded-2xl border border-info/30 bg-info/10 px-3 py-3 text-sm text-base-content/75">
	            使用前提：请先在 VS Code 中安装 <span className="font-semibold">Continue</span> 插件，再使用这里的一键配置。
	          </div>

	          {loading ? (
	            <div className="flex items-center gap-2 rounded-2xl border border-base-300 bg-base-100 px-3 py-3 text-sm text-base-content/65">
	              <span className="loading loading-spinner loading-sm" />
              正在读取 Continue 配置和代理模型
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
                    模型数 {state.availableModels.length}
                  </span>
                </div>
                <div className="mt-2 text-sm text-base-content/65">
                  Base URL {state.currentBaseUrl?.trim() || '--'}
                </div>
              </div>

	              <div className="rounded-2xl border border-base-300 bg-base-100 px-3 py-3">
	                <div className="flex items-center justify-between gap-2">
	                  <div className="text-sm font-semibold">将写入的 Continue 模型</div>
	                  <div className="text-xs text-base-content/55">默认用推荐值，也可手动切换</div>
	                </div>
	                <div className="mt-3 space-y-2">
	                  {recommendedModels.map(({ label, model }) => (
	                    <div key={label} className="flex items-center justify-between gap-3 rounded-xl border border-base-300 px-3 py-2">
	                      <div className="text-sm text-base-content/70">{label}</div>
	                      <div className="text-sm font-semibold">{model?.trim() || '--'}</div>
	                    </div>
	                  ))}
	                </div>
	              </div>

                <div className="rounded-2xl border border-base-300 bg-base-100 px-3 py-3">
                  <div className="text-sm font-semibold">手动选择模型</div>
                  <div className="mt-1 text-xs text-base-content/55">
                    聊天 / 编辑 / 应用共用一个模型，补全单独选择。
                  </div>
                  <div className="mt-3 space-y-3">
                    <label className="form-control w-full">
                      <div className="label pb-1">
                        <span className="label-text text-sm">聊天 / 编辑 / 应用模型</span>
                      </div>
                      <select
                        className="select select-bordered w-full"
                        value={selectedChatModel}
                        onChange={(event) => setSelectedChatModel(event.target.value)}
                        disabled={configuring || restoringDefault}
                      >
                        {state.availableModels.map((model) => (
                          <option key={`chat-${model}`} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="form-control w-full">
                      <div className="label pb-1">
                        <span className="label-text text-sm">补全模型</span>
                      </div>
                      <select
                        className="select select-bordered w-full"
                        value={selectedAutocompleteModel}
                        onChange={(event) => setSelectedAutocompleteModel(event.target.value)}
                        disabled={configuring || restoringDefault}
                      >
                        {state.availableModels.map((model) => (
                          <option key={`autocomplete-${model}`} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

	              <div className="rounded-2xl border border-dashed border-base-300 px-3 py-3 text-sm text-base-content/60">
	                会写入两个模型块：
                `chat/edit/apply` 使用主模型，`autocomplete` 使用快速模型。
              </div>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-base-200 px-4 py-3">
          <div>
            {state?.canRestoreDefault ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => void handleRestoreDefault()}
                disabled={restoringDefault || configuring}
              >
                {restoringDefault ? <span className="loading loading-spinner loading-xs" /> : null}
                恢复默认
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              关闭
            </button>
	            <button
	              className="btn btn-primary btn-sm"
	              onClick={() => void handleSetup()}
	              disabled={
                  loading
                  || configuring
                  || restoringDefault
                  || !state
                  || state.availableModels.length === 0
                  || !selectedChatModel
                  || !selectedAutocompleteModel
                }
	            >
              {configuring ? <span className="loading loading-spinner loading-xs" /> : null}
              一键配置 Continue
            </button>
          </div>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  )
}, (prev, next) => prev.open === next.open)
