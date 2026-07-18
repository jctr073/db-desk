/**
 * Tool executors for the SQL tools (run_sql, explain_query, describe_table,
 * search_schema), the editor tools, the repo tools, and MCP tool dispatch,
 * plus the small shared plumbing (toolError, toolResultPayload, capLines,
 * describeError, the Sender type) they all use. search_knowledge and
 * save_knowledge live in ./knowledge instead, next to the rendering/search
 * helpers they depend on.
 */

import Anthropic from '@anthropic-ai/sdk'

import {
  AGENT_BLOCKED_CODE,
  describeTable,
  isReadOnlyViolation,
  runAgentQuery,
  searchSchema
} from '../db'
import type {
  AgentEditorReadPayload,
  AgentEvent,
  AgentMode,
  AgentSendRequest
} from '../../shared/agent'
import type { QueryResult } from '../../shared/db'
import type { DialectInfo } from '../../shared/dialect'
import { classifyStatement } from '../../shared/sql'
import { callMcpTool } from '../mcp'
import type { McpAgentTool } from '../mcp'
import { grepRepo, listRepoFiles, readRepoFile } from '../repo'
import type { ChatState } from '../agent'
import { allRecordsForTarget, renderTableKnowledge } from './knowledge'

/** Rows of a tool-run result forwarded to the model (grid shows the full set). */
const TOOL_RESULT_MAX_ROWS = 50
/** Overall budget for one tool-result payload sent to the model. */
const TOOL_RESULT_MAX_CHARS = 30_000
/** Per-cell cap applied (model copy only) when a payload exceeds the budget. */
const TOOL_RESULT_CELL_CHARS = 400
/** Auto-LIMIT applied to agent-run statements, mirroring the editor default. */
const TOOL_RUN_LIMIT = 500
/** statement_timeout for agent-issued statements. */
export const AGENT_STATEMENT_TIMEOUT_MS = 30_000

function toolResultPayload(result: QueryResult): string {
  let rows = result.rows.slice(0, TOOL_RESULT_MAX_ROWS)
  let cellCap: number | null = null

  const build = (): string => {
    const notes: string[] = []
    if (result.rows.length > rows.length) {
      notes.push(`showing first ${rows.length} of ${result.rows.length} fetched rows`)
    }
    if (result.limitApplied !== null) {
      notes.push(
        `a LIMIT ${result.limitApplied} was auto-appended; the full result may have more rows`
      )
    }
    if (result.truncated) {
      notes.push('rows beyond the fetch limit were discarded; the full result has more rows')
    }
    if (cellCap !== null) {
      notes.push(`long cell values truncated to ${cellCap} chars in this payload`)
    }
    const cap = cellCap
    const outRows =
      cap === null
        ? rows
        : rows.map((row) =>
            row.map((cell) =>
              typeof cell === 'string' && cell.length > cap ? `${cell.slice(0, cap)}…` : cell
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

export type Sender = (evt: AgentEvent) => void

export function toolError(
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

export async function execRunSql(
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
    return toolError(base, req, block.id, send, 'no target', 'No database target is connected.')
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql
  })

  const res = await runAgentQuery(target.connId, target.database, sql, TOOL_RUN_LIMIT, {
    timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
    onCancel: (cancel) => {
      chat.cancelRunningQuery = cancel
    }
  })
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
    return toolError(base, req, block.id, send, res.error, `Query failed: ${res.error}`)
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

export async function execExplain(
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
    return toolError(base, req, block.id, send, 'no target', 'No database target is connected.')
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
  const res = await runAgentQuery(target.connId, target.database, explainSql, null, {
    timeoutMs: AGENT_STATEMENT_TIMEOUT_MS,
    onCancel: (cancel) => {
      chat.cancelRunningQuery = cancel
    }
  })
  chat.cancelRunningQuery = null
  if (!res.ok) {
    return toolError(base, req, block.id, send, res.error, `EXPLAIN failed: ${res.error}`)
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

export async function execDescribeTable(
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
    return toolError(base, req, block.id, send, 'no target', 'No database target is connected.')
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
    return toolError(base, req, block.id, send, res.error, `describe_table failed: ${res.error}`)
  }
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: name
  })
  // Locally recorded annotations and relationships — from every base linked
  // to the target — ride along after the DB-native detail so one
  // describe_table call carries both.
  const local = renderTableKnowledge(allRecordsForTarget(target), name)
  return { ...base, content: local ? `${res.data}\n\n${local}` : res.data }
}

export async function execSearchSchema(
  req: AgentSendRequest,
  mode: AgentMode,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const pattern = String((block.input as { pattern?: unknown }).pattern ?? '').trim()
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
    return toolError(base, req, block.id, send, 'no target', 'No database target is connected.')
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
    return toolError(base, req, block.id, send, res.error, `search_schema failed: ${res.error}`)
  }
  const matches = res.data.startsWith('No relations') ? 'no matches' : 'matches found'
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: matches
  })
  return { ...base, content: res.data }
}

export function execWriteEditor(
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
  send({ type: 'editor_proposal', chatId: req.chatId, sql })
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: 'proposed to editor'
  })
  // The user's accept/reject happens after this turn ends; do not block on
  // it. Later turns see the real outcome through the editor snapshot.
  return {
    ...base,
    content:
      'The SQL was proposed to the editor. If the editor was empty it was applied immediately; otherwise the user is reviewing a diff and may accept or reject it — do not assume it was applied.'
  }
}

/** Timeout for one live editor read from the renderer. */
export const EDITOR_READ_TIMEOUT_MS = 1_500

/**
 * Fetches the live editor state from the renderer over the
 * agent:editor-read round-trip. Set via setReadEditorFromRenderer in
 * registerAgentHandlers; resolves null (editor unavailable) until then — e.g.
 * in unit tests — and on timeout.
 */
let readEditorFromRenderer: () => Promise<AgentEditorReadPayload | null> = async () => null

/** Injects the renderer round-trip used by read_editor; called from registerAgentHandlers. */
export function setReadEditorFromRenderer(fn: () => Promise<AgentEditorReadPayload | null>): void {
  readEditorFromRenderer = fn
}

export async function execReadEditor(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: 'read editor'
  })
  const payload = await readEditorFromRenderer()
  if (!payload || !payload.editor) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'unavailable',
      'The editor could not be read (no active SQL editor).'
    )
  }
  const { editor, selection } = payload
  const lines = editor.sql === '' ? 0 : editor.sql.split('\n').length
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: lines === 0 ? 'empty' : `${lines} line${lines === 1 ? '' : 's'}`
  })
  return {
    ...base,
    content: JSON.stringify({
      fileName: editor.fileName,
      sql: editor.sql,
      selection,
      note:
        editor.sql.trim() === ''
          ? 'The active editor is empty (or no SQL file is active).'
          : undefined
    })
  }
}

/**
 * Trim a list of result lines to the shared tool-result budget, reporting how
 * many were dropped so the model knows to narrow its query.
 */
function capLines(lines: string[], budget: number): { kept: string[]; dropped: number } {
  let used = 0
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    used += lines[i].length + 1
    if (used > budget) {
      end = i
      break
    }
  }
  return { kept: lines.slice(0, end), dropped: lines.length - end }
}

/**
 * Shared shell for the three repo tools: emits tool_start with a readable
 * label, runs the primitive, converts thrown sandbox/filesystem errors into
 * ordinary tool errors, and reports a one-line summary. Repo primitives throw
 * user-readable messages by design, so those are forwarded verbatim.
 */
async function execRepoTool(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender,
  label: string,
  run: () => Promise<{ content: string; summary: string }>
): Promise<Anthropic.ToolResultBlockParam> {
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: label
  })
  try {
    const { content, summary } = await run()
    send({
      type: 'tool_result',
      chatId: req.chatId,
      toolId: block.id,
      ok: true,
      summary
    })
    return { ...base, content }
  } catch (err) {
    return toolError(base, req, block.id, send, 'failed', describeError(err))
  }
}

export function execListRepoFiles(
  req: AgentSendRequest,
  root: string,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const input = (block.input ?? {}) as { dir?: unknown; glob?: unknown }
  const dir = typeof input.dir === 'string' ? input.dir : undefined
  const glob = typeof input.glob === 'string' ? input.glob : undefined
  const label = `repo: list ${[dir, glob].filter(Boolean).join(' ') || '(all)'}`
  return execRepoTool(req, block, send, label, async () => {
    const res = await listRepoFiles(root, dir, glob)
    const { kept, dropped } = capLines(res.files, TOOL_RESULT_MAX_CHARS - 200)
    const truncated = res.truncated || dropped > 0
    return {
      content: JSON.stringify({
        files: kept,
        note: truncated
          ? `truncated — ${kept.length} paths shown; narrow with dir or glob`
          : undefined
      }),
      summary: `${kept.length} file${kept.length === 1 ? '' : 's'}${truncated ? ' (truncated)' : ''}`
    }
  })
}

export function execGrepRepo(
  req: AgentSendRequest,
  root: string,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const input = (block.input ?? {}) as {
    pattern?: unknown
    dir?: unknown
    glob?: unknown
    caseSensitive?: unknown
  }
  const pattern = String(input.pattern ?? '')
  const dir = typeof input.dir === 'string' ? input.dir : undefined
  const glob = typeof input.glob === 'string' ? input.glob : undefined
  const label = `repo: grep /${pattern}/${glob ? ` in ${glob}` : dir ? ` in ${dir}` : ''}`
  return execRepoTool(req, block, send, label, async () => {
    const res = await grepRepo(root, pattern, {
      dir,
      glob,
      caseSensitive: input.caseSensitive === true
    })
    const lines = res.matches.map((m) => `${m.path}:${m.line}: ${m.text}`)
    const { kept, dropped } = capLines(lines, TOOL_RESULT_MAX_CHARS - 200)
    const truncated = res.truncated || dropped > 0
    return {
      content: JSON.stringify({
        matches: kept,
        filesScanned: res.filesScanned,
        note: truncated
          ? `truncated — ${kept.length} matches shown; narrow the pattern, dir, or glob`
          : undefined
      }),
      summary: `${kept.length} match${kept.length === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`
    }
  })
}

export function execReadRepoFile(
  req: AgentSendRequest,
  root: string,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const input = (block.input ?? {}) as {
    path?: unknown
    offset?: unknown
    limit?: unknown
  }
  const path = String(input.path ?? '')
  const label = `repo: read ${path}`
  return execRepoTool(req, block, send, label, async () => {
    const res = await readRepoFile(
      root,
      path,
      typeof input.offset === 'number' ? input.offset : undefined,
      typeof input.limit === 'number' ? input.limit : undefined
    )
    return {
      content: JSON.stringify({
        path: res.path,
        startLine: res.startLine,
        totalLines: res.totalLines,
        content: res.content,
        note: res.truncated ? 'truncated — use offset/limit to read further' : undefined
      }),
      summary: `${res.totalLines.toLocaleString()} line${res.totalLines === 1 ? '' : 's'}${res.truncated ? ' (partial)' : ''}`
    }
  })
}

export async function execMcpTool(
  req: AgentSendRequest,
  tool: McpAgentTool,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  const input = (block.input ?? {}) as Record<string, unknown>
  const argsPreview = JSON.stringify(input)
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: `${tool.serverName}: ${tool.toolName} ${argsPreview === '{}' ? '' : argsPreview}`.trim()
  })
  const res = await callMcpTool(tool.serverId, tool.toolName, input)
  const content =
    res.text.length > TOOL_RESULT_MAX_CHARS
      ? `${res.text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…(truncated at ${TOOL_RESULT_MAX_CHARS} chars)`
      : res.text
  if (!res.ok) {
    return toolError(base, req, block.id, send, 'failed', content)
  }
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: `${res.text.length.toLocaleString()} chars`
  })
  return { ...base, content }
}

/** Human-readable message for a failed request (the raw body is JSON noise). */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string } } | null | undefined
    const detail = body?.error?.message
    if (detail) {
      return err.status ? `API error ${err.status}: ${detail}` : detail
    }
    return `${err.status ?? ''} ${err.message}`.trim()
  }
  return err instanceof Error ? err.message : String(err)
}
