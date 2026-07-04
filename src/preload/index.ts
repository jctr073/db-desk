import { contextBridge, ipcRenderer } from 'electron'

import type {
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryResult,
  SavedConnection,
  TestResult
} from '../shared/db'

const api = Object.freeze({
  appName: 'DB Desk',
  db: Object.freeze({
    test: (params: ConnectParams): Promise<DbResult<TestResult>> =>
      ipcRenderer.invoke('db:test', params),
    connect: (
      connId: string,
      params: ConnectParams
    ): Promise<DbResult<ConnectResult>> =>
      ipcRenderer.invoke('db:connect', connId, params),
    connectSaved: (connId: string): Promise<DbResult<ConnectResult>> =>
      ipcRenderer.invoke('db:connectSaved', connId),
    introspect: (
      connId: string,
      database: string
    ): Promise<DbResult<DatabaseIntrospection>> =>
      ipcRenderer.invoke('db:introspect', connId, database),
    disconnect: (connId: string): Promise<DbResult<null>> =>
      ipcRenderer.invoke('db:disconnect', connId),
    query: (
      connId: string,
      database: string,
      sql: string,
      limit: number | null
    ): Promise<DbResult<QueryResult>> =>
      ipcRenderer.invoke('db:query', connId, database, sql, limit)
  }),
  store: Object.freeze({
    list: (): Promise<SavedConnection[]> => ipcRenderer.invoke('store:list'),
    save: (
      id: string,
      name: string,
      params: ConnectParams,
      savePassword: boolean
    ): Promise<SavedConnection> =>
      ipcRenderer.invoke('store:save', id, name, params, savePassword),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke('store:delete', id)
  })
})

contextBridge.exposeInMainWorld('dbDesk', api)

export type DbDeskApi = typeof api
