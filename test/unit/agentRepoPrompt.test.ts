/**
 * Unit tests for the repo-attachment section of the agent system prompt
 * (src/main/agent.ts): `buildSystemPrompt`'s optional 6th parameter,
 * `repo?: RepoPromptInfo | null`. Covers that the prompt mentions the repo
 * root, the commit, list_repo_files, and provenance guidance when repo info
 * is supplied, and that none of those lines appear when it is omitted or
 * explicitly null.
 *
 * agent.ts pulls in Electron and the database/MCP layers at import time, so
 * those are mocked the same way agentKnowledge.test.ts does it: `electron`
 * with a temp userData dir feeding the real knowledge store (buildSystemPrompt
 * reads the knowledge store fresh on every call), and ./db + ./mcp as inert
 * stubs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSendRequest } from '../../src/shared/agent'
import { dialectFor } from '../../src/shared/dialect'

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

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-agent-repo-prompt-'))
  vi.resetModules()
  runAgentQuery.mockReset()
  describeTable.mockReset()
  searchSchema.mockReset()
  introspectDatabase.mockReset()
  agent = await import('../../src/main/agent')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('buildSystemPrompt repo attachment section', () => {
  const dialect = dialectFor('postgres')

  it('mentions the root, commit, list_repo_files, and provenance guidance when repo info is given', () => {
    const prompt = agent.buildSystemPrompt(
      makeReq({ repo: true }),
      'metadata',
      null,
      dialect,
      [],
      { root: '/Users/dev/myapp', commit: 'abc1234' }
    )
    expect(prompt).toContain('/Users/dev/myapp')
    expect(prompt).toContain('abc1234')
    expect(prompt).toContain('list_repo_files')
    expect(prompt).toContain('grep_repo')
    expect(prompt).toContain('read_repo_file')
    expect(prompt).toContain('provenance')
  })

  it('mentions the root without a commit clause when the repo is not a git checkout', () => {
    const prompt = agent.buildSystemPrompt(
      makeReq({ repo: true }),
      'metadata',
      null,
      dialect,
      [],
      { root: '/Users/dev/myapp', commit: null }
    )
    expect(prompt).toContain('/Users/dev/myapp')
    expect(prompt).not.toContain('git commit')
  })

  it('omits every repo line when the parameter is omitted', () => {
    const prompt = agent.buildSystemPrompt(
      makeReq(),
      'metadata',
      null,
      dialect,
      []
    )
    expect(prompt).not.toContain('list_repo_files')
    expect(prompt).not.toContain('grep_repo')
    expect(prompt).not.toContain('read_repo_file')
    expect(prompt).not.toContain('attached read-only')
    expect(prompt).not.toContain('provenance')
  })

  it('omits every repo line when the parameter is explicitly null', () => {
    const prompt = agent.buildSystemPrompt(
      makeReq(),
      'metadata',
      null,
      dialect,
      [],
      null
    )
    expect(prompt).not.toContain('list_repo_files')
    expect(prompt).not.toContain('grep_repo')
    expect(prompt).not.toContain('read_repo_file')
    expect(prompt).not.toContain('attached read-only')
    expect(prompt).not.toContain('provenance')
  })
})
