import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import type {
  AgentCompactResult,
  AgentEditorReadPayload,
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
import type { SchemaSelectionConfig } from '../shared/schemaSelection'
import type { AppSettingsInfo, ChangeSqlDirResult } from '../shared/settings'
import type {
  KnowledgeBase,
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeLinkInput,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeTargetGroup
} from '../shared/knowledge'
import type { Skill, SkillSaveInput } from '../shared/skills'
import type { FileKind } from '../shared/files'
import type { RepoStatus } from '../shared/repo'
import type {
  ChooseExportResult,
  DataExportFormat,
  WriteExportResult
} from '../shared/export'

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
      ipcRenderer.invoke('db:query', connId, database, sql, limit),
    queryForExport: (
      connId: string,
      database: string,
      sql: string
    ): Promise<DbResult<QueryResult>> =>
      ipcRenderer.invoke('db:queryForExport', connId, database, sql),
    /** Schema names of one database, unfiltered (feeds the schema picker). */
    listSchemas: (
      connId: string,
      database: string
    ): Promise<DbResult<string[]>> =>
      ipcRenderer.invoke('db:listSchemas', connId, database),
    /** All catalogs reachable from a connection, unfiltered. */
    listCatalogs: (connId: string): Promise<DbResult<string[]>> =>
      ipcRenderer.invoke('db:listCatalogs', connId)
  }),
  exportFile: Object.freeze({
    choose: (
      suggestedName: string,
      format: DataExportFormat
    ): Promise<ChooseExportResult> =>
      ipcRenderer.invoke('export:choose', suggestedName, format),
    write: (token: string, contents: string): Promise<WriteExportResult> =>
      ipcRenderer.invoke('export:write', token, contents),
    discard: (token: string): Promise<void> =>
      ipcRenderer.invoke('export:discard', token)
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
      ipcRenderer.invoke('store:delete', id),
    // --- Schema/catalog pinning (Databricks) ---
    getSchemaConfig: (id: string): Promise<SchemaSelectionConfig> =>
      ipcRenderer.invoke('store:getSchemaConfig', id),
    setCatalogSelection: (
      id: string,
      catalogs: string[] | null
    ): Promise<void> =>
      ipcRenderer.invoke('store:setCatalogSelection', id, catalogs),
    setSchemaSelection: (
      id: string,
      catalog: string,
      schemas: string[] | null
    ): Promise<void> =>
      ipcRenderer.invoke('store:setSchemaSelection', id, catalog, schemas)
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
      connId: string,
      database: string | null,
      kind: FileKind = 'sql'
    ): Promise<{
      id: string
      name: string
      connId: string | null
      database: string | null
      createdAt: number
      updatedAt: number
    }> => ipcRenderer.invoke('files:create', connId, database, kind),
    reassign: (
      id: string,
      connId: string,
      database: string | null
    ): Promise<{
      id: string
      name: string
      connId: string | null
      database: string | null
      createdAt: number
      updatedAt: number
    }> => ipcRenderer.invoke('files:reassign', id, connId, database),
    read: (id: string): Promise<string> => ipcRenderer.invoke('files:read', id),
    save: (id: string, content: string): Promise<void> =>
      ipcRenderer.invoke('files:save', id, content),
    rename: (
      id: string,
      name: string
    ): Promise<{
      id: string
      name: string
      connId: string | null
      database: string | null
      createdAt: number
      updatedAt: number
    }> => ipcRenderer.invoke('files:rename', id, name),
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
  settings: Object.freeze({
    get: (): Promise<AppSettingsInfo> => ipcRenderer.invoke('settings:get'),
    /** Directory picker + move; resolves after the files are relocated. */
    chooseSqlDir: (): Promise<ChangeSqlDirResult> =>
      ipcRenderer.invoke('settings:chooseSqlDir'),
    setApiKeyVar: (name: string): Promise<AppSettingsInfo> =>
      ipcRenderer.invoke('settings:setApiKeyVar', name),
    setStoredApiKey: (key: string, label: string): Promise<AppSettingsInfo> =>
      ipcRenderer.invoke('settings:setStoredApiKey', key, label),
    clearStoredApiKey: (): Promise<AppSettingsInfo> =>
      ipcRenderer.invoke('settings:clearStoredApiKey'),
    /** Subscribe to settings-change pushes; returns an unsubscribe function. */
    onChanged: (callback: () => void): (() => void) => {
      const listener = (_event: IpcRendererEvent): void => callback()
      ipcRenderer.on('settings:changed', listener)
      return () => {
        ipcRenderer.removeListener('settings:changed', listener)
      }
    }
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
    // --- Bases: free-standing named record collections ---
    listBases: (): Promise<KnowledgeBaseSummary[]> =>
      ipcRenderer.invoke('knowledge:listBases'),
    createBase: (name: string): Promise<KnowledgeBase> =>
      ipcRenderer.invoke('knowledge:createBase', name),
    renameBase: (kbId: string, name: string): Promise<KnowledgeBase> =>
      ipcRenderer.invoke('knowledge:renameBase', kbId, name),
    /** Deletes the base's records and every link pointing at it. */
    deleteBase: (kbId: string): Promise<void> =>
      ipcRenderer.invoke('knowledge:deleteBase', kbId),
    // --- Links: base ↔ (connection, database[, schema]) attachments ---
    listLinks: (): Promise<KnowledgeLink[]> =>
      ipcRenderer.invoke('knowledge:listLinks'),
    addLink: (input: KnowledgeLinkInput): Promise<KnowledgeLink> =>
      ipcRenderer.invoke('knowledge:addLink', input),
    removeLink: (linkId: string): Promise<void> =>
      ipcRenderer.invoke('knowledge:removeLink', linkId),
    // --- Records ---
    list: (kbId: string): Promise<KnowledgeRecord[]> =>
      ipcRenderer.invoke('knowledge:list', kbId),
    /** Every base linked to the target, with its link and records. */
    listForTarget: (
      connId: string,
      database: string
    ): Promise<KnowledgeTargetGroup[]> =>
      ipcRenderer.invoke('knowledge:listForTarget', connId, database),
    save: (
      kbId: string,
      record: KnowledgeRecordInput
    ): Promise<KnowledgeRecord> =>
      ipcRenderer.invoke('knowledge:save', kbId, record),
    /**
     * Save a question→SQL exemplar into a base; the main process extracts the
     * SQL's structured references at save time (against the live connection)
     * so it participates in usage lookups. A null kbId creates and links a
     * base for the target (scoped to the schema the SQL references).
     */
    saveExemplar: (
      kbId: string | null,
      connId: string,
      database: string,
      question: string,
      sql: string
    ): Promise<KnowledgeRecord> =>
      ipcRenderer.invoke(
        'knowledge:saveExemplar',
        kbId,
        connId,
        database,
        question,
        sql
      ),
    remove: (kbId: string, id: string): Promise<void> =>
      ipcRenderer.invoke('knowledge:delete', kbId, id),
    /**
     * Subscribe to record-change pushes; the change names the base and every
     * target linked to it. Returns an unsubscribe function.
     */
    onChanged: (
      callback: (change: {
        kbId: string
        targets: Array<{ connId: string; database: string }>
      }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        change: {
          kbId: string
          targets: Array<{ connId: string; database: string }>
        }
      ): void => callback(change)
      ipcRenderer.on('knowledge:changed', listener)
      return () => {
        ipcRenderer.removeListener('knowledge:changed', listener)
      }
    },
    /**
     * Subscribe to structural pushes (base created/renamed/deleted, link
     * added/removed); reload base/link state on each. Returns an unsubscribe
     * function.
     */
    onStructureChanged: (callback: () => void): (() => void) => {
      const listener = (_event: IpcRendererEvent): void => callback()
      ipcRenderer.on('knowledge:structureChanged', listener)
      return () => {
        ipcRenderer.removeListener('knowledge:structureChanged', listener)
      }
    }
  }),
  skills: Object.freeze({
    list: (): Promise<Skill[]> => ipcRenderer.invoke('skills:list'),
    save: (input: SkillSaveInput): Promise<Skill> =>
      ipcRenderer.invoke('skills:save', input),
    /** For a built-in id this resets it to the installed version. */
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke('skills:delete', id),
    /** Subscribe to skills-change pushes; returns an unsubscribe function. */
    onChanged: (callback: () => void): (() => void) => {
      const listener = (_event: IpcRendererEvent): void => callback()
      ipcRenderer.on('skills:changed', listener)
      return () => {
        ipcRenderer.removeListener('skills:changed', listener)
      }
    }
  }),
  repo: Object.freeze({
    get: (kbId: string): Promise<RepoStatus> =>
      ipcRenderer.invoke('repo:get', kbId),
    choose: (kbId: string): Promise<RepoStatus> =>
      ipcRenderer.invoke('repo:choose', kbId),
    clear: (kbId: string): Promise<RepoStatus> =>
      ipcRenderer.invoke('repo:clear', kbId)
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
    /**
     * Provide live editor state for the agent's read_editor tool. `provide`
     * runs once per request and the result is sent straight back to main;
     * a thrown provider degrades to "editor unavailable" rather than leaving
     * the request to time out. Returns an unsubscribe function.
     */
    onEditorRead: (provide: () => AgentEditorReadPayload): (() => void) => {
      const listener = (_event: IpcRendererEvent, requestId: string): void => {
        let payload: AgentEditorReadPayload
        try {
          payload = provide()
        } catch {
          payload = { editor: null, selection: null }
        }
        ipcRenderer.send('agent:editor-read-reply', requestId, payload)
      }
      ipcRenderer.on('agent:editor-read', listener)
      return () => {
        ipcRenderer.removeListener('agent:editor-read', listener)
      }
    },
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
