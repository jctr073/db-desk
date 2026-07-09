/**
 * Main-process AI agent: owns the Anthropic client, per-chat conversation
 * history, and the streaming tool-use loop. The renderer talks to it through
 * `agent:*` IPC handles and receives progress as `agent:event` pushes.
 *
 * Execution safety model: the user picks an access mode per chat. Metadata
 * Only offers no execution tools at all; Read-Only routes every statement
 * through runAgentQuery — the guarded channel that admits exactly one
 * provably-read statement per call, with the server-side read-only session
 * as a second belt. There is no approval flow: statements that modify data
 * or schema are blocked outright, in every mode.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

import {
  AGENT_BLOCKED_CODE,
  describeTable,
  getConnectionType,
  getServerVersion,
  introspectDatabase,
  isReadOnlyViolation,
  runAgentQuery,
  searchSchema
} from './db'
import type {
  AgentCompactResult,
  AgentEvent,
  AgentKeyStatus,
  AgentMode,
  AgentSendRequest,
  AgentTargetRef
} from '../shared/agent'
import { AGENT_MODELS, API_KEY_VAR, resolveAgentMode } from '../shared/agent'
import type { DatabaseIntrospection, QueryResult } from '../shared/db'
import { dialectFor } from '../shared/dialect'
import type { DialectInfo } from '../shared/dialect'
import { classifyStatement } from '../shared/sql'

/** Rows of a tool-run result forwarded to the model (grid shows the full set). */
const TOOL_RESULT_MAX_ROWS = 50
/** Overall budget for one tool-result payload sent to the model. */
const TOOL_RESULT_MAX_CHARS = 30_000
/** Per-cell cap applied (model copy only) when a payload exceeds the budget. */
const TOOL_RESULT_CELL_CHARS = 400
/** Auto-LIMIT applied to agent-run statements, mirroring the editor default. */
const TOOL_RUN_LIMIT = 500
/** statement_timeout for agent-issued statements. */
const AGENT_STATEMENT_TIMEOUT_MS = 30_000
/** Cap on the schema summary embedded in the system prompt. */
const SCHEMA_SUMMARY_MAX_CHARS = 48_000
/** Cap on web searches the model may run in a single turn. */
const WEB_SEARCH_MAX_USES = 5

interface KeyInfo {
  key: string | null
  source: 'zshrc' | 'env' | null
}

function readKeyFromZshrc(): string | null {
  try {
    const text = readFileSync(join(homedir(), '.zshrc'), 'utf8')
    const re = new RegExp(`^\\s*(?:export\\s+)?${API_KEY_VAR}\\s*=\\s*["']?([^"'\\s#]+)`, 'gm')
    let match: RegExpExecArray | null
    let last: string | null = null
    while ((match = re.exec(text)) !== null) last = match[1]
    return last
  } catch {
    return null
  }
}

/** Re-read on every call so edits to ~/.zshrc apply without an app restart. */
function loadKey(): KeyInfo {
  const fromFile = readKeyFromZshrc()
  if (fromFile) return { key: fromFile, source: 'zshrc' }
  const fromEnv = process.env[API_KEY_VAR]
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return { key: null, source: null }
}

interface ChatState {
  messages: Anthropic.MessageParam[]
  controller: AbortController | null
  /** Cancels the agent's currently running statement, when one is running. */
  cancelRunningQuery: (() => void) | null
}

const chats = new Map<string, ChatState>()

function getChat(chatId: string): ChatState {
  let chat = chats.get(chatId)
  if (!chat) {
    chat = {
      messages: [],
      controller: null,
      cancelRunningQuery: null
    }
    chats.set(chatId, chat)
  }
  return chat
}

/** Schema summaries are reused across turns; introspection can be slow. */
const schemaCache = new Map<string, string>()

function schemaCacheKey(target: AgentTargetRef): string {
  return `${target.connId}/${target.database}`
}

type ColumnLike = {
  name: string
  dataType: string
  badge: 'pk' | 'fk' | null
  fkRef?: string | null
}

function summarizeColumns(cols: ColumnLike[]): string {
  return cols
    .map((c) => {
      const marks: string[] = []
      if (c.badge === 'pk') marks.push('PK')
      if (c.fkRef) marks.push(`FK → ${c.fkRef}`)
      else if (c.badge === 'fk') marks.push('FK')
      return `${c.name} ${c.dataType}${marks.length > 0 ? ` [${marks.join(', ')}]` : ''}`
    })
    .join(', ')
}

/** 'full': types/keys/indexes; 'compact': column names only; 'names': relation names only. */
type SchemaDetail = 'full' | 'compact' | 'names'

function renderSchema(db: DatabaseIntrospection, detail: SchemaDetail): string {
  const lines: string[] = [`Database: ${db.name}`]
  for (const schema of db.schemas) {
    lines.push(`Schema "${schema.name}":`)
    if (detail === 'names') {
      const groups: [string, string[]][] = [
        ['tables', schema.tables.map((t) => t.name)],
        ['views', schema.views.map((v) => v.name)],
        ['materialized views', schema.matviews.map((m) => m.name)],
        ['functions', schema.functions.map((f) => f.name)]
      ]
      for (const [label, names] of groups) {
        if (names.length > 0) lines.push(`  ${label}: ${names.join(', ')}`)
      }
      continue
    }
    const renderRelation = (
      kind: string,
      rel: (typeof schema.tables)[number]
    ): void => {
      const cols =
        detail === 'full'
          ? summarizeColumns(rel.columns)
          : rel.columns.map((c) => c.name).join(', ')
      const rows =
        detail === 'full' && rel.rowEstimate != null && rel.rowEstimate >= 0
          ? ` ~${Math.round(rel.rowEstimate)} rows`
          : ''
      lines.push(`  ${kind} ${schema.name}.${rel.name} (${cols})${rows}`)
      if (detail === 'full' && rel.indexes && rel.indexes.length > 0) {
        lines.push(`    indexes: ${rel.indexes.join('; ')}`)
      }
    }
    for (const t of schema.tables) renderRelation('table', t)
    for (const v of schema.views) renderRelation('view', v)
    for (const m of schema.matviews) renderRelation('materialized view', m)
    for (const f of schema.functions) {
      lines.push(
        detail === 'full'
          ? `  function ${schema.name}.${f.name}(${f.args}) -> ${f.returnType}`
          : `  function ${schema.name}.${f.name}`
      )
    }
    if (schema.types.length > 0) {
      lines.push(
        `  types: ${schema.types
          .map((t) =>
            detail === 'full' && t.values && t.values.length > 0
              ? `${t.name} (enum: ${t.values.map((v) => `'${v}'`).join(', ')})`
              : `${t.name} (${t.kind})`
          )
          .join(', ')}`
      )
    }
  }
  return lines.join('\n')
}

/** Degrade detail tier by tier instead of cutting the summary mid-text. */
function summarizeSchema(db: DatabaseIntrospection): string {
  const full = renderSchema(db, 'full')
  if (full.length <= SCHEMA_SUMMARY_MAX_CHARS) return full
  const abridgedNote =
    '\n(schema summary abridged to fit context — use search_schema to locate names and describe_table for column, key, and index detail)'
  const compact = renderSchema(db, 'compact')
  if (compact.length + abridgedNote.length <= SCHEMA_SUMMARY_MAX_CHARS) {
    return compact + abridgedNote
  }
  const names = renderSchema(db, 'names')
  if (names.length + abridgedNote.length <= SCHEMA_SUMMARY_MAX_CHARS) {
    return names + abridgedNote
  }
  return (
    names.slice(0, SCHEMA_SUMMARY_MAX_CHARS - abridgedNote.length) +
    abridgedNote
  )
}

async function schemaSummaryFor(target: AgentTargetRef): Promise<string> {
  const cacheKey = schemaCacheKey(target)
  const cached = schemaCache.get(cacheKey)
  if (cached) return cached
  const res = await introspectDatabase(target.connId, target.database)
  if (!res.ok) return `(schema introspection failed: ${res.error})`
  const summary = summarizeSchema(res.data)
  schemaCache.set(cacheKey, summary)
  return summary
}

function buildSystemPrompt(
  req: AgentSendRequest,
  mode: AgentMode,
  schemaSummary: string | null,
  dialect: DialectInfo
): string {
  const parts: string[] = [
    'You are the AI assistant inside DB Desk, a desktop database client.',
    `Your job is to turn user requests into correct, working ${dialect.engine} statements.`,
    '',
    'Rules:',
    '- Always put final, runnable SQL inside ```sql fenced code blocks; the user can insert those blocks into their editor with one click.',
    '- When you have settled on the final query, call the write_to_editor tool with it so it lands in the SQL editor. Do this once per answer, at the end, with the single final statement — not with intermediate or exploratory queries.',
    ...dialect.agent.rules,
    '- Keep prose brief; lead with the SQL, then a short explanation if needed.'
  ]
  if (req.target && mode === 'read-only') {
    parts.push(
      '- You may execute statements with the run_sql tool. Use it to validate your SQL and inspect real data before presenting a final answer. Each run is shown to the user in the results grid.',
      '- You are in Read-Only mode: one statement per run_sql call, and only read-only statements (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN of reads) will execute. Anything that would modify data or schema — including INSERT/UPDATE/DELETE/MERGE, DDL, SET, and transaction control — is blocked before it reaches the server and will fail. Do not attempt such statements. If the user asks for a change, write the SQL to the editor with write_to_editor and tell them to review and run it themselves.',
      `- Statements are cancelled after ${AGENT_STATEMENT_TIMEOUT_MS / 1000} seconds.`,
      `- Use describe_table for full detail on one relation and search_schema to find tables, columns, or functions by name — ${dialect.agent.catalogHint}.`,
      (dialect.agent.supportsExplainAnalyze
        ? '- Use explain_query to inspect query plans before recommending a query on large tables; set analyze to true only when actually executing a read is acceptable.'
        : '- Use explain_query to inspect query plans before recommending a query on large tables.') +
        ' EXPLAIN is refused for statements that modify data or schema.'
    )
  } else if (req.target) {
    parts.push(
      '- You are in Metadata Only mode: you cannot execute anything against the database. Work from the schema summary below and the objects the user attached. Do not claim to have run or validated anything; present SQL for the user to run.'
    )
  } else {
    parts.push(
      '- Query execution is disabled for this chat; do not claim to have run anything.'
    )
  }
  if (req.webSearch) {
    parts.push(
      '- Web search is enabled for this chat. You may search the web when outside information would genuinely help — engine documentation, SQL syntax and function references, unfamiliar error messages, or examples the user asked for. Most requests are answerable from the schema and your own knowledge; do not search for those.'
    )
  }
  if (req.target) {
    const version = getServerVersion(req.target.connId)
    parts.push(
      '',
      `Connected target: connection "${req.target.connName}", ${dialect.databaseTerm} "${req.target.database}"${version ? ` (${dialect.engine} ${version})` : ` (${dialect.engine})`}.`
    )
  } else {
    parts.push(
      '',
      'No database is connected; write SQL from the request alone.'
    )
  }
  if (req.context.length > 0) {
    parts.push(
      '',
      'The user attached these database objects to the thread as context — treat them as the primary subjects of the request:'
    )
    for (const item of req.context) {
      const qualified = item.schema ? `${item.schema}.${item.name}` : item.name
      const elsewhere =
        !req.target ||
        item.connId !== req.target.connId ||
        item.database !== req.target.database
          ? ` (in database "${item.database}", not the connected target)`
          : ''
      parts.push(`- ${item.kind} ${qualified}${elsewhere}`)
    }
    if (req.target) {
      parts.push(
        'Use describe_table on the attached tables and views when column-level detail matters.'
      )
    }
  }
  if (schemaSummary) {
    parts.push('', 'Database schema:', schemaSummary)
  }
  if (req.editor && req.editor.sql.trim()) {
    parts.push(
      '',
      `Active editor file${req.editor.fileName ? ` (${req.editor.fileName})` : ''} contents:`,
      '```sql',
      req.editor.sql,
      '```'
    )
  }
  return parts.join('\n')
}

function runSqlTool(dialect: DialectInfo): Anthropic.Tool {
  return {
    name: 'run_sql',
    description: `Execute a single read-only SQL statement against the connected ${dialect.engine} ${dialect.databaseTerm} and return the result. Exactly one statement per call. Statements that modify data or schema — or anything not provably a read — are blocked and fail. SELECT results are limited to 500 rows and the first 50 rows are returned to you; the full result is shown to the user in the results grid. Use this to validate queries and check real data.`,
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: `A single ${dialect.engine} statement to execute.`
        }
      },
      required: ['sql']
    }
  }
}

function explainQueryTool(dialect: DialectInfo): Anthropic.Tool {
  const analyzeProps: Record<string, unknown> = dialect.agent
    .supportsExplainAnalyze
    ? {
        analyze: {
          type: 'boolean',
          description:
            'Execute the statement to collect real timings (EXPLAIN ANALYZE). Reads only.'
        }
      }
    : {}
  return {
    name: 'explain_query',
    description: dialect.agent.supportsExplainAnalyze
      ? 'Run EXPLAIN on a SQL statement and return the query plan as text. Set analyze to true to execute the statement and get actual timings and row counts. Use this to check whether a query uses indexes before recommending it. Statements that modify data or schema cannot be explained.'
      : 'Run EXPLAIN on a SQL statement and return the query plan as text, without executing the statement. Use this to sanity-check how a query will be executed before recommending it. Statements that modify data or schema cannot be explained.',
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: `A single ${dialect.engine} statement to explain.`
        },
        ...analyzeProps
      },
      required: ['sql']
    }
  }
}

function describeTableTool(dialect: DialectInfo): Anthropic.Tool {
  return {
    name: 'describe_table',
    description: `Return full detail for one table, view, or materialized view: columns with types and comments, plus whatever the engine tracks — constraints, indexes, defaults, row estimates, storage detail. ${dialect.agent.catalogHint.replace(/^prefer/, 'Prefer')}.`,
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Relation name, optionally schema-qualified (e.g. "orders" or "sales.orders").'
        }
      },
      required: ['name']
    }
  }
}

function searchSchemaTool(dialect: DialectInfo): Anthropic.Tool {
  return {
    name: 'search_schema',
    description: `Case-insensitive substring search over table, view, column, and function names in the connected ${dialect.databaseTerm}. Use this to locate where a piece of data lives when the schema summary is abridged or a name is unknown.`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Substring to search for, e.g. "order_total".'
        }
      },
      required: ['pattern']
    }
  }
}

/**
 * Server-side web search tool, executed on Anthropic's infrastructure.
 * Haiku 4.5 predates the dynamic-filtering variant and needs the basic one.
 */
function webSearchTool(modelId: string): Anthropic.Messages.ToolUnion {
  if (modelId === 'claude-haiku-4-5') {
    return {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES
    }
  }
  return {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES
  }
}

const WRITE_EDITOR_TOOL: Anthropic.Tool = {
  name: 'write_to_editor',
  description:
    "Insert SQL into the user's active SQL editor at the cursor. Call this once at the end of your answer with the final, validated query so the user has it ready to run. Do not call it for intermediate or exploratory queries.",
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'The final SQL to place in the editor.'
      }
    },
    required: ['sql']
  }
}

function toolResultPayload(result: QueryResult): string {
  let rows = result.rows.slice(0, TOOL_RESULT_MAX_ROWS)
  let cellCap: number | null = null

  const build = (): string => {
    const notes: string[] = []
    if (result.rows.length > rows.length) {
      notes.push(
        `showing first ${rows.length} of ${result.rows.length} fetched rows`
      )
    }
    if (result.limitApplied !== null) {
      notes.push(
        `a LIMIT ${result.limitApplied} was auto-appended; the full result may have more rows`
      )
    }
    if (result.truncated) {
      notes.push(
        'rows beyond the fetch limit were discarded; the full result has more rows'
      )
    }
    if (cellCap !== null) {
      notes.push(
        `long cell values truncated to ${cellCap} chars in this payload`
      )
    }
    const cap = cellCap
    const outRows =
      cap === null
        ? rows
        : rows.map((row) =>
            row.map((cell) =>
              typeof cell === 'string' && cell.length > cap
                ? `${cell.slice(0, cap)}…`
                : cell
            )
          )
    return JSON.stringify({
      command: result.command,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      fields: result.fields,
      rows: outRows,
      note: notes.length > 0 ? notes.join('; ') : undefined
    })
  }

  let payload = build()
  if (payload.length > TOOL_RESULT_MAX_CHARS) {
    cellCap = TOOL_RESULT_CELL_CHARS
    payload = build()
  }
  while (payload.length > TOOL_RESULT_MAX_CHARS && rows.length > 1) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
    payload = build()
  }
  return payload
}

type Sender = (evt: AgentEvent) => void

function toolError(
  base: Anthropic.ToolResultBlockParam,
  req: AgentSendRequest,
  toolId: string,
  send: Sender,
  summary: string,
  content: string
): Anthropic.ToolResultBlockParam {
  send({ type: 'tool_result', chatId: req.chatId, toolId, ok: false, summary })
  return { ...base, content, is_error: true }
}

async function execRunSql(
  req: AgentSendRequest,
  chat: ChatState,
  mode: AgentMode,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const sql = String((block.input as { sql?: unknown }).sql ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  if (mode !== 'read-only') {
    return toolError(
      base,
      req,
      block.id,
      send,
      'not available',
      'This tool is not available in Metadata Only mode.'
    )
  }
  const target = req.target
  if (!target) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'no target',
      'No database target is connected.'
    )
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql
  })

  const res = await runAgentQuery(
    target.connId,
    target.database,
    sql,
    TOOL_RUN_LIMIT,
    {
      timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
      onCancel: (cancel) => {
        chat.cancelRunningQuery = cancel
      }
    }
  )
  chat.cancelRunningQuery = null

  // Blocked by the guard (Layer 2) or the server-side belt (Layer 3): same
  // friendly refusal either way, and never an approval request.
  if (!res.ok && res.code === AGENT_BLOCKED_CODE) {
    return toolError(base, req, block.id, send, 'blocked', res.error)
  }
  if (!res.ok && isReadOnlyViolation(res.code)) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'blocked',
      'Blocked: this statement modifies data. The agent is read-only; write the SQL to the editor for the user to review and run.'
    )
  }

  send({
    type: 'ran_query',
    chatId: req.chatId,
    sql,
    target,
    result: res.ok ? res.data : null,
    error: res.ok ? null : res.error
  })
  if (!res.ok) {
    return toolError(
      base,
      req,
      block.id,
      send,
      res.error,
      `Query failed: ${res.error}`
    )
  }
  const summary =
    res.data.rowCount === null
      ? res.data.command
      : `${res.data.command} · ${res.data.rowCount} row${res.data.rowCount === 1 ? '' : 's'} · ${res.data.durationMs}ms`
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary
  })
  return { ...base, content: toolResultPayload(res.data) }
}

async function execExplain(
  req: AgentSendRequest,
  chat: ChatState,
  mode: AgentMode,
  block: Anthropic.ToolUseBlock,
  send: Sender,
  dialect: DialectInfo
): Promise<Anthropic.ToolResultBlockParam> {
  const input = block.input as { sql?: unknown; analyze?: unknown }
  const sql = String(input.sql ?? '').trim()
  const analyze = input.analyze === true && dialect.agent.supportsExplainAnalyze
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  if (mode !== 'read-only') {
    return toolError(
      base,
      req,
      block.id,
      send,
      'not available',
      'This tool is not available in Metadata Only mode.'
    )
  }
  const target = req.target
  if (!target) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'no target',
      'No database target is connected.'
    )
  }
  // Writes are not explained at all (with or without ANALYZE); refuse the
  // inner statement up front instead of relying on a downstream failure.
  if (classifyStatement(sql) !== 'read') {
    return toolError(
      base,
      req,
      block.id,
      send,
      'blocked',
      'Blocked: EXPLAIN is not available for statements that modify data or schema.'
    )
  }
  const explainSql = dialect.explainSql(sql, analyze)
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: explainSql
  })
  const res = await runAgentQuery(
    target.connId,
    target.database,
    explainSql,
    null,
    {
      timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
      onCancel: (cancel) => {
        chat.cancelRunningQuery = cancel
      }
    }
  )
  chat.cancelRunningQuery = null
  if (!res.ok) {
    return toolError(
      base,
      req,
      block.id,
      send,
      res.error,
      `EXPLAIN failed: ${res.error}`
    )
  }
  const plan = res.data.rows.map((row) => row[0]).join('\n')
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: `plan · ${res.data.durationMs}ms`
  })
  return { ...base, content: plan || '(empty plan)' }
}

async function execDescribeTable(
  req: AgentSendRequest,
  mode: AgentMode,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const name = String((block.input as { name?: unknown }).name ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  if (mode !== 'read-only') {
    return toolError(
      base,
      req,
      block.id,
      send,
      'not available',
      'This tool is not available in Metadata Only mode.'
    )
  }
  const target = req.target
  if (!target) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'no target',
      'No database target is connected.'
    )
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: `describe ${name}`
  })
  const res = await describeTable(target.connId, target.database, name)
  if (!res.ok) {
    return toolError(
      base,
      req,
      block.id,
      send,
      res.error,
      `describe_table failed: ${res.error}`
    )
  }
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: name
  })
  return { ...base, content: res.data }
}

async function execSearchSchema(
  req: AgentSendRequest,
  mode: AgentMode,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const pattern = String(
    (block.input as { pattern?: unknown }).pattern ?? ''
  ).trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  if (mode !== 'read-only') {
    return toolError(
      base,
      req,
      block.id,
      send,
      'not available',
      'This tool is not available in Metadata Only mode.'
    )
  }
  const target = req.target
  if (!target) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'no target',
      'No database target is connected.'
    )
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: `search "${pattern}"`
  })
  const res = await searchSchema(target.connId, target.database, pattern)
  if (!res.ok) {
    return toolError(
      base,
      req,
      block.id,
      send,
      res.error,
      `search_schema failed: ${res.error}`
    )
  }
  const matches = res.data.startsWith('No relations')
    ? 'no matches'
    : 'matches found'
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: matches
  })
  return { ...base, content: res.data }
}

function execWriteEditor(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Anthropic.ToolResultBlockParam {
  const sql = String((block.input as { sql?: unknown }).sql ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  if (!sql) {
    return { ...base, content: 'No SQL provided.', is_error: true }
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql
  })
  send({ type: 'editor_insert', chatId: req.chatId, sql })
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: 'written to editor'
  })
  return { ...base, content: 'The SQL was inserted into the active editor.' }
}

/**
 * Move the incremental cache breakpoint to the last (user) message so each
 * request reuses the previous request's cached prefix instead of paying for
 * the whole conversation again on every tool round-trip.
 */
function setCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const blk of msg.content) {
        delete (blk as { cache_control?: unknown }).cache_control
      }
    }
  }
  const last = messages[messages.length - 1]
  if (!last) return
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }]
  }
  const tail = last.content[last.content.length - 1]
  if (tail) {
    ;(tail as { cache_control?: unknown }).cache_control = { type: 'ephemeral' }
  }
}

async function runAgentTurn(
  req: AgentSendRequest,
  send: Sender
): Promise<void> {
  const { key } = loadKey()
  if (!key) {
    send({
      type: 'error',
      chatId: req.chatId,
      message: `No API key found. Add \`export ${API_KEY_VAR}=...\` to ~/.zshrc and try again.`
    })
    return
  }
  const model = AGENT_MODELS.find((m) => m.id === req.model) ?? AGENT_MODELS[0]
  const chat = getChat(req.chatId)
  if (chat.controller) {
    send({
      type: 'error',
      chatId: req.chatId,
      message: 'A response is already in progress.'
    })
    return
  }
  const controller = new AbortController()
  chat.controller = controller

  // Fail closed: a renderer bug or tampering that sends 'write-admin' or
  // garbage silently degrades to Metadata Only.
  const mode = resolveAgentMode(req.mode)
  const client = new Anthropic({ apiKey: key })
  // Dialect follows the target connection's engine; chats without a target
  // default to PostgreSQL guidance.
  const dialect = dialectFor(
    req.target ? getConnectionType(req.target.connId) : null
  )
  const schemaSummary = req.target ? await schemaSummaryFor(req.target) : null
  // The system prompt (with the schema summary) is by far the largest stable
  // prefix; cache it so follow-up turns and tool round-trips reuse it.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: buildSystemPrompt(req, mode, schemaSummary, dialect),
      cache_control: { type: 'ephemeral' }
    }
  ]
  // Metadata Only offers no execution tools at all (Layer 1); its schema
  // knowledge is the system-prompt summary above.
  const tools: Anthropic.Messages.ToolUnion[] =
    req.target && mode === 'read-only'
      ? [
          WRITE_EDITOR_TOOL,
          runSqlTool(dialect),
          explainQueryTool(dialect),
          describeTableTool(dialect),
          searchSchemaTool(dialect)
        ]
      : [WRITE_EDITOR_TOOL]
  // Web search runs server-side; results come back as content blocks, so
  // there is no execution branch in the tool-use loop below.
  if (req.webSearch) tools.push(webSearchTool(model.id))

  chat.messages.push({ role: 'user', content: req.prompt })

  // Latest known context occupancy, updated after every API call so the
  // renderer's gauge stays accurate even when the turn aborts mid-loop.
  let contextTokens: number | null = null

  try {
    for (;;) {
      setCacheBreakpoint(chat.messages)
      const stream = client.messages.stream(
        {
          model: model.id,
          max_tokens: 64_000,
          ...(model.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
          ...(req.effort && model.efforts.includes(req.effort)
            ? { output_config: { effort: req.effort } }
            : {}),
          system,
          tools,
          messages: chat.messages
        },
        { signal: controller.signal }
      )

      stream.on('text', (delta) => {
        send({ type: 'text_delta', chatId: req.chatId, text: delta })
      })
      stream.on('contentBlock', (block) => {
        if (block.type === 'thinking') {
          send({ type: 'thinking', chatId: req.chatId, active: false })
        }
        // Web search executes server-side mid-stream; mirror it into the
        // transcript the same way client tools are shown.
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          const query = String(
            (block.input as { query?: unknown })?.query ?? ''
          )
          send({
            type: 'tool_start',
            chatId: req.chatId,
            toolId: block.id,
            name: block.name,
            sql: `web search "${query}"`
          })
        }
        if (block.type === 'web_search_tool_result') {
          const ok = Array.isArray(block.content)
          send({
            type: 'tool_result',
            chatId: req.chatId,
            toolId: block.tool_use_id,
            ok,
            summary: ok
              ? `${block.content.length} result${block.content.length === 1 ? '' : 's'}`
              : `search failed: ${block.content.error_code}`
          })
        }
      })
      stream.on('streamEvent', (evt) => {
        if (
          evt.type === 'content_block_start' &&
          evt.content_block.type === 'thinking'
        ) {
          send({ type: 'thinking', chatId: req.chatId, active: true })
        }
      })

      const message = await stream.finalMessage()
      const usage = message.usage
      contextTokens =
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        usage.output_tokens
      chat.messages.push({ role: 'assistant', content: message.content })

      if (message.stop_reason === 'pause_turn') continue

      if (message.stop_reason === 'tool_use') {
        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of toolUses) {
          if (block.name === 'run_sql') {
            results.push(await execRunSql(req, chat, mode, block, send))
          } else if (block.name === 'explain_query') {
            results.push(
              await execExplain(req, chat, mode, block, send, dialect)
            )
          } else if (block.name === 'describe_table') {
            results.push(await execDescribeTable(req, mode, block, send))
          } else if (block.name === 'search_schema') {
            results.push(await execSearchSchema(req, mode, block, send))
          } else if (block.name === 'write_to_editor') {
            results.push(execWriteEditor(req, block, send))
          } else {
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Unknown tool: ${block.name}`,
              is_error: true
            })
          }
        }
        chat.messages.push({ role: 'user', content: results })
        continue
      }

      send({
        type: 'done',
        chatId: req.chatId,
        stopReason: message.stop_reason,
        contextTokens
      })
      return
    }
  } catch (err) {
    if (
      err instanceof Anthropic.APIUserAbortError ||
      controller.signal.aborted
    ) {
      send({
        type: 'done',
        chatId: req.chatId,
        stopReason: 'aborted',
        contextTokens
      })
      return
    }
    const message =
      err instanceof Anthropic.APIError
        ? `${err.status ?? ''} ${err.message}`.trim()
        : err instanceof Error
          ? err.message
          : String(err)
    send({ type: 'error', chatId: req.chatId, message })
  } finally {
    chat.controller = null
  }
}

/** Cap on the summary a /compact call may produce. */
const COMPACT_MAX_TOKENS = 8192

const COMPACT_PROMPT = [
  'Summarize this conversation so the summary can replace the full history as context for future turns.',
  "Preserve, concisely: the user's goals and open questions; every schema fact learned (tables, columns, types, keys); key findings from queries that were run; the latest SQL under discussion, verbatim if it was final; and any constraints or preferences the user stated.",
  'Omit pleasantries and dead ends. Respond with the summary only.'
].join(' ')

/** Replace the chat history with a model-written summary of it (/compact). */
async function compactChat(
  chatId: string,
  modelId: string
): Promise<AgentCompactResult> {
  const { key } = loadKey()
  if (!key) {
    return {
      ok: false,
      error: `No API key found. Add \`export ${API_KEY_VAR}=...\` to ~/.zshrc and try again.`
    }
  }
  const chat = chats.get(chatId)
  if (!chat || chat.messages.length === 0) {
    return { ok: false, error: 'Nothing to compact — the conversation is empty.' }
  }
  if (chat.controller) {
    return {
      ok: false,
      error: 'Wait for the current response to finish before compacting.'
    }
  }
  const model = AGENT_MODELS.find((m) => m.id === modelId) ?? AGENT_MODELS[0]
  const client = new Anthropic({ apiKey: key })

  // An aborted turn can leave dangling tool_use blocks; pair each with a
  // synthetic result or the API rejects the transcript.
  const content: Anthropic.ContentBlockParam[] = []
  const last = chat.messages[chat.messages.length - 1]
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    for (const blk of last.content) {
      if (blk.type === 'tool_use') {
        content.push({
          type: 'tool_result',
          tool_use_id: blk.id,
          content: 'Interrupted before the tool ran.',
          is_error: true
        })
      }
    }
  }
  content.push({ type: 'text', text: COMPACT_PROMPT })

  try {
    const resp = await client.messages.create({
      model: model.id,
      max_tokens: COMPACT_MAX_TOKENS,
      messages: [...chat.messages, { role: 'user', content }]
    })
    const summary = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!summary) {
      return {
        ok: false,
        error: 'Compaction failed: the model returned no summary.'
      }
    }
    // Replace the history with a user/assistant pair so the next turn still
    // alternates roles cleanly.
    chat.messages.length = 0
    chat.messages.push(
      {
        role: 'user',
        content: `The earlier conversation was compacted to save context. Summary of everything so far:\n\n${summary}`
      },
      {
        role: 'assistant',
        content: 'Understood — continuing from that summary.'
      }
    )
    // The summary's output tokens approximate the new occupancy; the gauge
    // self-corrects with exact numbers on the next turn.
    return { ok: true, contextTokens: resp.usage.output_tokens }
  } catch (err) {
    const message =
      err instanceof Anthropic.APIError
        ? `${err.status ?? ''} ${err.message}`.trim()
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, error: `Compaction failed: ${message}` }
  }
}

/** Abort the stream and cancel the running statement. */
function stopChat(chatId: string): void {
  const chat = chats.get(chatId)
  if (!chat) return
  chat.controller?.abort()
  const cancel = chat.cancelRunningQuery
  if (cancel) {
    chat.cancelRunningQuery = null
    cancel()
  }
}

export function registerAgentHandlers(
  getWindow: () => BrowserWindow | null
): void {
  const send: Sender = (evt) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', evt)
  }

  ipcMain.handle('agent:keyStatus', (): AgentKeyStatus => {
    const { key, source } = loadKey()
    return { found: key !== null, source }
  })

  ipcMain.handle('agent:send', async (_event, req: AgentSendRequest) => {
    await runAgentTurn(req, send)
  })

  ipcMain.handle('agent:stop', (_event, chatId: string) => {
    stopChat(chatId)
  })

  ipcMain.handle(
    'agent:compact',
    (_event, chatId: string, model: string): Promise<AgentCompactResult> =>
      compactChat(chatId, model)
  )

  ipcMain.handle('agent:reset', (_event, chatId: string) => {
    stopChat(chatId)
    chats.delete(chatId)
    // Schema may have changed since it was cached; a fresh chat re-introspects.
    schemaCache.clear()
  })
}
