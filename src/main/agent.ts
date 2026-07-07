/**
 * Main-process AI agent: owns the Anthropic client, per-chat conversation
 * history, and the streaming tool-use loop. The renderer talks to it through
 * `agent:*` IPC handles and receives progress as `agent:event` pushes.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

import { introspectDatabase, runQuery } from './db'
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
/** Auto-LIMIT applied to agent-run statements, mirroring the editor default. */
const TOOL_RUN_LIMIT = 500
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
}

const chats = new Map<string, ChatState>()

function getChat(chatId: string): ChatState {
  let chat = chats.get(chatId)
  if (!chat) {
    chat = { messages: [], controller: null }
    chats.set(chatId, chat)
  }
  return chat
}

/** Schema summaries are reused across turns; introspection can be slow. */
const schemaCache = new Map<string, string>()

function summarizeColumns(cols: { name: string; dataType: string; badge: 'pk' | 'fk' | null }[]): string {
  return cols
    .map((c) => `${c.name} ${c.dataType}${c.badge ? ` [${c.badge.toUpperCase()}]` : ''}`)
    .join(', ')
}

function summarizeSchema(db: DatabaseIntrospection): string {
  const lines: string[] = [`Database: ${db.name}`]
  for (const schema of db.schemas) {
    lines.push(`Schema "${schema.name}":`)
    for (const t of schema.tables) {
      lines.push(`  table ${schema.name}.${t.name} (${summarizeColumns(t.columns)})`)
    }
    for (const v of schema.views) {
      lines.push(`  view ${schema.name}.${v.name} (${summarizeColumns(v.columns)})`)
    }
    for (const m of schema.matviews) {
      lines.push(`  materialized view ${schema.name}.${m.name} (${summarizeColumns(m.columns)})`)
    }
    for (const f of schema.functions) {
      lines.push(`  function ${schema.name}.${f.name}(${f.args}) -> ${f.returnType}`)
    }
    if (schema.types.length > 0) {
      lines.push(`  types: ${schema.types.map((t) => `${t.name} (${t.kind})`).join(', ')}`)
    }
  }
  let out = lines.join('\n')
  if (out.length > SCHEMA_SUMMARY_MAX_CHARS) {
    out = `${out.slice(0, SCHEMA_SUMMARY_MAX_CHARS)}\n… (schema summary truncated)`
  }
  return out
}

async function schemaSummaryFor(target: AgentTargetRef): Promise<string> {
  const cacheKey = `${target.connId}/${target.database}`
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
  if (req.allowRun) {
    parts.push(
      '- You may execute statements with the run_sql tool. Use it to validate your SQL and inspect real data before presenting a final answer. Each run is shown to the user in the results grid.',
      '- Be careful with statements that modify data; only run them when the user explicitly asked for that change.'
    )
  } else {
    parts.push(
      '- Query execution is disabled for this chat; do not claim to have run anything.'
    )
  }
  if (req.target) {
    parts.push(
      '',
      `Connected target: connection "${req.target.connName}", database "${req.target.database}".`
    )
  } else {
    parts.push('', 'No database is connected; write SQL from the request alone.')
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
    'Execute a SQL statement against the connected PostgreSQL database and return the result. SELECT results are limited to 500 rows and the first 50 rows are returned to you; the full result is shown to the user in the results grid. Use this to validate queries and check real data.',
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

const WRITE_EDITOR_TOOL: Anthropic.Tool = {
  name: 'write_to_editor',
  description:
    'Insert SQL into the user\'s active SQL editor at the cursor. Call this once at the end of your answer with the final, validated query so the user has it ready to run. Do not call it for intermediate or exploratory queries.',
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
  const rows = result.rows.slice(0, TOOL_RESULT_MAX_ROWS)
  return JSON.stringify({
    command: result.command,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    fields: result.fields.map((f) => f.name),
    rows,
    note:
      result.rows.length > rows.length
        ? `showing first ${rows.length} of ${result.rows.length} fetched rows`
        : undefined
  })
}

type Sender = (evt: AgentEvent) => void

async function execRunSql(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Promise<Anthropic.ToolResultBlockParam> {
  const sql = String((block.input as { sql?: unknown }).sql ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  if (!req.target) {
    send({ type: 'tool_result', chatId: req.chatId, toolId: block.id, ok: false, summary: 'no target' })
    return { ...base, content: 'No database target is connected.', is_error: true }
  }
  send({ type: 'tool_start', chatId: req.chatId, toolId: block.id, name: block.name, sql })
  const res = await runQuery(req.target.connId, req.target.database, sql, TOOL_RUN_LIMIT)
  send({
    type: 'ran_query',
    chatId: req.chatId,
    sql,
    target: req.target,
    result: res.ok ? res.data : null,
    error: res.ok ? null : res.error
  })
  if (!res.ok) {
    send({ type: 'tool_result', chatId: req.chatId, toolId: block.id, ok: false, summary: res.error })
    return { ...base, content: `Query failed: ${res.error}`, is_error: true }
  }
  const summary =
    res.data.rowCount === null
      ? res.data.command
      : `${res.data.command} · ${res.data.rowCount} row${res.data.rowCount === 1 ? '' : 's'} · ${res.data.durationMs}ms`
  send({ type: 'tool_result', chatId: req.chatId, toolId: block.id, ok: true, summary })
  return { ...base, content: toolResultPayload(res.data) }
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
  send({ type: 'tool_start', chatId: req.chatId, toolId: block.id, name: block.name, sql })
  send({ type: 'editor_insert', chatId: req.chatId, sql })
  send({ type: 'tool_result', chatId: req.chatId, toolId: block.id, ok: true, summary: 'written to editor' })
  return { ...base, content: 'The SQL was inserted into the active editor.' }
}

async function runAgentTurn(req: AgentSendRequest, send: Sender): Promise<void> {
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
    send({ type: 'error', chatId: req.chatId, message: 'A response is already in progress.' })
    return
  }
  const controller = new AbortController()
  chat.controller = controller

  const client = new Anthropic({ apiKey: key })
  const schemaSummary = req.target ? await schemaSummaryFor(req.target) : null
  const system = buildSystemPrompt(req, schemaSummary)
  const tools = [
    WRITE_EDITOR_TOOL,
    ...(req.allowRun && req.target ? [RUN_SQL_TOOL] : [])
  ]

  const userParts: string[] = [req.prompt]
  chat.messages.push({ role: 'user', content: userParts.join('\n') })

  try {
    for (;;) {
      const stream = client.messages.stream(
        {
          model: model.id,
          max_tokens: 64_000,
          ...(model.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
          ...(req.effort && model.efforts.includes(req.effort)
            ? { output_config: { effort: req.effort } }
            : {}),
          system,
          ...(tools.length > 0 ? { tools } : {}),
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
            results.push(await execRunSql(req, block, send))
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

      send({ type: 'done', chatId: req.chatId, stopReason: message.stop_reason })
      return
    }
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || controller.signal.aborted) {
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
    chats.get(chatId)?.controller?.abort()
  })

  ipcMain.handle('agent:reset', (_event, chatId: string) => {
    chats.get(chatId)?.controller?.abort()
    chats.delete(chatId)
    // Schema may have changed since it was cached; a fresh chat re-introspects.
    schemaCache.clear()
  })
}
