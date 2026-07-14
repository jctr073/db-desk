/**
 * Unit tests for the agent's knowledge write path (src/main/agent.ts):
 * the `execSaveKnowledge` handler behind the save_knowledge tool. Covers a
 * valid record persisting and being listable, `source` being forced to
 * 'agent', invalid kind/payload being rejected with a useful error, and
 * update-by-id preserving createdAt while stamping updatedAt.
 *
 * agent.ts pulls in Electron and the database/MCP layers at import time, so
 * those are mocked: `electron` with a temp userData dir feeding the real
 * knowledge store, and ./db + ./mcp as inert stubs — which doubles as the
 * safety assertion that the write path never reaches the warehouse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Anthropic from '@anthropic-ai/sdk'

import type { AgentEvent, AgentSendRequest } from '../../src/shared/agent'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  },
  ipcMain: { handle: (): void => {} }
}))

const runAgentQuery = vi.fn()
const describeTable = vi.fn()
const searchSchema = vi.fn()
const introspectDatabase = vi.fn()

vi.mock('../../src/main/db', () => ({
  AGENT_BLOCKED_CODE: 'AGENT_BLOCKED',
  describeTable: (...args: unknown[]) => describeTable(...args),
  getConnectionType: () => 'postgres',
  getServerVersion: () => null,
  introspectDatabase: (...args: unknown[]) => introspectDatabase(...args),
  isReadOnlyViolation: () => false,
  runAgentQuery: (...args: unknown[]) => runAgentQuery(...args),
  searchSchema: (...args: unknown[]) => searchSchema(...args)
}))

vi.mock('../../src/main/mcp', () => ({
  callMcpTool: vi.fn(),
  mcpToolsForTurn: () => []
}))

let agent: typeof import('../../src/main/agent')
let knowledge: typeof import('../../src/main/knowledge')

const CONN = 'c-1'
const DB = 'analytics'

function makeReq(overrides: Partial<AgentSendRequest> = {}): AgentSendRequest {
  return {
    chatId: 'chat-1',
    prompt: 'hello',
    model: 'claude-opus-4-8',
    effort: null,
    mode: 'metadata',
    webSearch: false,
    repo: false,
    target: { connId: CONN, connName: 'Local', database: DB },
    editor: null,
    editorSelection: null,
    context: [],
    ...overrides
  }
}

function toolUse(input: Record<string, unknown>, id = 'toolu_1'): Anthropic.ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name: 'save_knowledge',
    input
  } as Anthropic.ToolUseBlock
}

function collect(): { send: (e: AgentEvent) => void; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  return { send: (e) => events.push(e), events }
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-agent-save-knowledge-'))
  vi.resetModules()
  runAgentQuery.mockReset()
  describeTable.mockReset()
  searchSchema.mockReset()
  introspectDatabase.mockReset()
  knowledge = await import('../../src/main/knowledge')
  agent = await import('../../src/main/agent')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('execSaveKnowledge', () => {
  it('persists a valid record and makes it listable', () => {
    const { send, events } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        kind: 'annotation',
        target: { schema: 'public', table: 'encounters', column: 'encounter_date' },
        text: 'admission date, not discharge'
      }),
      send
    )

    expect(result.is_error).toBeFalsy()
    const payload = JSON.parse(result.content as string) as {
      id: string
      kind: string
      action: string
    }
    expect(payload.kind).toBe('annotation')
    expect(payload.action).toBe('created')
    expect(payload.id).toMatch(/^kn-/)

    const records = knowledge.listRecords(CONN, DB)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(payload.id)
    expect(records[0].kind).toBe('annotation')

    // tool_start then a successful tool_result.
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_result'])
    const done = events[1] as Extract<AgentEvent, { type: 'tool_result' }>
    expect(done.ok).toBe(true)
    expect(done.summary).toContain('saved')

    // Never touches the warehouse.
    expect(runAgentQuery).not.toHaveBeenCalled()
    expect(describeTable).not.toHaveBeenCalled()
    expect(searchSchema).not.toHaveBeenCalled()
    expect(introspectDatabase).not.toHaveBeenCalled()
  })

  it("forces source to 'agent' even if the model supplies 'human'", () => {
    const { send } = collect()
    agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        kind: 'note',
        title: 'Cents',
        body: 'Amounts are in cents.',
        references: [],
        source: 'human'
      }),
      send
    )
    const [saved] = knowledge.listRecords(CONN, DB)
    expect(saved.source).toBe('agent')
  })

  it('persists confidence and provenance on the record', () => {
    const { send } = collect()
    agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        kind: 'note',
        title: 'From the repo',
        body: 'Derived from a migration.',
        references: [],
        confidence: 'medium',
        provenance: 'db/migrate/001.rb'
      }),
      send
    )
    const [saved] = knowledge.listRecords(CONN, DB)
    expect(saved.confidence).toBe('medium')
    expect(saved.provenance).toBe('db/migrate/001.rb')
  })

  it('saves a polymorphic relationship record', () => {
    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        kind: 'relationship',
        relType: 'polymorphic',
        from: { schema: 'public', table: 'events', column: 'subject_id' },
        discriminator: { schema: 'public', table: 'events', column: 'subject_type' },
        targets: {
          patient: { schema: 'public', table: 'patients', column: 'id' },
          provider: { schema: 'public', table: 'providers', column: 'id' }
        }
      }),
      send
    )
    expect(result.is_error).toBeFalsy()
    const [saved] = knowledge.listRecords(CONN, DB)
    expect(saved.kind).toBe('relationship')
    expect(saved.source).toBe('agent')
  })

  it('rejects an unknown kind with a useful error and writes nothing', () => {
    const { send, events } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({ kind: 'metric', expr: 'sum(amount)' }),
      send
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('Unknown knowledge kind')
    expect(knowledge.listRecords(CONN, DB)).toHaveLength(0)
    const done = events[events.length - 1] as Extract<AgentEvent, { type: 'tool_result' }>
    expect(done.ok).toBe(false)
  })

  it('rejects a payload missing kind-required fields with a useful error', () => {
    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      // annotation with no target
      toolUse({ kind: 'annotation', text: 'orphan' }),
      send
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('annotation.target')
    expect(knowledge.listRecords(CONN, DB)).toHaveLength(0)
  })

  it('errors when no database target is connected', () => {
    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq({ target: null }),
      toolUse({
        kind: 'note',
        title: 't',
        body: 'b',
        references: []
      }),
      send
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('No database target')
  })

  it('updates by id: preserves createdAt, stamps updatedAt, no duplicate', () => {
    // Seed an existing record through the store so it owns createdAt/updatedAt.
    const seeded = knowledge.saveRecord(CONN, DB, {
      kind: 'annotation',
      source: 'agent',
      target: { schema: 'public', table: 'encounters', column: 'encounter_date' },
      text: 'old text'
    })
    const originalCreatedAt = seeded.createdAt

    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        id: seeded.id,
        kind: 'annotation',
        target: { schema: 'public', table: 'encounters', column: 'encounter_date' },
        text: 'admission date, not discharge'
      }),
      send
    )
    const payload = JSON.parse(result.content as string) as { id: string; action: string }
    expect(payload.id).toBe(seeded.id)
    expect(payload.action).toBe('updated')

    const records = knowledge.listRecords(CONN, DB)
    expect(records).toHaveLength(1)
    const updated = records[0] as typeof seeded
    expect(updated.text).toBe('admission date, not discharge')
    expect(updated.createdAt).toBe(originalCreatedAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt)
  })

  it('treats an id with no existing match as a create', () => {
    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        id: 'kn-does-not-exist',
        kind: 'note',
        title: 't',
        body: 'b',
        references: []
      }),
      send
    )
    const payload = JSON.parse(result.content as string) as { action: string }
    expect(payload.action).toBe('created')
    expect(knowledge.listRecords(CONN, DB)).toHaveLength(1)
  })
})
