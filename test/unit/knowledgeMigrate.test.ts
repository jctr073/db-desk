/**
 * Unit tests for the v1-to-v2 knowledge migration (migrateLegacyKnowledge in
 * src/main/knowledge.ts): converting the old per-(connection, database) file
 * layout (`knowledge/<connId>/<dbSlug>.json` + a per-connection
 * `repo-roots.json`) into free-standing bases + links.
 *
 * These tests hand-build a v1 layout directly on disk (rather than going
 * through any v1 API, which no longer exists) and drive the migration through
 * the real store so bases/links land through the normal v2 code paths. The
 * `resolveConn` callback is a stub map, mirroring what index.ts wires up from
 * the saved-connections store.
 *
 * Same electron-mocking convention as knowledge.test.ts: `app.getPath`
 * resolves to a fresh per-test temp dir, and `vi.resetModules()` + a dynamic
 * re-import gives each test a cold module-level cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { KnowledgeRecord } from '../../src/shared/knowledge'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  }
}))

let knowledge: typeof import('../../src/main/knowledge')

const KNOWN_CONN = 'c-known'
const KNOWN_CONN_DB = 'analytics'
const KNOWN_CONN_NAME = 'Prod'

const REPO_ONLY_CONN = 'c-repo-only'
const REPO_ONLY_DB = 'analytics'
const REPO_ONLY_NAME = 'Staging'

const UNKNOWN_CONN = 'c-orphan'
const UNKNOWN_CONN_DB = 'legacy_db'

/** Mirrors what index.ts wires up from the saved-connections store. */
function resolver(connId: string): { name: string; database: string } | null {
  if (connId === KNOWN_CONN) return { name: KNOWN_CONN_NAME, database: KNOWN_CONN_DB }
  if (connId === REPO_ONLY_CONN) return { name: REPO_ONLY_NAME, database: REPO_ONLY_DB }
  return null
}

function legacyRecord(id: string, createdAt = 1): KnowledgeRecord {
  return {
    id,
    kind: 'note',
    source: 'human',
    title: 'Legacy note',
    body: 'Carried over from v1.',
    references: [],
    createdAt,
    updatedAt: createdAt
  } as KnowledgeRecord
}

/** Writes a v1 `knowledge/<connId>/<fileName>.json` file directly, bypassing
 * any store API (v1's own API no longer exists). */
function writeLegacyKnowledgeFile(
  connId: string,
  fileName: string,
  rawDatabase: string,
  records: KnowledgeRecord[]
): void {
  const dir = join(userDataDir, 'knowledge', connId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${fileName}.json`),
    JSON.stringify({ version: 1, rawDatabase, records }),
    'utf8'
  )
}

function writeLegacyRepoRoots(entries: Array<{ connId: string; root: string }>): void {
  writeFileSync(
    join(userDataDir, 'repo-roots.json'),
    JSON.stringify(entries),
    'utf8'
  )
}

let repoRootKnown: string
let repoRootStaging: string

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-knowledge-migrate-'))
  repoRootKnown = mkdtempSync(join(tmpdir(), 'db-desk-migrate-repo-known-'))
  repoRootStaging = mkdtempSync(join(tmpdir(), 'db-desk-migrate-repo-staging-'))
  vi.resetModules()
  knowledge = await import('../../src/main/knowledge')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(repoRootKnown, { recursive: true, force: true })
  rmSync(repoRootStaging, { recursive: true, force: true })
})

describe('migrateLegacyKnowledge', () => {
  it('does nothing when there is no legacy layout on disk', () => {
    expect(() => knowledge.migrateLegacyKnowledge(resolver)).not.toThrow()
    expect(knowledge.listBases()).toEqual([])
    expect(knowledge.listLinks()).toEqual([])
  })

  it('converts a known connection\'s v1 file into a named, database-linked base', () => {
    const rec = legacyRecord('kn-1')
    writeLegacyKnowledgeFile(KNOWN_CONN, 'analytics', KNOWN_CONN_DB, [rec])

    knowledge.migrateLegacyKnowledge(resolver)

    const bases = knowledge.listBases()
    expect(bases).toHaveLength(1)
    expect(bases[0].name).toBe(`${KNOWN_CONN_NAME} / ${KNOWN_CONN_DB}`)

    // Records carried over verbatim.
    expect(knowledge.listRecords(bases[0].id).map((r) => r.id)).toEqual(['kn-1'])

    // A database-wide link (no schema) was created for the target.
    const links = knowledge.linksForTarget(KNOWN_CONN, KNOWN_CONN_DB)
    expect(links).toHaveLength(1)
    expect(links[0].kbId).toBe(bases[0].id)
    expect(links[0].schema).toBeUndefined()
  })

  it('names a base after just the database when the connection cannot be resolved', () => {
    writeLegacyKnowledgeFile(UNKNOWN_CONN, 'legacy_db', UNKNOWN_CONN_DB, [
      legacyRecord('kn-orphan')
    ])

    knowledge.migrateLegacyKnowledge(resolver)

    const bases = knowledge.listBases()
    expect(bases).toHaveLength(1)
    expect(bases[0].name).toBe(UNKNOWN_CONN_DB)
    expect(knowledge.linksForTarget(UNKNOWN_CONN, UNKNOWN_CONN_DB)).toHaveLength(1)
  })

  it('falls back to the filename when rawDatabase is missing', () => {
    const dir = join(userDataDir, 'knowledge', UNKNOWN_CONN)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'fallback-name.json'),
      JSON.stringify({ version: 1, records: [] }),
      'utf8'
    )

    knowledge.migrateLegacyKnowledge(resolver)

    expect(knowledge.listBases().map((b) => b.name)).toEqual(['fallback-name'])
  })

  it('attaches a v1 repo root to the base migrated from the same connection', () => {
    writeLegacyKnowledgeFile(KNOWN_CONN, 'analytics', KNOWN_CONN_DB, [
      legacyRecord('kn-1')
    ])
    writeLegacyRepoRoots([{ connId: KNOWN_CONN, root: repoRootKnown }])

    knowledge.migrateLegacyKnowledge(resolver)

    const [base] = knowledge.listBases()
    expect(knowledge.getBaseRepoRoot(base.id)).toBe(repoRootKnown)
  })

  it('turns a repo root with no matching knowledge file into an empty linked base', () => {
    // REPO_ONLY_CONN has no v1 knowledge file, only a repo root.
    writeLegacyRepoRoots([{ connId: REPO_ONLY_CONN, root: repoRootStaging }])

    knowledge.migrateLegacyKnowledge(resolver)

    const bases = knowledge.listBases()
    expect(bases).toHaveLength(1)
    expect(bases[0].name).toBe(`${REPO_ONLY_NAME} / ${REPO_ONLY_DB}`)
    expect(knowledge.listRecords(bases[0].id)).toEqual([])
    expect(knowledge.getBaseRepoRoot(bases[0].id)).toBe(repoRootStaging)
    expect(knowledge.linksForTarget(REPO_ONLY_CONN, REPO_ONLY_DB)).toHaveLength(1)
  })

  it('skips a repo root whose connection cannot be resolved, without crashing', () => {
    writeLegacyRepoRoots([{ connId: UNKNOWN_CONN, root: repoRootStaging }])

    expect(() => knowledge.migrateLegacyKnowledge(resolver)).not.toThrow()
    expect(knowledge.listBases()).toEqual([])
  })

  it('moves the original v1 files to knowledge/legacy-v1/ and repo-roots.legacy-v1.json as backups', () => {
    writeLegacyKnowledgeFile(KNOWN_CONN, 'analytics', KNOWN_CONN_DB, [
      legacyRecord('kn-1')
    ])
    writeLegacyRepoRoots([{ connId: KNOWN_CONN, root: repoRootKnown }])

    knowledge.migrateLegacyKnowledge(resolver)

    // Originals are gone from their old locations…
    expect(existsSync(join(userDataDir, 'knowledge', KNOWN_CONN))).toBe(false)
    expect(existsSync(join(userDataDir, 'repo-roots.json'))).toBe(false)
    // …and recoverable as backups.
    const backupDir = join(userDataDir, 'knowledge', 'legacy-v1', KNOWN_CONN)
    expect(existsSync(backupDir)).toBe(true)
    expect(existsSync(join(backupDir, 'analytics.json'))).toBe(true)
    const backedUpRecord = JSON.parse(
      readFileSync(join(backupDir, 'analytics.json'), 'utf8')
    )
    expect(backedUpRecord.rawDatabase).toBe(KNOWN_CONN_DB)

    const repoRootsBackup = join(userDataDir, 'repo-roots.legacy-v1.json')
    expect(existsSync(repoRootsBackup)).toBe(true)
    expect(JSON.parse(readFileSync(repoRootsBackup, 'utf8'))).toEqual([
      { connId: KNOWN_CONN, root: repoRootKnown }
    ])
  })

  it('backs up an unparseable v1 file instead of losing it, and does not convert it', () => {
    const dir = join(userDataDir, 'knowledge', KNOWN_CONN)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8')

    expect(() => knowledge.migrateLegacyKnowledge(resolver)).not.toThrow()

    expect(knowledge.listBases()).toEqual([])
    const backupDir = join(userDataDir, 'knowledge', 'legacy-v1', KNOWN_CONN)
    expect(existsSync(join(backupDir, 'broken.json'))).toBe(true)
  })

  it('is idempotent: a second run does not duplicate bases or links', () => {
    writeLegacyKnowledgeFile(KNOWN_CONN, 'analytics', KNOWN_CONN_DB, [
      legacyRecord('kn-1')
    ])
    writeLegacyRepoRoots([
      { connId: KNOWN_CONN, root: repoRootKnown },
      { connId: REPO_ONLY_CONN, root: repoRootStaging }
    ])

    knowledge.migrateLegacyKnowledge(resolver)
    const basesAfterFirst = knowledge.listBases()
    const linksAfterFirst = knowledge.listLinks()

    // Nothing legacy is left on disk, so a second run should be a pure no-op.
    knowledge.migrateLegacyKnowledge(resolver)

    expect(knowledge.listBases()).toEqual(basesAfterFirst)
    expect(knowledge.listLinks()).toEqual(linksAfterFirst)
  })

  it('gives every migrated base a unique name when two v1 targets would collide', () => {
    writeLegacyKnowledgeFile(KNOWN_CONN, 'db1', KNOWN_CONN_DB, [])
    // A second, distinct connection that resolves to the exact same
    // "name / database" combination.
    const dupeConn = 'c-known-dupe'
    const dupeResolver = (connId: string): { name: string; database: string } | null =>
      connId === dupeConn
        ? { name: KNOWN_CONN_NAME, database: KNOWN_CONN_DB }
        : resolver(connId)
    writeLegacyKnowledgeFile(dupeConn, 'db2', KNOWN_CONN_DB, [])

    knowledge.migrateLegacyKnowledge(dupeResolver)

    const names = knowledge.listBases().map((b) => b.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain(`${KNOWN_CONN_NAME} / ${KNOWN_CONN_DB}`)
    expect(names.some((n) => n === `${KNOWN_CONN_NAME} / ${KNOWN_CONN_DB} (2)`)).toBe(
      true
    )
  })
})
