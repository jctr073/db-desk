/**
 * Wire types for the AI agent: shared by the main-process agent loop, the
 * preload bridge, and the renderer chat UI. Structured-clone friendly.
 */

import type { QueryResult } from './db'

/** Default name of the shell variable holding the Claude API key. */
export const API_KEY_VAR = 'CLAUDE_API_KEY'

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgentMode = 'metadata' | 'read-only' | 'write-admin'

/** Why the user sent this turn; fix-query turns must propose an editor diff. */
export type AgentPromptIntent = 'chat' | 'fix-query'

export interface AgentModeOption {
  id: AgentMode
  label: string
  /** One-line description rendered in the mode picker. */
  description: string
  /** False = rendered greyed out, not selectable, refused by the main process. */
  enabled: boolean
}

export const AGENT_MODES: AgentModeOption[] = [
  {
    id: 'metadata',
    label: 'Metadata Only',
    description:
      'Writes SQL from the schema tree. Never executes anything on the database.',
    enabled: true
  },
  {
    id: 'read-only',
    label: 'Read-Only',
    description:
      'Runs read-only queries to inspect schema and live data. Writes are blocked.',
    enabled: true
  },
  {
    id: 'write-admin',
    label: 'Write/Admin',
    description:
      'Can change data and schema (DML/DDL). Disabled in this version.',
    enabled: false
  }
]

export const DEFAULT_AGENT_MODE: AgentMode = 'metadata'

/** Unknown or disabled modes resolve to the safest mode. */
export function resolveAgentMode(mode: unknown): AgentMode {
  const opt = AGENT_MODES.find((m) => m.id === mode)
  return opt && opt.enabled ? opt.id : DEFAULT_AGENT_MODE
}

export interface AgentModelOption {
  id: string
  label: string
  /** Effort levels the model accepts; empty when the model rejects effort. */
  efforts: AgentEffort[]
  defaultEffort: AgentEffort | null
  /** True when the model supports adaptive thinking. */
  adaptiveThinking: boolean
  /** Context window size in tokens, for the composer usage gauge. */
  contextWindow: number
}

export const AGENT_MODELS: AgentModelOption[] = [
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    adaptiveThinking: true,
    contextWindow: 200_000
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    adaptiveThinking: true,
    contextWindow: 200_000
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    adaptiveThinking: true,
    contextWindow: 200_000
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    adaptiveThinking: true,
    contextWindow: 200_000
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    efforts: [],
    defaultEffort: null,
    adaptiveThinking: false,
    contextWindow: 200_000
  }
]

export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0]

export interface AgentTargetRef {
  connId: string
  connName: string
  database: string
  /**
   * The knowledge base this turn writes to (save_knowledge) and reads its
   * codebase from (repo tools) — the "active" base. Set explicitly by scan
   * turns; omitted otherwise, in which case main falls back to the target's
   * default linked base. Main verifies a supplied id is actually linked to
   * (connId, database) and fails closed, same trust model as the repo flag.
   */
  kbId?: string
}

export type AgentDbObjectKind = 'schema' | 'table' | 'view' | 'matview'

/** A database object the user attached to the chat as context. */
export interface AgentDbObjectItem {
  kind: AgentDbObjectKind
  /** Object name (schema name for kind 'schema'). */
  name: string
  /** Containing schema; null for kind 'schema'. */
  schema: string | null
  database: string
  connId: string
}

/**
 * A block of the editor the user attached as context. A frozen quote: the
 * text and line range are snapshotted at attach time and never re-read.
 */
export interface AgentEditorSelectionItem {
  kind: 'editor-selection'
  /** Unique per attachment; chip identity for de-dup and removal. */
  id: string
  fileName: string | null
  sql: string
  /** 1-based inclusive line range in the file at attach time. */
  startLine: number
  endLine: number
}

/**
 * Query-result data the user attached from the results grid: a whole result
 * tab, a row/column selection within one, or a failed run (error set). Cells
 * are pre-stringified and capped at attach time (see shared/resultContext.ts)
 * so the request stays structured-clone friendly and prompt-budget safe.
 */
export interface AgentResultItem {
  kind: 'result'
  /** Unique per attachment; chip identity for de-dup and removal. */
  id: string
  /** Result tab title, e.g. "AI Result 3 · orders". */
  title: string
  /** The SQL that produced the result. */
  sql: string
  connId: string
  database: string
  columns: { name: string; dataType: string }[]
  /** Stringified, capped cell values; columns match `columns`. */
  rows: string[][]
  /** Row count of the full result these rows came from, when known. */
  totalRows: number | null
  /** Human description of the subset, e.g. "rows 4–9 of 500 (selected)". */
  scope: string
  /** Error message when the run failed; rows/columns are empty then. */
  error: string | null
}

export type AgentContextItem =
  | AgentDbObjectItem
  | AgentEditorSelectionItem
  | AgentResultItem

/**
 * The user's live selection in the active SQL editor, sent with a prompt so
 * "this" in the request resolves to what they highlighted. Line numbers are
 * 1-based and inclusive.
 */
export interface EditorSelectionContext {
  fileName: string | null
  sql: string
  startLine: number
  endLine: number
}

/** What the read_editor tool returns: the live buffer plus any selection. */
export interface AgentEditorReadPayload {
  editor: { fileName: string | null; sql: string } | null
  selection: EditorSelectionContext | null
}

/** Stable identity for de-duplicating and removing context chips. */
export function agentContextKey(item: AgentContextItem): string {
  if (item.kind === 'editor-selection' || item.kind === 'result') {
    return `${item.kind} ${item.id}`
  }
  return [item.connId, item.database, item.schema ?? '', item.kind, item.name].join('\x00')
}

export interface AgentSendRequest {
  chatId: string
  prompt: string
  /** Fix-query turns are not complete until corrected SQL is proposed. */
  intent: AgentPromptIntent
  model: string
  effort: AgentEffort | null
  /** Access mode; unknown/disabled values fail closed to Metadata Only. */
  mode: AgentMode
  /** True when the user enabled the web-browsing toggle for this chat. */
  webSearch: boolean
  /**
   * True when the user enabled the codebase toggle for this chat. Carries no
   * path: main resolves the actual repo root from its own per-connection
   * store, so a tampered renderer cannot point the agent at arbitrary
   * directories. No root configured = the flag is inert.
   */
  repo: boolean
  target: AgentTargetRef | null
  /** Snapshot of the active SQL editor at send time. */
  editor: { fileName: string | null; sql: string } | null
  /**
   * The user's selection in the active SQL editor at send time, when one
   * exists — a hint for what "this" refers to, alongside the full buffer.
   */
  editorSelection: EditorSelectionContext | null
  /** Objects the user attached to the thread as context chips. */
  context: AgentContextItem[]
}

export interface AgentKeyStatus {
  found: boolean
  /** 'keychain' = a key stored in-app via Settings (safeStorage-encrypted). */
  source: 'keychain' | 'zshrc' | 'env' | null
  /** Shell variable name consulted for the zshrc/env sources. */
  varName: string
}

/** A composer slash command; typing "/" lists these. */
export interface AgentSlashCommand {
  name: string
  description: string
}

export const AGENT_SLASH_COMMANDS: AgentSlashCommand[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation to shrink the context'
  },
  {
    name: 'clear',
    description: 'Clear the conversation and start fresh'
  }
]

export type AgentCompactResult =
  | {
      ok: true
      /** Approximate context occupancy after compaction, in tokens. */
      contextTokens: number
    }
  | { ok: false; error: string }

export type AgentEvent =
  | { type: 'turn_start'; chatId: string }
  | { type: 'text_delta'; chatId: string; text: string }
  | { type: 'thinking'; chatId: string; active: boolean }
  | {
      type: 'tool_start'
      chatId: string
      toolId: string
      name: string
      sql: string
    }
  | {
      type: 'tool_result'
      chatId: string
      toolId: string
      ok: boolean
      summary: string
    }
  | {
      type: 'ran_query'
      chatId: string
      sql: string
      target: AgentTargetRef
      result: QueryResult | null
      error: string | null
    }
  | {
      /**
       * The agent proposed new contents for the active SQL editor. The
       * renderer applies it directly when the buffer is blank; otherwise it
       * opens a diff review the user accepts or rejects.
       */
      type: 'editor_proposal'
      chatId: string
      sql: string
    }
  | {
      type: 'done'
      chatId: string
      stopReason: string | null
      /**
       * Total tokens occupying the context window after this turn (prompt +
       * cache + output of the last API call), or null when unknown.
       */
      contextTokens: number | null
    }
  | { type: 'error'; chatId: string; message: string }
