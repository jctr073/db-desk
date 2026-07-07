import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import type {
  AgentEvent,
  AgentKeyStatus,
  AgentSendRequest
} from '../shared/agent'
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
  }),
  files: Object.freeze({
    list: (): Promise<
      Array<{
        id: string
        name: string
        connId: string | null
        database: string | null
        createdAt: number
        updatedAt: number
      }>
    > => ipcRenderer.invoke('files:list'),
    create: (
      connId: string | null,
      database: string | null
    ): Promise<{
      id: string
      name: string
      connId: string | null
      database: string | null
      createdAt: number
      updatedAt: number
    }> => ipcRenderer.invoke('files:create', connId, database),
    read: (id: string): Promise<string> => ipcRenderer.invoke('files:read', id),
    save: (id: string, content: string): Promise<void> =>
      ipcRenderer.invoke('files:save', id, content),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke('files:delete', id),
    getNextName: (
      connId: string | null,
      database: string | null
    ): Promise<string> =>
      ipcRenderer.invoke('files:getNextName', connId, database),
    deleteForConnection: (connId: string): Promise<void> =>
      ipcRenderer.invoke('files:deleteForConnection', connId)
  }),
  agent: Object.freeze({
    keyStatus: (): Promise<AgentKeyStatus> =>
      ipcRenderer.invoke('agent:keyStatus'),
    send: (req: AgentSendRequest): Promise<void> =>
      ipcRenderer.invoke('agent:send', req),
    /** Answer a pending approval_request for a data-modifying statement. */
    approve: (
      chatId: string,
      toolId: string,
      approved: boolean
    ): Promise<void> =>
      ipcRenderer.invoke('agent:approve', chatId, toolId, approved),
    stop: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('agent:stop', chatId),
    reset: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('agent:reset', chatId),
    /** Subscribe to agent progress events; returns an unsubscribe function. */
    onEvent: (callback: (evt: AgentEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, evt: AgentEvent): void =>
        callback(evt)
      ipcRenderer.on('agent:event', listener)
      return () => {
        ipcRenderer.removeListener('agent:event', listener)
      }
    }
  })
})

contextBridge.exposeInMainWorld('dbDesk', api)

export type DbDeskApi = typeof api
