/**
 * Wire types for the AI agent: shared by the main-process agent loop, the
 * preload bridge, and the renderer chat UI. Structured-clone friendly.
 */

import type { QueryResult } from './db'

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentModelOption {
  id: string
  label: string
  /** Effort levels the model accepts; empty when the model rejects effort. */
  efforts: AgentEffort[]
  defaultEffort: AgentEffort | null
  /** True when the model supports adaptive thinking. */
  adaptiveThinking: boolean
}

export const AGENT_MODELS: AgentModelOption[] = [
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    adaptiveThinking: true
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    adaptiveThinking: true
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    adaptiveThinking: true
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    adaptiveThinking: true
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    efforts: [],
    defaultEffort: null,
    adaptiveThinking: false
  }
]

export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0]

export interface AgentTargetRef {
  connId: string
  connName: string
  database: string
}

export interface AgentSendRequest {
  chatId: string
  prompt: string
  model: string
  effort: AgentEffort | null
  /** When true the run_sql tool is exposed and results mirror to the grid. */
  allowRun: boolean
  target: AgentTargetRef | null
  /** Snapshot of the active SQL editor at send time. */
  editor: { fileName: string | null; sql: string } | null
}

export interface AgentKeyStatus {
  found: boolean
  source: 'zshrc' | 'env' | null
}

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
  | { type: 'done'; chatId: string; stopReason: string | null }
  | { type: 'error'; chatId: string; message: string }
