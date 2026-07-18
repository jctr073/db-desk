/**
 * The complete main ↔ renderer IPC contract, in one place. Both sides type
 * their bridge helpers against these interfaces (`typedHandle`/`typedSend` in
 * src/main/ipc.ts, `typedInvoke`/`typedOn` in src/preload/index.ts), so a
 * mistyped or unregistered channel — or a drifted argument/result shape — is
 * a compile error rather than a runtime surprise.
 *
 * Environment-neutral on purpose: type-only imports from the shared wire
 * types, no electron or node imports. Channel names are the runtime strings;
 * renaming one here without renaming every call site is a compile error, not
 * a silent break.
 */

import type {
  AgentCompactResult,
  AgentEditorReadPayload,
  AgentEvent,
  AgentKeyStatus,
  AgentSendRequest
} from './agent'
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
} from './db'
import type { ChooseExportResult, DataExportFormat, WriteExportResult } from './export'
import type { FileKind, QueryFile } from './files'
import type {
  KnowledgeBase,
  KnowledgeBaseSummary,
  KnowledgeChangeEvent,
  KnowledgeLink,
  KnowledgeLinkInput,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeTargetGroup
} from './knowledge'
import type { McpServerConfig, McpServerStatus } from './mcp'
import type { MonorepoCreateInput, MonorepoCreateResult, MonorepoPick, RepoStatus } from './repo'
import type { SchemaSelectionConfig } from './schemaSelection'
import type { AppSettingsInfo, ChangeSqlDirResult } from './settings'
import type { Skill, SkillSaveInput } from './skills'

/**
 * Request/response channels: every `ipcRenderer.invoke` ↔ `ipcMain.handle`
 * pair. `args` is the exact tuple sent over the wire; `result` is what the
 * handler resolves with (the renderer always sees it as a Promise).
 */
export interface IpcInvokeContract {
  // --- Database sessions -------------------------------------------------
  'db:test': { args: [params: ConnectParams]; result: DbResult<TestResult> }
  'db:connect': { args: [connId: string, params: ConnectParams]; result: DbResult<ConnectResult> }
  'db:connectSaved': { args: [connId: string]; result: DbResult<ConnectResult> }
  'db:introspect': {
    args: [connId: string, database: string]
    result: DbResult<DatabaseIntrospection>
  }
  'db:disconnect': { args: [connId: string]; result: DbResult<null> }
  'db:query': {
    args: [connId: string, database: string, sql: string, limit: number | null]
    result: DbResult<QueryResult>
  }
  'db:queryForExport': {
    args: [connId: string, database: string, sql: string]
    result: DbResult<QueryResult>
  }
  'db:listSchemas': { args: [connId: string, database: string]; result: DbResult<string[]> }
  'db:listCatalogs': { args: [connId: string]; result: DbResult<string[]> }

  // --- Result export ------------------------------------------------------
  'export:choose': {
    args: [suggestedName: string, format: DataExportFormat]
    result: ChooseExportResult
  }
  'export:write': { args: [token: string, contents: string]; result: WriteExportResult }
  'export:discard': { args: [token: string]; result: void }

  // --- Saved connections --------------------------------------------------
  'store:list': { args: []; result: SavedConnection[] }
  'store:save': {
    args: [id: string, name: string, params: ConnectParams, savePassword: boolean]
    result: SavedConnection
  }
  'store:delete': { args: [id: string]; result: void }
  'store:getSchemaConfig': { args: [id: string]; result: SchemaSelectionConfig }
  'store:setSchemaConfig': { args: [id: string, config: SchemaSelectionConfig]; result: void }
  'store:setCatalogSelection': { args: [id: string, catalogs: string[] | null]; result: void }
  'store:setEnvironment': {
    args: [id: string, environment: ConnectionEnvironment]
    result: boolean
  }
  'store:setSchemaSelection': {
    args: [id: string, catalog: string, schemas: string[] | null]
    result: void
  }

  // --- Query files ----------------------------------------------------------
  'files:list': { args: []; result: QueryFile[] }
  'files:create': {
    args: [connId: string, database: string | null, kind: FileKind]
    result: QueryFile
  }
  'files:reassign': {
    args: [id: string, connId: string, database: string | null]
    result: QueryFile
  }
  'files:read': { args: [id: string]; result: string }
  'files:save': { args: [id: string, content: string]; result: void }
  'files:rename': { args: [id: string, name: string]; result: QueryFile }
  'files:delete': { args: [id: string]; result: void }
  'files:getNextName': { args: [connId: string | null, database: string | null]; result: string }
  'files:deleteForConnection': { args: [connId: string]; result: void }

  // --- App settings ---------------------------------------------------------
  'settings:get': { args: []; result: AppSettingsInfo }
  'settings:chooseSqlDir': { args: []; result: ChangeSqlDirResult }
  'settings:setApiKeyVar': { args: [name: string]; result: AppSettingsInfo }
  'settings:setStoredApiKey': { args: [key: string, label: string]; result: AppSettingsInfo }
  'settings:clearStoredApiKey': { args: []; result: AppSettingsInfo }

  // --- MCP servers ----------------------------------------------------------
  'mcp:list': { args: []; result: McpServerStatus[] }
  'mcp:save': { args: [config: McpServerConfig]; result: McpServerStatus[] }
  'mcp:delete': { args: [id: string]; result: McpServerStatus[] }
  'mcp:restart': { args: [id: string]; result: McpServerStatus[] }

  // --- Knowledge bases, links, records --------------------------------------
  'knowledge:listBases': { args: []; result: KnowledgeBaseSummary[] }
  'knowledge:createBase': { args: [name: string]; result: KnowledgeBase }
  'knowledge:renameBase': { args: [kbId: string, name: string]; result: KnowledgeBase }
  'knowledge:deleteBase': { args: [kbId: string]; result: void }
  'knowledge:listLinks': { args: []; result: KnowledgeLink[] }
  'knowledge:addLink': { args: [input: KnowledgeLinkInput]; result: KnowledgeLink }
  'knowledge:removeLink': { args: [linkId: string]; result: void }
  'knowledge:list': { args: [kbId: string]; result: KnowledgeRecord[] }
  'knowledge:listForTarget': {
    args: [connId: string, database: string]
    result: KnowledgeTargetGroup[]
  }
  'knowledge:save': { args: [kbId: string, record: KnowledgeRecordInput]; result: KnowledgeRecord }
  'knowledge:saveExemplar': {
    args: [kbId: string | null, connId: string, database: string, question: string, sql: string]
    result: KnowledgeRecord
  }
  'knowledge:delete': { args: [kbId: string, id: string]; result: void }

  // --- Skills ---------------------------------------------------------------
  'skills:list': { args: []; result: Skill[] }
  'skills:save': { args: [input: SkillSaveInput]; result: Skill }
  'skills:delete': { args: [id: string]; result: void }

  // --- Repository attachment ------------------------------------------------
  'repo:get': { args: [kbId: string]; result: RepoStatus }
  'repo:choose': { args: [kbId: string]; result: RepoStatus }
  'repo:clear': { args: [kbId: string]; result: RepoStatus }
  'repo:monorepoPick': { args: []; result: MonorepoPick | null }
  'repo:monorepoCreate': { args: [input: MonorepoCreateInput]; result: MonorepoCreateResult }

  // --- Agent ----------------------------------------------------------------
  'agent:keyStatus': { args: []; result: AgentKeyStatus }
  'agent:send': { args: [req: AgentSendRequest]; result: void }
  'agent:stop': { args: [chatId: string]; result: void }
  'agent:reset': { args: [chatId: string]; result: void }
  'agent:compact': { args: [chatId: string, model: string]; result: AgentCompactResult }
}

/**
 * Fire-and-forget channels: each entry is the payload tuple. All are
 * main → renderer pushes (`webContents.send` ↔ `ipcRenderer.on`), with one
 * exception noted inline: `agent:editor-read-reply` is the renderer → main
 * reply leg of the `agent:editor-read` round-trip (`ipcRenderer.send` ↔
 * `ipcMain.on`).
 */
export interface IpcPushContract {
  /** Background schema-revalidation progress for one database. */
  'db:schema-refresh': [evt: SchemaRefreshEvent]
  /** Some app setting changed; renderers re-fetch via settings:get. */
  'settings:changed': []
  /** MCP server list or state changed; carries the fresh statuses. */
  'mcp:changed': [statuses: McpServerStatus[]]
  /** Records changed in one base; names the base and its linked targets. */
  'knowledge:changed': [change: KnowledgeChangeEvent]
  /** Bases or links changed shape; renderer reloads base/link state. */
  'knowledge:structureChanged': []
  /** The skill set changed; renderer re-fetches via skills:list. */
  'skills:changed': []
  /** One agent progress event for a running turn. */
  'agent:event': [evt: AgentEvent]
  /** Main asks the renderer for live editor state (read_editor tool). */
  'agent:editor-read': [requestId: string]
  /** Renderer → main: the reply to a matching agent:editor-read request. */
  'agent:editor-read-reply': [requestId: string, payload: AgentEditorReadPayload]
}
