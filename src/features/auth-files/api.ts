import { cpaRuntime } from '../../lib/cpa/runtime'
import type { AuthFileModel, AuthFilesResponse } from './types'

export const authFilesApi = {
  list: () =>
    cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: 'auth-files'
    }) as Promise<AuthFilesResponse>,

  setStatus: (name: string, disabled: boolean) =>
    cpaRuntime.proxyManagementRequest({
      method: 'PATCH',
      path: 'auth-files/status',
      body: { name, disabled }
    }) as Promise<unknown>,

  deleteFile: (name: string) =>
    cpaRuntime.proxyManagementRequest({
      method: 'DELETE',
      path: 'auth-files',
      query: [['name', name]]
    }) as Promise<unknown>,

  getModelsForAuthFile: async (name: string): Promise<AuthFileModel[]> => {
    const response = (await cpaRuntime.proxyManagementRequest({
      method: 'GET',
      path: 'auth-files/models',
      query: [['name', name]]
    })) as Record<string, unknown>

    const models = response?.models
    return Array.isArray(models) ? (models as AuthFileModel[]) : []
  }
}
