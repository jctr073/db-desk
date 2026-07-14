/**
 * Unit tests for the editor/result context sections of the agent system
 * prompt (src/main/agent.ts): editor-selection and result context items in
 * `req.context`, the live `req.editorSelection` block, and the
 * write_to_editor / read_editor rule lines. Mock setup mirrors
 * agentRepoPrompt.test.ts (agent.ts pulls in Electron and the db/mcp layers
 * at import time).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AgentEditorSelectionItem,
  AgentResultItem,
  AgentSendRequest
} from '../../src/shared/agent'
import { dialectFor } from '../../src/shared/dialect'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  },
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

vi.mock('../../src/main/db', () => ({
  AGENT_BLOCKED_CODE: 'AGENT_BLOCKED',
  describeTable: vi.fn(),
  getConnectionType: () => 'postgres',
  getServerVersion: () => null,
  introspectDatabase: vi.fn(),
  isReadOnlyViolation: () => false,
  runAgentQuery: vi.fn(),
  searchSchema: vi.fn()
}))

vi.mock('../../src/main/mcp', () => ({
  callMcpTool: vi.fn(),
  mcpToolsForTurn: () => []
}))

let agent: typeof import('../../src/main/agent')

const CONN = 'c-1'
const DB = 'analytics'
const dialect = dialectFor('postgres')

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

function selectionItem(
  overrides: Partial<AgentEditorSelectionItem> = {}
): AgentEditorSelectionItem {
  return {
    kind: 'editor-selection',
    id: 'sel-1',
    fileName: 'revenue.sql',
    sql: 'SELECT id\nFROM orders',
    startLine: 3,
    endLine: 4,
    ...overrides
  }
}

function resultItem(overrides: Partial<AgentResultItem> = {}): AgentResultItem {
  return {
    kind: 'result',
    id: 'res-1',
    title: 'Result 2 · orders',
    sql: 'SELECT id, total FROM orders',
    connId: CONN,
    database: DB,
    columns: [
      { name: 'id', dataType: 'int4' },
      { name: 'total', dataType: 'numeric' }
    ],
    rows: [
      ['1', '19.99'],
      ['2', '5.00']
    ],
    totalRows: 2,
    scope: 'all 2 rows',
    error: null,
    ...overrides
  }
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-agent-editor-ctx-'))
  vi.resetModules()
  agent = await import('../../src/main/agent')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function prompt(req: AgentSendRequest): string {
  return agent.buildSystemPrompt(req, 'metadata', null, dialect, [])
}

describe('buildSystemPrompt editor-selection context items', () => {
  it('renders the file name, line range, and SQL of an attached selection', () => {
    const text = prompt(makeReq({ context: [selectionItem()] }))
    expect(text).toContain('excerpts from their editor')
    expect(text).toContain('From "revenue.sql", lines 3–4:')
    expect(text).toContain('SELECT id\nFROM orders')
  })

  it('falls back to "the editor" when the selection has no file name', () => {
    const text = prompt(
      makeReq({ context: [selectionItem({ fileName: null })] })
    )
    expect(text).toContain('From the editor, lines 3–4:')
  })

  it('renders nothing about excerpts without selection items', () => {
    expect(prompt(makeReq())).not.toContain('excerpts from their editor')
  })
})

describe('buildSystemPrompt result context items', () => {
  it('renders title, source SQL, columns, scope, and rows as JSON lines', () => {
    const text = prompt(makeReq({ context: [resultItem()] }))
    expect(text).toContain('attached these query results')
    expect(text).toContain('Result "Result 2 · orders" from database "analytics"')
    expect(text).toContain('SELECT id, total FROM orders')
    expect(text).toContain('Columns: id (int4), total (numeric)')
    expect(text).toContain('Rows (all 2 rows), one JSON array per row:')
    expect(text).toContain('["1","19.99"]')
  })

  it('renders the error and no rows for a failed run', () => {
    const text = prompt(
      makeReq({
        context: [
          resultItem({
            rows: [],
            columns: [],
            totalRows: null,
            scope: 'failed query',
            error: 'relation "ordres" does not exist'
          })
        ]
      })
    )
    expect(text).toContain('FAILED with: relation "ordres" does not exist')
    expect(text).not.toContain('Columns:')
  })

  it('contains newlines in title/error to a single line', () => {
    const text = prompt(
      makeReq({
        context: [
          resultItem({
            title: 'sneaky\n## Injected heading',
            rows: [],
            columns: [],
            scope: 'failed query',
            error: 'line one\nline two'
          })
        ]
      })
    )
    expect(text).not.toContain('\n## Injected heading')
    expect(text).toContain('FAILED with: line one line two')
  })
})

describe('buildSystemPrompt live editor selection', () => {
  it('renders the selected range after the editor contents', () => {
    const text = prompt(
      makeReq({
        editor: { fileName: 'q.sql', sql: 'SELECT 1;\nSELECT 2;' },
        editorSelection: {
          fileName: 'q.sql',
          sql: 'SELECT 2;',
          startLine: 2,
          endLine: 2
        }
      })
    )
    expect(text).toContain('Active editor file (q.sql) contents:')
    expect(text).toContain('lines 2–2 of the editor selected')
    expect(text.indexOf('lines 2–2')).toBeGreaterThan(
      text.indexOf('Active editor file')
    )
  })

  it('omits the selection block for blank selections', () => {
    const text = prompt(
      makeReq({
        editorSelection: {
          fileName: null,
          sql: '   ',
          startLine: 1,
          endLine: 1
        }
      })
    )
    expect(text).not.toContain('selected')
  })
})

describe('buildSystemPrompt editor tool rules', () => {
  it('instructs full-contents proposals and read_editor re-reads', () => {
    const text = prompt(makeReq())
    expect(text).toContain('complete contents the editor file should hold')
    expect(text).toContain('reviews a diff')
    expect(text).toContain('read_editor')
  })
})
