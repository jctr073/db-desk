import { contextBridge, ipcRenderer } from 'electron'

import type {
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  TestResult
} from '../shared/db'

const api = Object.freeze({
  appName: 'DB Desk',
  db: Object.freeze({
    test: (params: ConnectParams): Promise<DbResult<TestResult>> =>
      ipcRenderer.invoke('db:test', params),
    connect: (connId: string, params: ConnectParams): Promise<DbResult<ConnectResult>> =>
      ipcRenderer.invoke('db:connect', connId, params),
    introspect: (connId: string, database: string): Promise<DbResult<DatabaseIntrospection>> =>
      ipcRenderer.invoke('db:introspect', connId, database),
    disconnect: (connId: string): Promise<DbResult<null>> =>
      ipcRenderer.invoke('db:disconnect', connId)
  })
})

contextBridge.exposeInMainWorld('dbDesk', api)

export type DbDeskApi = typeof api
