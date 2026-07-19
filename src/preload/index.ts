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
  ConnectionEnvironment,
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryResult,
  SavedConnection,
  SchemaRefreshEvent,
  TestResult
} from '../shared/db'
import type { IpcInvokeContract, IpcPushContract } from '../shared/ipc'
import type { McpServerConfig, McpServerStatus } from '../shared/mcp'
import type { SchemaSelectionConfig } from '../shared/schemaSelection'
import type { AppSettingsInfo, ChangeSqlDirResult } from '../shared/settings'
import type {
  KnowledgeBase,
  KnowledgeBaseSummary,
  KnowledgeChangeEvent,
  KnowledgeLink,
  KnowledgeLinkInput,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeTargetGroup
} from '../shared/knowledge'
import type { Skill, SkillSaveInput } from '../shared/skills'
import type { FileKind, QueryFile } from '../shared/files'
import type {
  MonorepoCreateInput,
  MonorepoCreateResult,
  MonorepoPick,
  RepoStatus
} from '../shared/repo'
import type { ChooseExportResult, DataExportFormat, WriteExportResult } from '../shared/export'

/**
 * The renderer end of the IPC bridge, typed against the contract in
 * src/shared/ipc.ts: channel names, argument tuples, and results are all
 * compile-checked, so this file cannot drift from what main registers.
 */

/** `ipcRenderer.invoke` with channel, args, and result from the contract. */
const typedInvoke = <C extends keyof IpcInvokeContract>(
  channel: C,
  ...args: IpcInvokeContract[C]['args']
): Promise<IpcInvokeContract[C]['result']> => ipcRenderer.invoke(channel, ...args)

/**
 * Subscribe to a main → renderer push channel; returns the unsubscribe
 * function every `on*` bridge method hands the renderer.
 */
const typedOn = <C extends keyof IpcPushContract>(
  channel: C,
  listener: (...payload: IpcPushContract[C]) => void
): (() => void) => {
  const wrapped = (_event: IpcRendererEvent, ...payload: unknown[]): void =>
    listener(...(payload as IpcPushContract[C]))
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

/** `ipcRenderer.send` for the renderer → main fire-and-forget channels. */
const typedSend = <C extends keyof IpcPushContract>(
  channel: C,
  ...payload: IpcPushContract[C]
): void => ipcRenderer.send(channel, ...payload)

const api = Object.freeze({
  appName: 'DB Desk',
  db: Object.freeze({
    test: (params: ConnectParams): Promise<DbResult<TestResult>> => typedInvoke('db:test', params),
    connect: (connId: string, params: ConnectParams): Promise<DbResult<ConnectResult>> =>
      typedInvoke('db:connect', connId, params),
    connectSaved: (connId: string): Promise<DbResult<ConnectResult>> =>
      typedInvoke('db:connectSaved', connId),
    introspect: (connId: string, database: string): Promise<DbResult<DatabaseIntrospection>> =>
      typedInvoke('db:introspect', connId, database),
    disconnect: (connId: string): Promise<DbResult<null>> => typedInvoke('db:disconnect', connId),
    query: (
      connId: string,
      database: string,
      sql: string,
      limit: number | null
    ): Promise<DbResult<QueryResult>> => typedInvoke('db:query', connId, database, sql, limit),
    queryForExport: (
      connId: string,
      database: string,
      sql: string
    ): Promise<DbResult<QueryResult>> => typedInvoke('db:queryForExport', connId, database, sql),
    /** Schema names of one database, unfiltered (feeds the schema picker). */
    listSchemas: (connId: string, database: string): Promise<DbResult<string[]>> =>
      typedInvoke('db:listSchemas', connId, database),
    /** All catalogs reachable from a connection, unfiltered. */
    listCatalogs: (connId: string): Promise<DbResult<string[]>> =>
      typedInvoke('db:listCatalogs', connId),
    /**
     * Subscribe to background schema-revalidation pushes (validating/ok/
     * error per database); returns an unsubscribe function.
     */
    onSchemaRefresh: (callback: (evt: SchemaRefreshEvent) => void): (() => void) =>
      typedOn('db:schema-refresh', callback)
  }),
  exportFile: Object.freeze({
    choose: (suggestedName: string, format: DataExportFormat): Promise<ChooseExportResult> =>
      typedInvoke('export:choose', suggestedName, format),
    write: (token: string, contents: string): Promise<WriteExportResult> =>
      typedInvoke('export:write', token, contents),
    discard: (token: string): Promise<void> => typedInvoke('export:discard', token)
  }),
  store: Object.freeze({
    list: (): Promise<SavedConnection[]> => typedInvoke('store:list'),
    save: (
      id: string,
      name: string,
      params: ConnectParams,
      savePassword: boolean
    ): Promise<SavedConnection> => typedInvoke('store:save', id, name, params, savePassword),
    delete: (id: string): Promise<void> => typedInvoke('store:delete', id),
    // --- Schema/catalog pinning (Databricks) ---
    getSchemaConfig: (id: string): Promise<SchemaSelectionConfig> =>
      typedInvoke('store:getSchemaConfig', id),
    setSchemaConfig: (id: string, config: SchemaSelectionConfig): Promise<void> =>
      typedInvoke('store:setSchemaConfig', id, config),
    setCatalogSelection: (id: string, catalogs: string[] | null): Promise<void> =>
      typedInvoke('store:setCatalogSelection', id, catalogs),
    setSchemaSelection: (id: string, catalog: string, schemas: string[] | null): Promise<void> =>
      typedInvoke('store:setSchemaSelection', id, catalog, schemas),
    /** Fill in the environment on a connection saved before this field existed. */
    setEnvironment: (id: string, environment: ConnectionEnvironment): Promise<boolean> =>
      typedInvoke('store:setEnvironment', id, environment)
  }),
  files: Object.freeze({
    list: (): Promise<QueryFile[]> => typedInvoke('files:list'),
    create: (connId: string, database: string | null, kind: FileKind = 'sql'): Promise<QueryFile> =>
      typedInvoke('files:create', connId, database, kind),
    reassign: (id: string, connId: string, database: string | null): Promise<QueryFile> =>
      typedInvoke('files:reassign', id, connId, database),
    read: (id: string): Promise<string> => typedInvoke('files:read', id),
    save: (id: string, content: string): Promise<void> => typedInvoke('files:save', id, content),
    rename: (id: string, name: string): Promise<QueryFile> => typedInvoke('files:rename', id, name),
    delete: (id: string): Promise<void> => typedInvoke('files:delete', id),
    getNextName: (connId: string | null, database: string | null): Promise<string> =>
      typedInvoke('files:getNextName', connId, database),
    deleteForConnection: (connId: string): Promise<void> =>
      typedInvoke('files:deleteForConnection', connId)
  }),
  settings: Object.freeze({
    get: (): Promise<AppSettingsInfo> => typedInvoke('settings:get'),
    /** Directory picker + move; resolves after the files are relocated. */
    chooseSqlDir: (): Promise<ChangeSqlDirResult> => typedInvoke('settings:chooseSqlDir'),
    setApiKeyVar: (name: string): Promise<AppSettingsInfo> =>
      typedInvoke('settings:setApiKeyVar', name),
    setStoredApiKey: (key: string, label: string): Promise<AppSettingsInfo> =>
      typedInvoke('settings:setStoredApiKey', key, label),
    clearStoredApiKey: (): Promise<AppSettingsInfo> => typedInvoke('settings:clearStoredApiKey'),
    /** Subscribe to settings-change pushes; returns an unsubscribe function. */
    onChanged: (callback: () => void): (() => void) => typedOn('settings:changed', callback)
  }),
  mcp: Object.freeze({
    list: (): Promise<McpServerStatus[]> => typedInvoke('mcp:list'),
    save: (config: McpServerConfig): Promise<McpServerStatus[]> => typedInvoke('mcp:save', config),
    delete: (id: string): Promise<McpServerStatus[]> => typedInvoke('mcp:delete', id),
    restart: (id: string): Promise<McpServerStatus[]> => typedInvoke('mcp:restart', id),
    /** Subscribe to server status pushes; returns an unsubscribe function. */
    onChanged: (callback: (statuses: McpServerStatus[]) => void): (() => void) =>
      typedOn('mcp:changed', callback)
  }),
  knowledge: Object.freeze({
    // --- Bases: free-standing named record collections ---
    listBases: (): Promise<KnowledgeBaseSummary[]> => typedInvoke('knowledge:listBases'),
    createBase: (name: string): Promise<KnowledgeBase> => typedInvoke('knowledge:createBase', name),
    renameBase: (kbId: string, name: string): Promise<KnowledgeBase> =>
      typedInvoke('knowledge:renameBase', kbId, name),
    /** Deletes the base's records and every link pointing at it. */
    deleteBase: (kbId: string): Promise<void> => typedInvoke('knowledge:deleteBase', kbId),
    // --- Links: base ↔ (connection, database[, schema]) attachments ---
    listLinks: (): Promise<KnowledgeLink[]> => typedInvoke('knowledge:listLinks'),
    addLink: (input: KnowledgeLinkInput): Promise<KnowledgeLink> =>
      typedInvoke('knowledge:addLink', input),
    removeLink: (linkId: string): Promise<void> => typedInvoke('knowledge:removeLink', linkId),
    // --- Records ---
    list: (kbId: string): Promise<KnowledgeRecord[]> => typedInvoke('knowledge:list', kbId),
    /** Every base linked to the target, with its link and records. */
    listForTarget: (connId: string, database: string): Promise<KnowledgeTargetGroup[]> =>
      typedInvoke('knowledge:listForTarget', connId, database),
    save: (kbId: string, record: KnowledgeRecordInput): Promise<KnowledgeRecord> =>
      typedInvoke('knowledge:save', kbId, record),
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
      typedInvoke('knowledge:saveExemplar', kbId, connId, database, question, sql),
    remove: (kbId: string, id: string): Promise<void> => typedInvoke('knowledge:delete', kbId, id),
    /**
     * Subscribe to record-change pushes; the change names the base and every
     * target linked to it. Returns an unsubscribe function.
     */
    onChanged: (callback: (change: KnowledgeChangeEvent) => void): (() => void) =>
      typedOn('knowledge:changed', callback),
    /**
     * Subscribe to structural pushes (base created/renamed/deleted, link
     * added/removed); reload base/link state on each. Returns an unsubscribe
     * function.
     */
    onStructureChanged: (callback: () => void): (() => void) =>
      typedOn('knowledge:structureChanged', callback)
  }),
  skills: Object.freeze({
    list: (): Promise<Skill[]> => typedInvoke('skills:list'),
    save: (input: SkillSaveInput): Promise<Skill> => typedInvoke('skills:save', input),
    /** For a built-in id this resets it to the installed version. */
    remove: (id: string): Promise<void> => typedInvoke('skills:delete', id),
    /** Subscribe to skills-change pushes; returns an unsubscribe function. */
    onChanged: (callback: () => void): (() => void) => typedOn('skills:changed', callback)
  }),
  repo: Object.freeze({
    get: (kbId: string): Promise<RepoStatus> => typedInvoke('repo:get', kbId),
    choose: (kbId: string): Promise<RepoStatus> => typedInvoke('repo:choose', kbId),
    clear: (kbId: string): Promise<RepoStatus> => typedInvoke('repo:clear', kbId),
    /** Opens the monorepo-root picker; null when the user cancels. */
    monorepoPick: (): Promise<MonorepoPick | null> => typedInvoke('repo:monorepoPick'),
    monorepoCreate: (input: MonorepoCreateInput): Promise<MonorepoCreateResult> =>
      typedInvoke('repo:monorepoCreate', input)
  }),
  agent: Object.freeze({
    keyStatus: (): Promise<AgentKeyStatus> => typedInvoke('agent:keyStatus'),
    send: (req: AgentSendRequest): Promise<void> => typedInvoke('agent:send', req),
    stop: (chatId: string): Promise<void> => typedInvoke('agent:stop', chatId),
    reset: (chatId: string): Promise<void> => typedInvoke('agent:reset', chatId),
    /** Replace the chat history with a model-written summary (/compact). */
    compact: (chatId: string, model: string): Promise<AgentCompactResult> =>
      typedInvoke('agent:compact', chatId, model),
    /**
     * Provide live editor state for the agent's read_editor tool. `provide`
     * runs once per request and the result is sent straight back to main;
     * a thrown provider degrades to "editor unavailable" rather than leaving
     * the request to time out. Returns an unsubscribe function.
     */
    onEditorRead: (provide: () => AgentEditorReadPayload): (() => void) =>
      typedOn('agent:editor-read', (requestId) => {
        let payload: AgentEditorReadPayload
        try {
          payload = provide()
        } catch {
          payload = { editor: null, selection: null }
        }
        typedSend('agent:editor-read-reply', requestId, payload)
      }),
    /** Subscribe to agent progress events; returns an unsubscribe function. */
    onEvent: (callback: (evt: AgentEvent) => void): (() => void) => typedOn('agent:event', callback)
  })
})

contextBridge.exposeInMainWorld('dbDesk', api)

export type DbDeskApi = typeof api
