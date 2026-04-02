const STORAGE_KEY = 'cpapp-shared-cloud-imports'

export interface SharedImportRecord {
  cloudFileId: number
  localFileName: string
  downloadedAt: string
  planRequired: string | null
}

function readAll(): SharedImportRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(records: SharedImportRecord[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

export const sharedImportRegistry = {
  list(): SharedImportRecord[] {
    return readAll()
  },

  upsert(record: SharedImportRecord) {
    const current = readAll().filter((item) => item.localFileName !== record.localFileName)
    current.push(record)
    writeAll(current)
  },

  removeByLocalFileName(localFileName: string) {
    const next = readAll().filter((item) => item.localFileName !== localFileName)
    writeAll(next)
  }
}
