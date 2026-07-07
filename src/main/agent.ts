/**
 * Main-process AI agent: owns the Anthropic client, per-chat conversation
 * history, and the streaming tool-use loop. The renderer talks to it through
 * `agent:*` IPC handles and receives progress as `agent:event` pushes.
 *
 * Execution safety model: agent statements run in a read-only session
 * (default_transaction_read_only) with a statement timeout. When the server
 * rejects a statement as needing write access, the agent pauses and asks the
 * user for approval before re-running it writable.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

import {
  cancelBackend,
  describeTable,
  getServerVersion,
  introspectDatabase,
  READ_ONLY_VIOLATION_CODES,
  runQuery,
  searchSchema
} from './db'
import type {
  AgentEvent,
  AgentKeyStatus,
  AgentSendRequest,
  AgentTargetRef
} from '../shared/agent'
import { AGENT_MODELS } from '../shared/agent'
import type { DatabaseIntrospection, QueryResult } from '../shared/db'

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

interface KeyInfo {
  key: string | null
  source: 'zshrc' | 'env' | null
}

function readKeyFromZshrc(): string | null {
  try {
    const text = readFileSync(join(homedir(), '.zshrc'), 'utf8')
    const re = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s#]+)/gm
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
  const fromEnv = process.env.ANTHROPIC_API_KEY
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return { key: null, source: null }
}

interface ChatState {
  messages: Anthropic.MessageParam[]
  controller: AbortController | null
  /** Resolver for a write-approval the UI has not answered yet. */
  pendingApproval: {
    toolId: string
    resolve: (approved: boolean) => void
  } | null
  /** Backend running the agent's current statement, for cancellation. */
  runningQuery: { connId: string; pid: number } | null
}

const chats = new Map<string, ChatState>()

function getChat(chatId: string): ChatState {
  let chat = chats.get(chatId)
  if (!chat) {
    chat = {
      messages: [],
      controller: null,
      pendingApproval: null,
      runningQuery: null
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
  schemaSummary: string | null
): string {
  const parts: string[] = [
    'You are the AI assistant inside DB Desk, a PostgreSQL desktop client.',
    'Your job is to turn user requests into correct, working PostgreSQL statements.',
    '',
    'Rules:',
    '- Always put final, runnable SQL inside ```sql fenced code blocks; the user can insert those blocks into their editor with one click.',
    '- When you have settled on the final query, call the write_to_editor tool with it so it lands in the SQL editor. Do this once per answer, at the end, with the single final statement — not with intermediate or exploratory queries.',
    '- Target PostgreSQL syntax only.',
    '- Prefer schema-qualified names when the table is outside the public schema.',
    '- Keep prose brief; lead with the SQL, then a short explanation if needed.'
  ]
  if (req.target) {
    parts.push(
      '- You may execute statements with the run_sql tool. Use it to validate your SQL and inspect real data before presenting a final answer. Each run is shown to the user in the results grid.',
      '- Statements run inside a READ ONLY transaction. A statement that modifies data or schema pauses and asks the user for approval first; only attempt such statements when the user explicitly asked for the change, and expect that they may deny it.',
      `- Statements are cancelled after ${AGENT_STATEMENT_TIMEOUT_MS / 1000} seconds.`,
      '- Use describe_table for full detail on one relation (constraints, indexes, defaults, comments, row estimate) and search_schema to find tables, columns, or functions by name — prefer them over querying pg_catalog yourself.',
      '- Use explain_query to inspect query plans before recommending a query on large tables; set analyze to true only when actually executing a read is acceptable.'
    )
  } else {
    parts.push(
      '- Query execution is disabled for this chat; do not claim to have run anything.'
    )
  }
  if (req.target) {
    const version = getServerVersion(req.target.connId)
    parts.push(
      '',
      `Connected target: connection "${req.target.connName}", database "${req.target.database}"${version ? ` (PostgreSQL ${version})` : ''}.`
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

const RUN_SQL_TOOL: Anthropic.Tool = {
  name: 'run_sql',
  description:
    'Execute a SQL statement against the connected PostgreSQL database and return the result. Statements run in a READ ONLY transaction; a statement that modifies data or schema pauses and asks the user for approval before running. SELECT results are limited to 500 rows and the first 50 rows are returned to you; the full result is shown to the user in the results grid. Use this to validate queries and check real data.',
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single PostgreSQL statement to execute.'
      }
    },
    required: ['sql']
  }
}

const EXPLAIN_QUERY_TOOL: Anthropic.Tool = {
  name: 'explain_query',
  description:
    'Run EXPLAIN on a SQL statement and return the query plan as text. Set analyze to true to execute the statement and get actual timings and row counts (EXPLAIN ANALYZE runs read-only here, so analyze fails on statements that modify data). Use this to check whether a query uses indexes before recommending it.',
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single PostgreSQL statement to explain.'
      },
      analyze: {
        type: 'boolean',
        description:
          'Execute the statement to collect real timings (EXPLAIN ANALYZE). Reads only.'
      }
    },
    required: ['sql']
  }
}

const DESCRIBE_TABLE_TOOL: Anthropic.Tool = {
  name: 'describe_table',
  description:
    'Return full detail for one table, view, or materialized view: columns with types, nullability, defaults and comments, all constraints (primary key, foreign keys, unique, check), index definitions, inbound foreign keys from other tables, and the approximate row count. Prefer this over querying pg_catalog yourself.',
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

const SEARCH_SCHEMA_TOOL: Anthropic.Tool = {
  name: 'search_schema',
  description:
    'Case-insensitive substring search over table, view, column, and function names in the connected database. Use this to locate where a piece of data lives when the schema summary is abridged or a name is unknown.',
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

/** Command tags whose success invalidates the cached schema summary. */
const DDL_COMMAND = /^(CREATE|ALTER|DROP)\b/i

function requestApproval(
  req: AgentSendRequest,
  chat: ChatState,
  toolId: string,
  sql: string,
  send: Sender
): Promise<boolean> {
  if (chat.controller?.signal.aborted) return Promise.resolve(false)
  send({ type: 'approval_request', chatId: req.chatId, toolId, sql })
  return new Promise((resolve) => {
    chat.pendingApproval = {
      toolId,
      resolve: (approved) => {
        chat.pendingApproval = null
        resolve(approved)
      }
    }
  })
}

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
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const sql = String((block.input as { sql?: unknown }).sql ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
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

  const trackPid = (pid: number): void => {
    chat.runningQuery = { connId: target.connId, pid }
  }
  let res = await runQuery(
    target.connId,
    target.database,
    sql,
    TOOL_RUN_LIMIT,
    {
      readOnly: true,
      timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
      onBackendPid: trackPid
    }
  )
  chat.runningQuery = null

  // The server classified the statement as a write; ask the user first.
  if (!res.ok && res.code && READ_ONLY_VIOLATION_CODES.has(res.code)) {
    const approved = await requestApproval(req, chat, block.id, sql, send)
    if (!approved) {
      return toolError(
        base,
        req,
        block.id,
        send,
        'declined by user',
        'The user declined to run this data-modifying statement. Do not retry it; present the SQL for the user to run themselves, or ask how to proceed.'
      )
    }
    res = await runQuery(target.connId, target.database, sql, TOOL_RUN_LIMIT, {
      timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
      onBackendPid: trackPid
    })
    chat.runningQuery = null
    if (res.ok && DDL_COMMAND.test(res.data.command)) {
      schemaCache.delete(schemaCacheKey(target))
    }
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
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const input = block.input as { sql?: unknown; analyze?: unknown }
  const sql = String(input.sql ?? '').trim()
  const analyze = input.analyze === true
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
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
  const explainSql = `EXPLAIN (FORMAT TEXT${analyze ? ', ANALYZE, BUFFERS' : ''}) ${sql}`
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: explainSql
  })
  const res = await runQuery(target.connId, target.database, explainSql, null, {
    readOnly: true,
    timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
    onBackendPid: (pid) => {
      chat.runningQuery = { connId: target.connId, pid }
    }
  })
  chat.runningQuery = null
  if (!res.ok) {
    const hint =
      res.code && READ_ONLY_VIOLATION_CODES.has(res.code)
        ? ' (EXPLAIN runs read-only here; analyze is not available for statements that modify data — retry with analyze false)'
        : ''
    return toolError(
      base,
      req,
      block.id,
      send,
      res.error,
      `EXPLAIN failed: ${res.error}${hint}`
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
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const name = String((block.input as { name?: unknown }).name ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
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
      message:
        'No API key found. Add `export ANTHROPIC_API_KEY=...` to ~/.zshrc and try again.'
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

  const client = new Anthropic({ apiKey: key })
  const schemaSummary = req.target ? await schemaSummaryFor(req.target) : null
  // The system prompt (with the schema summary) is by far the largest stable
  // prefix; cache it so follow-up turns and tool round-trips reuse it.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: buildSystemPrompt(req, schemaSummary),
      cache_control: { type: 'ephemeral' }
    }
  ]
  const tools = req.target
    ? [
        WRITE_EDITOR_TOOL,
        RUN_SQL_TOOL,
        EXPLAIN_QUERY_TOOL,
        DESCRIBE_TABLE_TOOL,
        SEARCH_SCHEMA_TOOL
      ]
    : [WRITE_EDITOR_TOOL]

  chat.messages.push({ role: 'user', content: req.prompt })

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
      chat.messages.push({ role: 'assistant', content: message.content })

      if (message.stop_reason === 'pause_turn') continue

      if (message.stop_reason === 'tool_use') {
        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of toolUses) {
          if (block.name === 'run_sql') {
            results.push(await execRunSql(req, chat, block, send))
          } else if (block.name === 'explain_query') {
            results.push(await execExplain(req, chat, block, send))
          } else if (block.name === 'describe_table') {
            results.push(await execDescribeTable(req, block, send))
          } else if (block.name === 'search_schema') {
            results.push(await execSearchSchema(req, block, send))
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
        stopReason: message.stop_reason
      })
      return
    }
  } catch (err) {
    if (
      err instanceof Anthropic.APIUserAbortError ||
      controller.signal.aborted
    ) {
      send({ type: 'done', chatId: req.chatId, stopReason: 'aborted' })
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

/** Abort the stream, deny any pending approval, cancel the running statement. */
function stopChat(chatId: string): void {
  const chat = chats.get(chatId)
  if (!chat) return
  chat.pendingApproval?.resolve(false)
  chat.controller?.abort()
  const running = chat.runningQuery
  if (running) {
    chat.runningQuery = null
    void cancelBackend(running.connId, running.pid)
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

  ipcMain.handle(
    'agent:approve',
    (_event, chatId: string, toolId: string, approved: boolean) => {
      const chat = chats.get(chatId)
      if (chat?.pendingApproval?.toolId === toolId) {
        chat.pendingApproval.resolve(approved)
      }
    }
  )

  ipcMain.handle('agent:stop', (_event, chatId: string) => {
    stopChat(chatId)
  })

  ipcMain.handle('agent:reset', (_event, chatId: string) => {
    stopChat(chatId)
    chats.delete(chatId)
    // Schema may have changed since it was cached; a fresh chat re-introspects.
    schemaCache.clear()
  })
}
