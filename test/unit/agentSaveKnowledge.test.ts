/**
 * Unit tests for the agent's knowledge write path (src/main/agent.ts):
 * the `execSaveKnowledge` handler behind the save_knowledge tool. Covers a
 * valid record persisting and being listable, `source` being forced to
 * 'agent', invalid kind/payload being rejected with a useful error, and the
 * v2 write-target resolution: a new record lands in the target's default
 * linked base (or an auto-created, auto-linked one named after the database
 * when the target has none), an update-by-id is routed to whichever linked
 * base actually holds that record — even when it is not the default — and a
 * renderer-supplied `target.kbId` is honored only when actually linked.
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
import type { KnowledgeRecord } from '../../src/shared/knowledge'

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

/** Union of records across every base linked to (CONN, DB) — mirrors
 * agent.ts's private allRecordsForTarget, since save_knowledge may land a
 * record in any linked base, not just one fixed (connId, database) file. */
function allRecords(): KnowledgeRecord[] {
  return knowledge.groupsForTarget(CONN, DB).flatMap((g) => g.records)
}

/** Creates a base linked to the public schema of CONN/DB and returns its id. */
function seedBase(name = 'Test base'): string {
  const base = knowledge.createBase(name)
  knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
  return base.id
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
  vi.useRealTimers()
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

    const records = allRecords()
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
    const [saved] = allRecords()
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
    const [saved] = allRecords()
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
    const [saved] = allRecords()
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
    expect(allRecords()).toHaveLength(0)
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
    expect(allRecords()).toHaveLength(0)
  })

  // The auto-create path validates the draft before creating anything, so a
  // rejected first save_knowledge call for a fresh target must not leave an
  // empty, database-named base and link behind.
  it('rejects a malformed record without creating the auto-base for a fresh target', () => {
    const { send } = collect()
    agent.execSaveKnowledge(makeReq(), toolUse({ kind: 'annotation', text: 'orphan' }), send)
    expect(knowledge.listBases()).toEqual([])
    expect(knowledge.listLinks()).toEqual([])
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
    expect(allRecords()).toHaveLength(1)
  })
})

describe('execSaveKnowledge write-target resolution', () => {
  it('auto-creates and links a base named after the database when the target has none', () => {
    expect(knowledge.listBases()).toEqual([])

    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({ kind: 'note', title: 't', body: 'b', references: [] }),
      send
    )

    expect(result.is_error).toBeFalsy()
    const links = knowledge.listLinks()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ connId: CONN, database: DB })
    // The record names no schema, so the link falls back to the engine's
    // default schema (mocked connection type is postgres).
    expect(links[0].schema).toBe('public')

    const base = knowledge.getBase(links[0].kbId)
    expect(base?.name).toBe(DB)
    expect(knowledge.listRecords(links[0].kbId)).toHaveLength(1)
  })

  it("scopes the auto-created link to the schema the record's own refs name", () => {
    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        kind: 'annotation',
        target: { schema: 'billing', table: 'invoices', column: 'total' },
        text: 'in cents'
      }),
      send
    )

    expect(result.is_error).toBeFalsy()
    const links = knowledge.listLinks()
    expect(links).toHaveLength(1)
    expect(links[0].schema).toBe('billing')
  })

  it("routes a new record to the target's existing default base rather than creating another", () => {
    const existing = seedBase('Existing repo')

    const { send } = collect()
    agent.execSaveKnowledge(
      makeReq(),
      toolUse({ kind: 'note', title: 't', body: 'b', references: [] }),
      send
    )

    expect(knowledge.listBases()).toHaveLength(1)
    expect(knowledge.listRecords(existing)).toHaveLength(1)
  })

  it('updates by id: preserves createdAt, stamps updatedAt, no duplicate', () => {
    // Seed an existing record through the store so it owns createdAt/updatedAt.
    const seeded = knowledge.saveRecord(seedBase(), {
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

    const records = allRecords()
    expect(records).toHaveLength(1)
    const updated = records[0] as typeof seeded
    expect(updated.text).toBe('admission date, not discharge')
    expect(updated.createdAt).toBe(originalCreatedAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt)
  })

  it('routes an update-by-id to the base that actually holds the record, even when a different base is the default', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const defaultBase = knowledge.createBase('Default repo')
    knowledge.addLink({ kbId: defaultBase.id, connId: CONN, database: DB, schema: 'public' })
    vi.setSystemTime(2_000)
    const otherBase = knowledge.createBase('Other repo')
    knowledge.addLink({ kbId: otherBase.id, connId: CONN, database: DB, schema: 'public' })
    vi.useRealTimers()
    // defaultBase's link is older, so it is the target's default — but the
    // record to update lives in otherBase.
    expect(knowledge.defaultKbForTarget(CONN, DB)).toBe(defaultBase.id)

    const seeded = knowledge.saveRecord(otherBase.id, {
      kind: 'annotation',
      source: 'human',
      target: { schema: 'public', table: 'encounters', column: 'encounter_date' },
      text: 'old text'
    })

    const { send } = collect()
    const result = agent.execSaveKnowledge(
      makeReq(),
      toolUse({
        id: seeded.id,
        kind: 'annotation',
        target: { schema: 'public', table: 'encounters', column: 'encounter_date' },
        text: 'updated text'
      }),
      send
    )

    const payload = JSON.parse(result.content as string) as { action: string }
    expect(payload.action).toBe('updated')
    // Updated in place in otherBase, not duplicated into the default base.
    const otherRecords = knowledge.listRecords(otherBase.id)
    expect(otherRecords).toHaveLength(1)
    expect(otherRecords[0]).toMatchObject({ kind: 'annotation', text: 'updated text' })
    expect(knowledge.listRecords(defaultBase.id)).toHaveLength(0)
  })

  it('honors target.kbId as the active base for a new record when it is actually linked', () => {
    const defaultBase = seedBase('Default repo')
    const scanBase = seedBase('Scan target repo')

    const { send } = collect()
    agent.execSaveKnowledge(
      makeReq({
        target: { connId: CONN, connName: 'Local', database: DB, kbId: scanBase }
      }),
      toolUse({ kind: 'note', title: 't', body: 'b', references: [] }),
      send
    )

    expect(knowledge.listRecords(scanBase)).toHaveLength(1)
    expect(knowledge.listRecords(defaultBase)).toEqual([])
  })

  it('falls back to the default base when target.kbId names a base not linked to the target', () => {
    const linked = seedBase('Linked repo')
    const unlinked = knowledge.createBase('Unlinked repo') // never linked to (CONN, DB)

    const { send } = collect()
    agent.execSaveKnowledge(
      makeReq({
        target: { connId: CONN, connName: 'Local', database: DB, kbId: unlinked.id }
      }),
      toolUse({ kind: 'note', title: 't', body: 'b', references: [] }),
      send
    )

    // The unlinked base was never touched; the record landed in the real
    // default (linked) base instead — fails closed, same trust model as the
    // repo flag.
    expect(knowledge.listRecords(unlinked.id)).toEqual([])
    expect(knowledge.listRecords(linked)).toHaveLength(1)
  })

  it('falls back to auto-creating a base when target.kbId is unlinked and the target has no other links', () => {
    const unlinked = knowledge.createBase('Unlinked repo')

    const { send } = collect()
    agent.execSaveKnowledge(
      makeReq({
        target: { connId: CONN, connName: 'Local', database: DB, kbId: unlinked.id }
      }),
      toolUse({ kind: 'note', title: 't', body: 'b', references: [] }),
      send
    )

    expect(knowledge.listRecords(unlinked.id)).toEqual([])
    const links = knowledge.linksForTarget(CONN, DB)
    expect(links).toHaveLength(1)
    expect(links[0].kbId).not.toBe(unlinked.id)
    expect(knowledge.listRecords(links[0].kbId)).toHaveLength(1)
  })
})
