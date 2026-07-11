import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import type {
  AgentCompactResult,
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
import type { McpServerConfig, McpServerStatus } from '../shared/mcp'
import type { KnowledgeRecord, KnowledgeRecordInput } from '../shared/knowledge'

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
  mcp: Object.freeze({
    list: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp:list'),
    save: (config: McpServerConfig): Promise<McpServerStatus[]> =>
      ipcRenderer.invoke('mcp:save', config),
    delete: (id: string): Promise<McpServerStatus[]> =>
      ipcRenderer.invoke('mcp:delete', id),
    restart: (id: string): Promise<McpServerStatus[]> =>
      ipcRenderer.invoke('mcp:restart', id),
    /** Subscribe to server status pushes; returns an unsubscribe function. */
    onChanged: (
      callback: (statuses: McpServerStatus[]) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        statuses: McpServerStatus[]
      ): void => callback(statuses)
      ipcRenderer.on('mcp:changed', listener)
      return () => {
        ipcRenderer.removeListener('mcp:changed', listener)
      }
    }
  }),
  knowledge: Object.freeze({
    list: (connId: string, database: string): Promise<KnowledgeRecord[]> =>
      ipcRenderer.invoke('knowledge:list', connId, database),
    save: (
      connId: string,
      database: string,
      record: KnowledgeRecordInput
    ): Promise<KnowledgeRecord> =>
      ipcRenderer.invoke('knowledge:save', connId, database, record),
    /**
     * Save a question→SQL exemplar; the main process extracts the SQL's
     * structured references at save time so it participates in usage lookups.
     */
    saveExemplar: (
      connId: string,
      database: string,
      question: string,
      sql: string
    ): Promise<KnowledgeRecord> =>
      ipcRenderer.invoke('knowledge:saveExemplar', connId, database, question, sql),
    remove: (connId: string, database: string, id: string): Promise<void> =>
      ipcRenderer.invoke('knowledge:delete', connId, database, id),
    deleteForConnection: (connId: string): Promise<void> =>
      ipcRenderer.invoke('knowledge:deleteForConnection', connId),
    /** Subscribe to knowledge-change pushes; returns an unsubscribe function. */
    onChanged: (
      callback: (change: { connId: string; database: string }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        change: { connId: string; database: string }
      ): void => callback(change)
      ipcRenderer.on('knowledge:changed', listener)
      return () => {
        ipcRenderer.removeListener('knowledge:changed', listener)
      }
    }
  }),
  agent: Object.freeze({
    keyStatus: (): Promise<AgentKeyStatus> =>
      ipcRenderer.invoke('agent:keyStatus'),
    send: (req: AgentSendRequest): Promise<void> =>
      ipcRenderer.invoke('agent:send', req),
    stop: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('agent:stop', chatId),
    reset: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('agent:reset', chatId),
    /** Replace the chat history with a model-written summary (/compact). */
    compact: (chatId: string, model: string): Promise<AgentCompactResult> =>
      ipcRenderer.invoke('agent:compact', chatId, model),
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
