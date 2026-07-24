import { useEffect, useMemo, useState } from 'react'
import { authFilesApi } from './api'
import type { AuthFileItem, AuthFileModel, AuthProviderKey } from './types'
import { cloudClient } from '../../lib/cloud/client'
import { cpaRuntime } from '../../lib/cpa/runtime'
import type { CloudAuthFile } from '../../lib/cloud/types'
import { sharedImportRegistry } from '../../lib/cloud/sharedRegistry'

const PROVIDER_ORDER: AuthProviderKey[] = [
  'claude',
  'codex',
  'gemini-cli',
  'antigravity',
  'xai',
  'kimi',
  'unknown'
]

const PROVIDER_LABELS: Record<AuthProviderKey, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  antigravity: 'Antigravity',
  xai: 'Grok',
  kimi: 'Kimi',
  unknown: '未识别'
}

export interface AuthFilesPanelProps {
  cpaRunning: boolean
  pendingAction: string | null
  planCode?: string
  cloudToken?: string
  maxEnabledAuthFiles?: number
  allowAutoRotation?: boolean
  allowPersonalCloudSync?: boolean
  allowSharedPool?: boolean
  onNotify: (message: string) => void
  onError: (message: string | null) => void
  onImportClick: () => void
  onExportClick: () => void
  onOpenConfigDir: () => void
}

type ProviderFilter = AuthProviderKey | 'all'

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function normalizeString(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

function normalizeBool(value: unknown) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true'
  }
  return false
}

function resolveProvider(file: AuthFileItem): AuthProviderKey {
  const raw = String(file.provider ?? file.type ?? '')
    .trim()
    .toLowerCase()

  if (
    raw === 'claude' ||
    raw === 'codex' ||
    raw === 'gemini-cli' ||
    raw === 'antigravity' ||
    raw === 'xai' ||
    raw === 'kimi'
  ) {
    return raw
  }
  return 'unknown'
}

function resolveAuthIndex(file: AuthFileItem) {
  return normalizeString(file.authIndex ?? file.auth_index) ?? '-'
}

function isRuntimeOnly(file: AuthFileItem) {
  return normalizeBool(file.runtimeOnly ?? file.runtime_only)
}

function isDisabled(file: AuthFileItem) {
  return normalizeBool(file.disabled)
}

async function copyText(value: string, onNotify: (message: string) => void, onError: (message: string | null) => void) {
  try {
    await navigator.clipboard.writeText(value)
    onNotify(`已复制：${value}`)
  } catch (error) {
    onError(getErrorMessage(error))
  }
}

export function AuthFilesPanel({
  cpaRunning,
  pendingAction,
  planCode,
  cloudToken,
  maxEnabledAuthFiles,
  allowAutoRotation,
  allowPersonalCloudSync,
  onNotify,
  onError,
  onImportClick,
  onExportClick,
  onOpenConfigDir
}: AuthFilesPanelProps) {
  const [files, setFiles] = useState<AuthFileItem[]>([])
  const [personalCloudFiles, setPersonalCloudFiles] = useState<CloudAuthFile[]>([])
  const [loading, setLoading] = useState(false)
  const [cloudLoading, setCloudLoading] = useState(false)
  const [cloudUploading, setCloudUploading] = useState(false)
  const [cloudDownloadingId, setCloudDownloadingId] = useState<number | null>(null)
  const [cloudDeletingId, setCloudDeletingId] = useState<number | null>(null)
  const [clearingPersonalCloud, setClearingPersonalCloud] = useState(false)
  const [togglingName, setTogglingName] = useState<string | null>(null)
  const [deletingName, setDeletingName] = useState<string | null>(null)
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<AuthFileItem | null>(null)
  const [confirmDeletePersonalCloudFile, setConfirmDeletePersonalCloudFile] = useState<CloudAuthFile | null>(null)
  const [confirmClearPersonalCloud, setConfirmClearPersonalCloud] = useState(false)
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
  const [expandedNames, setExpandedNames] = useState<Record<string, boolean>>({})
  const [modelsState, setModelsState] = useState<
    Record<string, { status: 'idle' | 'loading' | 'success' | 'error'; models: AuthFileModel[]; error?: string }>
  >({})

  const loadFiles = async (notify = false) => {
    if (!cpaRunning) {
      setFiles([])
      return
    }

    try {
      setLoading(true)
      const response = await authFilesApi.list()
      const nextFiles = Array.isArray(response?.files) ? response.files : []
      setFiles(nextFiles)
      if (notify) {
        onNotify(`已刷新 ${nextFiles.length} 个认证文件`)
      }
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!cpaRunning) {
      setFiles([])
      return
    }
    void loadFiles()
  }, [cpaRunning])

  const loadCloudFiles = async (notify = false) => {
    if (!cloudToken) {
      setPersonalCloudFiles([])
      return
    }

    try {
      setCloudLoading(true)
      const personal = await cloudClient.listMyAuthFiles(cloudToken)
      setPersonalCloudFiles(Array.isArray(personal.files) ? personal.files : [])
      if (notify) {
        onNotify('云端认证文件已刷新')
      }
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setCloudLoading(false)
    }
  }

  useEffect(() => {
    void loadCloudFiles()
  }, [cloudToken])

  const toggleFileStatus = async (file: AuthFileItem) => {
    const nextDisabled = !isDisabled(file)
    try {
      setTogglingName(file.name)
      if (!nextDisabled && maxEnabledAuthFiles === 1) {
        const enabledFiles = files.filter((current) => current.name !== file.name && !isDisabled(current))
        if (enabledFiles.length > 0) {
          await Promise.all(enabledFiles.map((current) => authFilesApi.setStatus(current.name, true)))
        }
      }
      await authFilesApi.setStatus(file.name, nextDisabled)
      await loadFiles()
      if (!nextDisabled && maxEnabledAuthFiles === 1) {
        onNotify(`${file.name} 已启用，其他认证文件已自动禁用`)
      } else {
        onNotify(`${file.name} 已${nextDisabled ? '禁用' : '启用'}`)
      }
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setTogglingName(null)
    }
  }

  const toggleModels = async (file: AuthFileItem) => {
    const isExpanded = expandedNames[file.name] === true
    if (isExpanded) {
      setExpandedNames((current) => ({ ...current, [file.name]: false }))
      return
    }

    setExpandedNames((current) => ({ ...current, [file.name]: true }))
    const currentState = modelsState[file.name]
    if (currentState && (currentState.status === 'loading' || currentState.status === 'success')) {
      return
    }

    try {
      setModelsState((current) => ({
        ...current,
        [file.name]: { status: 'loading', models: [] }
      }))
      const models = await authFilesApi.getModelsForAuthFile(file.name)
      setModelsState((current) => ({
        ...current,
        [file.name]: { status: 'success', models }
      }))
    } catch (error) {
      setModelsState((current) => ({
        ...current,
        [file.name]: { status: 'error', models: [], error: getErrorMessage(error) }
      }))
    }
  }

  const deleteLocalFile = async (file: AuthFileItem) => {
    try {
      setDeletingName(file.name)
      await authFilesApi.deleteFile(file.name)
      sharedImportRegistry.removeByLocalFileName(file.name)
      await loadFiles()
      onNotify(`已删除本地认证文件：${file.name}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setDeletingName(null)
      setConfirmDeleteFile(null)
    }
  }

  const importCloudFileToLocal = async (kind: 'personal' | 'shared', file: CloudAuthFile) => {
    if (!cloudToken) {
      onError('当前未登录云端账号')
      return
    }
    try {
      setCloudDownloadingId(file.id)
      const download =
        kind === 'shared'
          ? await cloudClient.downloadSharedAuthFile(cloudToken, file.id)
          : await cloudClient.downloadMyAuthFile(cloudToken, file.id)
      await cpaRuntime.importAuthFiles([
        {
          name: download.fileName,
          bytes: download.bytes
        }
      ])
      if (kind === 'shared') {
        sharedImportRegistry.upsert({
          cloudFileId: file.id,
          localFileName: download.fileName,
          downloadedAt: new Date().toISOString(),
          planRequired: file.planRequired
        })
      }
      await loadFiles()
      onNotify(`已将 ${file.displayName || file.fileName} 下载并导入本地 CPA`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setCloudDownloadingId(null)
    }
  }

  const uploadAllLocalFilesToCloud = async () => {
    if (!cloudToken) {
      return
    }
    try {
      setCloudUploading(true)
      const localFiles = await cpaRuntime.getLocalAuthFiles()
      if (localFiles.length === 0) {
        onError('当前本地没有可上传的认证文件。')
        return
      }
      for (const file of localFiles) {
        const blob = new Blob([new Uint8Array(file.bytes)], { type: 'application/json' })
        const uploadFile = new File([blob], file.name, { type: 'application/json' })
        await cloudClient.uploadMyAuthFile(cloudToken, uploadFile)
      }
      await loadCloudFiles()
      onNotify(`已将本地 ${localFiles.length} 个认证文件上传到个人云端`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setCloudUploading(false)
    }
  }

  const deletePersonalCloudFile = async (file: CloudAuthFile) => {
    if (!cloudToken) {
      return
    }
    try {
      setCloudDeletingId(file.id)
      await cloudClient.deleteMyAuthFile(cloudToken, file.id)
      await loadCloudFiles()
      onNotify(`已删除云端认证文件：${file.displayName || file.fileName}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setCloudDeletingId(null)
      setConfirmDeletePersonalCloudFile(null)
    }
  }



  const clearPersonalCloudFiles = async () => {
    if (!cloudToken) {
      return
    }
    try {
      setClearingPersonalCloud(true)
      const result = await cloudClient.deleteAllMyAuthFiles(cloudToken)
      await loadCloudFiles()
      onNotify(`已清空个人云认证文件，共删除 ${result.deleted} 个`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setClearingPersonalCloud(false)
      setConfirmClearPersonalCloud(false)
    }
  }



  const providerCounts = useMemo(() => {
    const counts: Record<AuthProviderKey, number> = {
      claude: 0,
      codex: 0,
      'gemini-cli': 0,
      antigravity: 0,
      xai: 0,
      kimi: 0,
      unknown: 0
    }

    files.forEach((file) => {
      counts[resolveProvider(file)] += 1
    })

    return counts
  }, [files])

  const filteredFiles = useMemo(() => {
    if (providerFilter === 'all') {
      return files
    }
    return files.filter((file) => resolveProvider(file) === providerFilter)
  }, [files, providerFilter])

  const stats = useMemo(() => {
    const runtimeOnlyCount = files.filter(isRuntimeOnly).length
    const disabledCount = files.filter(isDisabled).length
    const providerCount = new Set(files.map(resolveProvider)).size
    return {
      total: files.length,
      providerCount,
      runtimeOnlyCount,
      disabledCount
    }
  }, [files])

  return (
    <div className="mt-4 flex flex-col gap-6">
      <div className="rounded-box border border-base-300 bg-base-100 shadow-sm">
        <div className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <div className="badge badge-outline badge-primary">认证文件</div>
            <h2 className="text-3xl font-black">管理已接入的 OAuth / Auth 文件</h2>
            <p className="max-w-3xl text-sm text-base-content/70">
              这里聚合显示 CPA 当前已加载的认证文件。自动切换能力由 CPA 底层负责，页面主要负责查看、导入、导出与诊断。
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {planCode ? <span className="badge badge-secondary badge-outline">套餐：{planCode}</span> : null}
              {typeof maxEnabledAuthFiles === 'number' ? (
                <span className="badge badge-outline">
                  最多启用 {maxEnabledAuthFiles >= 999 ? '无限' : maxEnabledAuthFiles} 个
                </span>
              ) : null}
              <span className={`badge ${allowAutoRotation ? 'badge-success' : 'badge-ghost'}`}>
                {allowAutoRotation ? '允许自动切换' : '禁止自动切换'}
              </span>
              <span className={`badge ${allowPersonalCloudSync ? 'badge-success' : 'badge-ghost'}`}>
                {allowPersonalCloudSync ? '可同步个人云认证' : '不可同步个人云认证'}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={!cpaRunning || pendingAction !== null} onClick={onImportClick}>
              {pendingAction === 'import-auth-files' && <span className="loading loading-spinner loading-xs"></span>}
              导入认证文件
            </button>
            <button className="btn btn-outline" disabled={!cpaRunning || pendingAction !== null} onClick={onExportClick}>
              {pendingAction === 'export-auth-files' && <span className="loading loading-spinner loading-xs"></span>}
              导出认证文件
            </button>
            <button className="btn btn-outline" disabled={pendingAction !== null} onClick={onOpenConfigDir}>
              打开配置目录
            </button>
            <button className="btn btn-outline" disabled={!cpaRunning || loading} onClick={() => void loadFiles(true)}>
              {loading && <span className="loading loading-spinner loading-xs"></span>}
              刷新列表
            </button>
          </div>
        </div>
      </div>

      {cloudToken ? (
        <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="flex flex-col gap-4 border-b border-base-200 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-lg font-bold">个人云认证文件</h3>
              <p className="text-sm text-base-content/55">
                这里仅管理当前账号自己的云端认证文件。共享认证池已移到 admin 的“发布”页统一管理。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-outline btn-sm" disabled={cloudLoading} onClick={() => void loadCloudFiles(true)}>
                {cloudLoading ? <span className="loading loading-spinner loading-xs"></span> : null}
                刷新云端
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={!allowPersonalCloudSync || cloudUploading}
                onClick={() => void uploadAllLocalFilesToCloud()}
              >
                {cloudUploading ? <span className="loading loading-spinner loading-xs"></span> : null}
                上传本地全部认证
              </button>
            </div>
          </div>

          <div className="grid gap-6 p-6 xl:grid-cols-2">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-bold">个人云认证文件</h4>
                  <p className="text-sm text-base-content/55">只属于当前账号，可下载到本地继续使用。</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="badge badge-outline">{personalCloudFiles.length} 个</span>
                  <button
                    className="btn btn-outline btn-error btn-xs"
                    disabled={personalCloudFiles.length === 0 || clearingPersonalCloud}
                    onClick={() => setConfirmClearPersonalCloud(true)}
                  >
                    {clearingPersonalCloud ? <span className="loading loading-spinner loading-xs"></span> : null}
                    一键删除
                  </button>
                </div>
              </div>
              {!allowPersonalCloudSync && planCode !== 'admin' ? (
                <div className="alert">
                  <span>当前套餐不支持个人云认证同步。</span>
                </div>
              ) : personalCloudFiles.length === 0 ? (
                <div className="rounded-box border border-dashed border-base-300 px-4 py-8 text-sm text-base-content/55">
                  个人云端还没有认证文件。
                </div>
              ) : (
                <div className="space-y-3">
                  {personalCloudFiles.map((file) => (
                    <div key={file.id} className="rounded-box border border-base-300 bg-base-100 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold">{file.displayName || file.fileName}</div>
                          <div className="text-sm text-base-content/60">{file.provider} · {file.fileName}</div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="btn btn-outline btn-sm"
                            disabled={!cpaRunning || cloudDownloadingId === file.id}
                            onClick={() => void importCloudFileToLocal('personal', file)}
                          >
                            {cloudDownloadingId === file.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                            下载到本地
                          </button>
                          <button
                            className="btn btn-outline btn-error btn-sm"
                            disabled={cloudDeletingId === file.id}
                            onClick={() => setConfirmDeletePersonalCloudFile(file)}
                          >
                            {cloudDeletingId === file.id ? <span className="loading loading-spinner loading-xs"></span> : null}
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </section>
      ) : null}

      {!cpaRunning ? (
        <div className="hero rounded-box border border-dashed border-base-300 bg-base-100 py-20 shadow-sm">
          <div className="hero-content text-center">
            <div className="max-w-lg">
              <h3 className="text-3xl font-black opacity-70">CPA 未启动</h3>
              <p className="mt-3 text-base-content/60">启动 CPA 后，才能读取本地认证文件列表。</p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat">
            <div className="stat-title">总认证文件</div>
            <div className="stat-value text-primary">{stats.total}</div>
            <div className="stat-desc">当前 CPA 已识别数量</div>
          </div>
        </div>
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat">
            <div className="stat-title">提供商</div>
            <div className="stat-value text-secondary">{stats.providerCount}</div>
            <div className="stat-desc">已覆盖 provider 数</div>
          </div>
        </div>
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat">
            <div className="stat-title">运行时文件</div>
            <div className="stat-value text-accent">{stats.runtimeOnlyCount}</div>
            <div className="stat-desc">runtime only</div>
          </div>
        </div>
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat">
            <div className="stat-title">已禁用</div>
            <div className="stat-value text-warning">{stats.disabledCount}</div>
            <div className="stat-desc">不会参与自动切换</div>
          </div>
        </div>
      </div>

      <section className="rounded-box border border-base-300 bg-base-100 shadow-sm">
        <div className="flex flex-col gap-4 border-b border-base-200 px-6 py-5">
          <div>
            <h3 className="text-lg font-bold">按提供商筛选</h3>
            <p className="text-sm text-base-content/55">
              切换上面的 provider，快速查看对应认证文件。默认显示全部。
              {maxEnabledAuthFiles === 1 ? ' 当前账号启用新认证文件时，会自动禁用其他已启用文件。' : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={`btn btn-sm ${providerFilter === 'all' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setProviderFilter('all')}
            >
              全部
              <span className="badge badge-ghost badge-sm">{files.length}</span>
            </button>
            {PROVIDER_ORDER.map((provider) => (
              <button
                key={provider}
                className={`btn btn-sm ${providerFilter === provider ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setProviderFilter(provider)}
              >
                {PROVIDER_LABELS[provider]}
                <span className="badge badge-ghost badge-sm">{providerCounts[provider]}</span>
              </button>
            ))}
          </div>
        </div>

        {filteredFiles.length === 0 ? (
          <div className="px-6 py-10 text-sm text-base-content/55">当前筛选条件下没有认证文件。</div>
        ) : (
          <div className="grid gap-4 p-6 xl:grid-cols-2">
            {filteredFiles.map((file) => {
              const provider = resolveProvider(file)
              const email = normalizeString(file.email)
              const authIndex = resolveAuthIndex(file)
              const runtimeOnly = isRuntimeOnly(file)
              const disabled = isDisabled(file)
              const isExpanded = expandedNames[file.name] === true
              const modelState = modelsState[file.name] ?? { status: 'idle', models: [] }

              return (
                <div key={file.name} className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-lg font-bold">{file.name}</h4>
                        <span className="badge badge-outline">{PROVIDER_LABELS[provider]}</span>
                        {disabled ? <span className="badge badge-warning">disabled</span> : <span className="badge badge-success">active</span>}
                        {runtimeOnly ? <span className="badge badge-neutral">runtime</span> : null}
                      </div>
                      <div className="text-sm text-base-content/70">{email ?? '未记录账号邮箱'}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-outline btn-sm"
                        disabled={!cpaRunning}
                        onClick={() => void toggleModels(file)}
                      >
                        {modelState.status === 'loading' ? <span className="loading loading-spinner loading-xs"></span> : null}
                        {isExpanded ? '收起模型' : '查看模型'}
                      </button>
                      <button
                        className={`btn btn-sm ${disabled ? 'btn-primary' : 'btn-outline btn-warning'}`}
                        disabled={!cpaRunning || togglingName === file.name}
                        onClick={() => void toggleFileStatus(file)}
                      >
                        {togglingName === file.name ? (
                          <span className="loading loading-spinner loading-xs"></span>
                        ) : null}
                        {disabled ? '启用' : '禁用'}
                      </button>
                      <button
                        className="btn btn-outline btn-error btn-sm"
                        disabled={!cpaRunning || deletingName === file.name}
                        onClick={() => setConfirmDeleteFile(file)}
                      >
                        {deletingName === file.name ? <span className="loading loading-spinner loading-xs"></span> : null}
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-box bg-base-200/70 px-4 py-3">
                      <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-base-content/50">
                        <span>Auth Index</span>
                        {authIndex !== '-' ? (
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => void copyText(authIndex, onNotify, onError)}
                          >
                            复制
                          </button>
                        ) : null}
                      </div>
                      <div className="mt-1 font-mono text-sm">{authIndex}</div>
                    </div>
                    <div className="rounded-box bg-base-200/70 px-4 py-3">
                      <div className="text-xs uppercase tracking-wide text-base-content/50">Provider</div>
                      <div className="mt-1 text-sm font-medium">{PROVIDER_LABELS[provider]}</div>
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="mt-4 rounded-box border border-base-300 bg-base-200/40 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-semibold">支持模型</div>
                        {modelState.status === 'success' ? (
                          <span className="badge badge-outline badge-sm">{modelState.models.length} 个</span>
                        ) : null}
                      </div>

                      {modelState.status === 'loading' ? (
                        <div className="flex items-center gap-3 rounded-box bg-base-100 px-4 py-4">
                          <span className="loading loading-spinner loading-sm" />
                          <span className="text-sm text-base-content/70">正在读取模型列表...</span>
                        </div>
                      ) : modelState.status === 'error' ? (
                        <div className="alert alert-error py-3">
                          <span>{modelState.error ?? '读取模型失败'}</span>
                        </div>
                      ) : modelState.status === 'success' && modelState.models.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {modelState.models.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              className="badge badge-outline badge-lg max-w-full truncate cursor-copy"
                              title={`点击复制 ${model.id}`}
                              onClick={() =>
                                void copyText(model.id, onNotify, onError)
                              }
                            >
                              {model.display_name?.trim() || model.id}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-base-content/55">当前没有返回模型列表。</div>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <dialog className={`modal ${confirmDeleteFile ? 'modal-open' : ''}`}>
        <div className="modal-box">
          <h3 className="text-lg font-bold">确认删除认证文件</h3>
          <p className="py-3 text-sm text-base-content/70">
            {confirmDeleteFile
              ? `确定要删除本地认证文件 “${confirmDeleteFile.name}” 吗？此操作会直接从 CPA 本地认证目录移除。`
              : ''}
          </p>
          <div className="modal-action">
            <button className="btn" onClick={() => setConfirmDeleteFile(null)}>
              取消
            </button>
            <button
              className="btn btn-error"
              disabled={!confirmDeleteFile || deletingName === confirmDeleteFile.name}
              onClick={() => {
                if (confirmDeleteFile) {
                  void deleteLocalFile(confirmDeleteFile)
                }
              }}
            >
              {confirmDeleteFile && deletingName === confirmDeleteFile.name ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : null}
              确认删除
            </button>
          </div>
        </div>
        <div className="modal-backdrop" onClick={() => setConfirmDeleteFile(null)} />
      </dialog>

      <dialog className={`modal ${confirmDeletePersonalCloudFile ? 'modal-open' : ''}`}>
        <div className="modal-box">
          <h3 className="text-lg font-bold">确认删除个人云认证</h3>
          <p className="py-3 text-sm text-base-content/70">
            {confirmDeletePersonalCloudFile
              ? `确定要删除个人云认证文件 “${confirmDeletePersonalCloudFile.displayName || confirmDeletePersonalCloudFile.fileName}” 吗？同名再次上传时会重新覆盖创建。`
              : ''}
          </p>
          <div className="modal-action">
            <button className="btn" onClick={() => setConfirmDeletePersonalCloudFile(null)}>
              取消
            </button>
            <button
              className="btn btn-error"
              disabled={!confirmDeletePersonalCloudFile || cloudDeletingId === confirmDeletePersonalCloudFile.id}
              onClick={() => confirmDeletePersonalCloudFile && void deletePersonalCloudFile(confirmDeletePersonalCloudFile)}
            >
              {confirmDeletePersonalCloudFile && cloudDeletingId === confirmDeletePersonalCloudFile.id ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : null}
              确认删除
            </button>
          </div>
        </div>
      </dialog>

      

      <dialog className={`modal ${confirmClearPersonalCloud ? 'modal-open' : ''}`}>
        <div className="modal-box">
          <h3 className="text-lg font-bold">确认清空个人云认证</h3>
          <p className="py-3 text-sm text-base-content/70">此操作会删除当前账号上传到云端的全部认证文件。</p>
          <div className="modal-action">
            <button className="btn" onClick={() => setConfirmClearPersonalCloud(false)}>
              取消
            </button>
            <button
              className="btn btn-error"
              disabled={clearingPersonalCloud}
              onClick={() => void clearPersonalCloudFiles()}
            >
              {clearingPersonalCloud ? <span className="loading loading-spinner loading-xs"></span> : null}
              确认删除
            </button>
          </div>
        </div>
      </dialog>

      
    </div>
  )
}
