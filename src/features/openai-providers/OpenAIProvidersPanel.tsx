import { useEffect, useMemo, useState } from 'react'
import { openaiProvidersApi } from './api'
import type { HeaderEntry, ModelAliasEntry, OpenAIProviderConfig } from './types'

interface OpenAIProvidersPanelProps {
  cpaRunning: boolean
  onNotify: (message: string) => void
  onError: (message: string | null) => void
  simpleMode?: boolean
}

function createEmptyProvider(): OpenAIProviderConfig {
  return {
    name: '',
    baseUrl: '',
    prefix: '',
    priority: undefined,
    testModel: '',
    headers: {},
    apiKeyEntries: [{ apiKey: '', proxyUrl: '', headers: {} }],
    models: []
  }
}

function cloneProvider(provider: OpenAIProviderConfig): OpenAIProviderConfig {
  return {
    ...provider,
    headers: { ...(provider.headers ?? {}) },
    apiKeyEntries: (provider.apiKeyEntries ?? []).map((entry) => ({
      apiKey: entry.apiKey ?? '',
      proxyUrl: entry.proxyUrl ?? '',
      headers: { ...(entry.headers ?? {}) }
    })),
    models: (provider.models ?? []).map((model) => ({ ...model }))
  }
}

function recordToEntries(record?: Record<string, string>): HeaderEntry[] {
  const entries = Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))
  return entries.length > 0 ? entries : [{ key: '', value: '' }]
}

function entriesToRecord(entries: HeaderEntry[]): Record<string, string> | undefined {
  const next = Object.fromEntries(
    entries
      .map((entry) => [entry.key.trim(), entry.value.trim()] as const)
      .filter(([key, value]) => key && value)
  )
  return Object.keys(next).length > 0 ? next : undefined
}

export function OpenAIProvidersPanel({ cpaRunning, onNotify, onError, simpleMode = false }: OpenAIProvidersPanelProps) {
  const [providers, setProviders] = useState<OpenAIProviderConfig[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number>(-1)
  const [draft, setDraft] = useState<OpenAIProviderConfig>(createEmptyProvider)
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>([{ key: '', value: '' }])
  const [keyHeaderEntries, setKeyHeaderEntries] = useState<Record<number, HeaderEntry[]>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = async (notify = false) => {
    try {
      setLoading(true)
      const nextProviders = await openaiProvidersApi.list()
      setProviders(nextProviders)
      setSelectedIndex((current) => {
        if (nextProviders.length === 0) {
          setDraft(createEmptyProvider())
          setHeaderEntries([{ key: '', value: '' }])
          setKeyHeaderEntries({})
          return -1
        }
        const nextIndex = current >= 0 && current < nextProviders.length ? current : 0
        const nextDraft = cloneProvider(nextProviders[nextIndex])
        setDraft(nextDraft)
        setHeaderEntries(recordToEntries(nextDraft.headers))
        setKeyHeaderEntries(
          Object.fromEntries(
            nextDraft.apiKeyEntries.map((entry, index) => [index, recordToEntries(entry.headers)])
          )
        )
        return nextIndex
      })
      if (notify) {
        onNotify('OpenAI 兼容提供商已刷新')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!cpaRunning) {
      return
    }
    void load()
  }, [cpaRunning])

  const selectedSummary = useMemo(
    () => (selectedIndex >= 0 ? providers[selectedIndex] ?? null : null),
    [providers, selectedIndex]
  )

  const syncDraftHelpers = (nextDraft: OpenAIProviderConfig) => {
    setDraft(nextDraft)
    setHeaderEntries(recordToEntries(nextDraft.headers))
    setKeyHeaderEntries(
      Object.fromEntries(
        nextDraft.apiKeyEntries.map((entry, index) => [index, recordToEntries(entry.headers)])
      )
    )
  }

  const handleSelect = (index: number) => {
    setSelectedIndex(index)
    syncDraftHelpers(cloneProvider(providers[index]))
  }

  const handleCreate = () => {
    setSelectedIndex(-1)
    syncDraftHelpers(createEmptyProvider())
  }

  const updateDraft = (updater: (current: OpenAIProviderConfig) => OpenAIProviderConfig) => {
    setDraft((current) => updater(current))
  }

  const saveProvider = async () => {
    const normalizedName = draft.name.trim()
    const normalizedBaseUrl = draft.baseUrl.trim()
    if (!normalizedName || !normalizedBaseUrl) {
      onError('请填写提供商名称和 Base URL')
      return
    }
    const normalizedProvider: OpenAIProviderConfig = {
      ...draft,
      name: normalizedName,
      baseUrl: normalizedBaseUrl,
      prefix: draft.prefix?.trim() || undefined,
      testModel: draft.testModel?.trim() || undefined,
      priority: draft.priority !== undefined && Number.isFinite(Number(draft.priority))
        ? Number(draft.priority)
        : undefined,
      headers: entriesToRecord(headerEntries),
      apiKeyEntries: draft.apiKeyEntries
        .map((entry, index) => ({
          apiKey: entry.apiKey.trim(),
          proxyUrl: entry.proxyUrl?.trim() || undefined,
          headers: entriesToRecord(keyHeaderEntries[index] ?? [])
        }))
        .filter((entry) => entry.apiKey || entry.proxyUrl || (entry.headers && Object.keys(entry.headers).length > 0)),
      models: (draft.models ?? [])
        .map((model) => ({
          name: model.name.trim(),
          alias: model.alias?.trim() || undefined
        }))
        .filter((model) => model.name)
    }
    if (normalizedProvider.apiKeyEntries.length === 0) {
      normalizedProvider.apiKeyEntries = [{ apiKey: '', proxyUrl: '' }]
    }
    try {
      setSaving(true)
      const nextProviders = [...providers]
      if (selectedIndex >= 0) {
        nextProviders[selectedIndex] = normalizedProvider
      } else {
        nextProviders.push(normalizedProvider)
      }
      await openaiProvidersApi.saveAll(nextProviders)
      setProviders(nextProviders)
      const nextIndex = selectedIndex >= 0 ? selectedIndex : nextProviders.length - 1
      setSelectedIndex(nextIndex)
      syncDraftHelpers(cloneProvider(nextProviders[nextIndex]))
      onNotify(selectedIndex >= 0 ? 'OpenAI 兼容提供商已更新' : 'OpenAI 兼容提供商已新增')
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const deleteProvider = async () => {
    if (selectedIndex < 0 || !selectedSummary) {
      return
    }
    try {
      setDeleting(true)
      const nextProviders = providers.filter((_, index) => index !== selectedIndex)
      await openaiProvidersApi.saveAll(nextProviders)
      setProviders(nextProviders)
      if (nextProviders.length === 0) {
        setSelectedIndex(-1)
        syncDraftHelpers(createEmptyProvider())
      } else {
        const nextIndex = Math.max(0, selectedIndex - 1)
        setSelectedIndex(nextIndex)
        syncDraftHelpers(cloneProvider(nextProviders[nextIndex]))
      }
      onNotify(`已删除提供商：${selectedSummary.name}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }

  const testProvider = async () => {
    try {
      setTesting(true)
      onError(null)
      await openaiProvidersApi.testProvider({
        ...draft,
        headers: entriesToRecord(headerEntries),
        apiKeyEntries: draft.apiKeyEntries.map((entry, index) => ({
          ...entry,
          headers: entriesToRecord(keyHeaderEntries[index] ?? [])
        }))
      })
      onNotify('OpenAI 兼容提供商连通性测试通过')
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  const fetchModels = async () => {
    try {
      setDiscoveringModels(true)
      onError(null)
      const names = await openaiProvidersApi.fetchModels({
        ...draft,
        headers: entriesToRecord(headerEntries),
        apiKeyEntries: draft.apiKeyEntries.map((entry, index) => ({
          ...entry,
          headers: entriesToRecord(keyHeaderEntries[index] ?? [])
        }))
      })
      updateDraft((current) => {
        const existing = new Set((current.models ?? []).map((item) => item.name.trim()))
        const merged: ModelAliasEntry[] = [...(current.models ?? [])]
        names.forEach((name) => {
          if (!existing.has(name)) {
            merged.push({ name, alias: '' })
          }
        })
        return {
          ...current,
          models: merged
        }
      })
      onNotify(`已拉取 ${names.length} 个模型`)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setDiscoveringModels(false)
    }
  }

  const keyEntries = simpleMode ? draft.apiKeyEntries.slice(0, 1) : draft.apiKeyEntries

  return (
    <div className={`mt-4 grid gap-4 ${simpleMode ? '' : 'xl:grid-cols-[340px_minmax(0,1fr)]'}`}>
      <div className={`card border border-base-300 bg-base-100 shadow-sm ${simpleMode ? 'xl:hidden' : ''}`}>
        <div className="card-body gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="card-title text-lg">OpenAI 兼容</h3>
              <p className="text-sm text-base-content/60">管理本机 CPA 的 OpenAI 兼容提供商。</p>
            </div>
            <button className="btn btn-primary btn-sm" disabled={!cpaRunning} onClick={handleCreate}>新增</button>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-outline btn-sm" disabled={!cpaRunning || loading} onClick={() => void load(true)}>
              {loading ? <span className="loading loading-spinner loading-xs" /> : null}
              刷新
            </button>
          </div>
          {!cpaRunning ? (
            <div className="alert alert-warning"><span>请先启动 CPA，再管理本地提供商配置。</span></div>
          ) : null}
          <div className="space-y-2">
            {providers.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-base-300 px-4 py-8 text-center text-sm text-base-content/55">
                当前还没有 OpenAI 兼容提供商。
              </div>
            ) : providers.map((provider, index) => {
              const active = index === selectedIndex
              return (
                <button
                  key={`${provider.name}-${index}`}
                  className={`w-full rounded-2xl border p-4 text-left transition ${active ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-base-300 bg-base-100 hover:border-base-content/20'}`}
                  onClick={() => handleSelect(index)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-base font-semibold">{provider.name}</div>
                    <div className="badge badge-outline">{provider.apiKeyEntries.length} Key</div>
                  </div>
                  <div className="mt-2 truncate text-xs text-base-content/60">{provider.baseUrl}</div>
                  <div className="mt-2 text-xs text-base-content/50">
                    模型 {(provider.models ?? []).length} 个 · 优先级 {provider.priority ?? '-'}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="card-title text-lg">{selectedIndex >= 0 ? `编辑：${selectedSummary?.name ?? ''}` : '新增提供商'}</h3>
              <p className="text-sm text-base-content/60">
                {simpleMode ? '这里直接配置你想接入的 OpenAI 兼容模型。' : '沿用 CPM 的 OpenAI 兼容配置结构，直接写入本机管理配置。'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-outline btn-sm" disabled={!cpaRunning || testing} onClick={() => void testProvider()}>
                {testing ? <span className="loading loading-spinner loading-xs" /> : null}
                测试
              </button>
              <button className="btn btn-outline btn-sm" disabled={!cpaRunning || discoveringModels} onClick={() => void fetchModels()}>
                {discoveringModels ? <span className="loading loading-spinner loading-xs" /> : null}
                拉取模型
              </button>
              {selectedIndex >= 0 ? (
                <button className="btn btn-error btn-sm" disabled={!cpaRunning || deleting} onClick={() => void deleteProvider()}>
                  {deleting ? <span className="loading loading-spinner loading-xs" /> : null}
                  删除
                </button>
              ) : null}
              <button className="btn btn-primary btn-sm" disabled={!cpaRunning || saving} onClick={() => void saveProvider()}>
                {saving ? <span className="loading loading-spinner loading-xs" /> : null}
                保存
              </button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="form-control">
              <div className="label"><span className="label-text">提供商名称</span></div>
              <input className="input input-bordered" value={draft.name} onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="form-control">
              <div className="label"><span className="label-text">Base URL</span></div>
              <input className="input input-bordered" value={draft.baseUrl} onChange={(event) => updateDraft((current) => ({ ...current, baseUrl: event.target.value }))} />
            </label>
            {!simpleMode ? (
              <label className="form-control">
                <div className="label"><span className="label-text">Prefix</span></div>
                <input className="input input-bordered" value={draft.prefix ?? ''} onChange={(event) => updateDraft((current) => ({ ...current, prefix: event.target.value }))} />
              </label>
            ) : null}
            {!simpleMode ? (
              <label className="form-control">
                <div className="label"><span className="label-text">优先级</span></div>
                <input
                  type="number"
                  className="input input-bordered"
                  value={draft.priority ?? ''}
                  onChange={(event) => updateDraft((current) => ({
                    ...current,
                    priority: event.target.value.trim() ? Number(event.target.value) : undefined
                  }))}
                />
              </label>
            ) : null}
          </div>

          <label className="form-control">
            <div className="label"><span className="label-text">测试模型</span></div>
            <input className="input input-bordered" value={draft.testModel ?? ''} onChange={(event) => updateDraft((current) => ({ ...current, testModel: event.target.value }))} />
          </label>

          {!simpleMode ? (
          <div className="rounded-2xl border border-base-300 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold">全局 Headers</div>
              <button className="btn btn-outline btn-xs" onClick={() => setHeaderEntries((current) => [...current, { key: '', value: '' }])}>添加 Header</button>
            </div>
            <div className="space-y-2">
              {headerEntries.map((entry, index) => (
                <div key={`header-${index}`} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                  <input
                    className="input input-bordered input-sm"
                    placeholder="Header Key"
                    value={entry.key}
                    onChange={(event) => setHeaderEntries((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))}
                  />
                  <input
                    className="input input-bordered input-sm"
                    placeholder="Header Value"
                    value={entry.value}
                    onChange={(event) => setHeaderEntries((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))}
                  />
                  <button className="btn btn-ghost btn-sm" onClick={() => setHeaderEntries((current) => current.length === 1 ? [{ key: '', value: '' }] : current.filter((_, itemIndex) => itemIndex !== index))}>删除</button>
                </div>
              ))}
            </div>
          </div>
          ) : null}

          <div className="rounded-2xl border border-base-300 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold">API Keys</div>
              {!simpleMode ? (
              <button
                className="btn btn-outline btn-xs"
                onClick={() => {
                  updateDraft((current) => ({
                    ...current,
                    apiKeyEntries: [...current.apiKeyEntries, { apiKey: '', proxyUrl: '', headers: {} }]
                  }))
                  setKeyHeaderEntries((current) => ({
                    ...current,
                    [draft.apiKeyEntries.length]: [{ key: '', value: '' }]
                  }))
                }}
              >
                添加 Key
              </button>
              ) : null}
            </div>
            <div className="space-y-4">
              {keyEntries.map((entry, index) => (
                <div key={`key-${index}`} className="rounded-xl border border-base-300 p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="font-medium">Key #{index + 1}</div>
                    {!simpleMode ? (
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => {
                        updateDraft((current) => ({
                          ...current,
                          apiKeyEntries: current.apiKeyEntries.length === 1
                            ? [{ apiKey: '', proxyUrl: '', headers: {} }]
                            : current.apiKeyEntries.filter((_, itemIndex) => itemIndex !== index)
                        }))
                        setKeyHeaderEntries((current) => {
                          const next = { ...current }
                          delete next[index]
                          return next
                        })
                      }}
                    >
                      删除
                    </button>
                    ) : null}
                  </div>
                  <div className={`grid gap-3 ${simpleMode ? 'md:grid-cols-1' : 'md:grid-cols-2'}`}>
                    <input
                      className="input input-bordered input-sm"
                      placeholder="API Key"
                      value={entry.apiKey}
                      onChange={(event) => updateDraft((current) => ({
                        ...current,
                        apiKeyEntries: current.apiKeyEntries.map((item, itemIndex) => itemIndex === index ? { ...item, apiKey: event.target.value } : item)
                      }))}
                    />
                    <input
                      className="input input-bordered input-sm"
                      placeholder="Proxy URL（可选）"
                      value={entry.proxyUrl ?? ''}
                      onChange={(event) => updateDraft((current) => ({
                        ...current,
                        apiKeyEntries: current.apiKeyEntries.map((item, itemIndex) => itemIndex === index ? { ...item, proxyUrl: event.target.value } : item)
                      }))}
                    />
                  </div>
                  {!simpleMode ? (
                  <div className="mt-3">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span>该 Key 的 Headers</span>
                      <button
                        className="btn btn-outline btn-xs"
                        onClick={() => setKeyHeaderEntries((current) => ({
                          ...current,
                          [index]: [...(current[index] ?? [{ key: '', value: '' }]), { key: '', value: '' }]
                        }))}
                      >
                        添加 Header
                      </button>
                    </div>
                    <div className="space-y-2">
                      {(keyHeaderEntries[index] ?? [{ key: '', value: '' }]).map((header, headerIndex) => (
                        <div key={`key-${index}-header-${headerIndex}`} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                          <input
                            className="input input-bordered input-sm"
                            placeholder="Header Key"
                            value={header.key}
                            onChange={(event) => setKeyHeaderEntries((current) => ({
                              ...current,
                              [index]: (current[index] ?? [{ key: '', value: '' }]).map((item, itemIndex) => itemIndex === headerIndex ? { ...item, key: event.target.value } : item)
                            }))}
                          />
                          <input
                            className="input input-bordered input-sm"
                            placeholder="Header Value"
                            value={header.value}
                            onChange={(event) => setKeyHeaderEntries((current) => ({
                              ...current,
                              [index]: (current[index] ?? [{ key: '', value: '' }]).map((item, itemIndex) => itemIndex === headerIndex ? { ...item, value: event.target.value } : item)
                            }))}
                          />
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setKeyHeaderEntries((current) => ({
                              ...current,
                              [index]: (current[index] ?? [{ key: '', value: '' }]).length === 1
                                ? [{ key: '', value: '' }]
                                : (current[index] ?? []).filter((_, itemIndex) => itemIndex !== headerIndex)
                            }))}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-base-300 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold">模型映射</div>
              <button
                className="btn btn-outline btn-xs"
                onClick={() => updateDraft((current) => ({
                  ...current,
                  models: [...(current.models ?? []), { name: '', alias: '' }]
                }))}
              >
                添加模型
              </button>
            </div>
            <div className="space-y-2">
              {(draft.models ?? []).length === 0 ? (
                <div className="text-sm text-base-content/55">还没有配置模型，可以直接点“拉取模型”。</div>
              ) : (draft.models ?? []).map((model, index) => (
                <div key={`model-${index}`} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                  <input
                    className="input input-bordered input-sm"
                    placeholder="模型名称"
                    value={model.name}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item)
                    }))}
                  />
                  <input
                    className="input input-bordered input-sm"
                    placeholder="别名（可选）"
                    value={model.alias ?? ''}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, alias: event.target.value } : item)
                    }))}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => updateDraft((current) => ({
                      ...current,
                      models: (current.models ?? []).filter((_, itemIndex) => itemIndex !== index)
                    }))}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
