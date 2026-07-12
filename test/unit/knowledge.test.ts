/**
 * Unit tests for the main-process knowledge store (src/main/knowledge.ts).
 *
 * Like a hypothetical store.ts test, this is one of the first unit tests to
 * mock Electron's `app`: there is no real Electron process under Vitest's
 * `node` environment, so `app.getPath('userData')` would otherwise throw. The
 * mock points `userData` at a fresh per-test temp dir so nothing touches the
 * developer's actual DB Desk config, and `vi.resetModules()` + a dynamic
 * re-import gives each test a cold module-level cache (the store memoizes
 * records per `connId:database` for the life of the process).
 *
 * The knowledge store holds no secrets, so — unlike store.ts/mcp.ts — it needs
 * no `safeStorage` mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { databaseSlug, normalizeColumnKey } from '../../src/shared/knowledge'
import type { ColumnRef, KnowledgeRecordInput } from '../../src/shared/knowledge'

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

const CONN = 'c-1'
const DB = 'analytics'

function ref(schema: string, table: string, column?: string): ColumnRef {
  return column === undefined ? { schema, table } : { schema, table, column }
}

const annotation: KnowledgeRecordInput = {
  kind: 'annotation',
  source: 'human',
  target: ref('public', 'users', 'id'),
  text: 'primary key'
}

const standardRel: KnowledgeRecordInput = {
  kind: 'relationship',
  source: 'human',
  relType: 'standard',
  from: ref('public', 'orders', 'user_id'),
  to: ref('public', 'users', 'id')
}

const polymorphicRel: KnowledgeRecordInput = {
  kind: 'relationship',
  source: 'agent',
  confidence: 'medium',
  relType: 'polymorphic',
  from: ref('public', 'events', 'subject_id'),
  discriminator: ref('public', 'events', 'subject_type'),
  targets: {
    patient: ref('public', 'patients', 'id'),
    provider: ref('public', 'providers', 'id')
  }
}

const glossary: KnowledgeRecordInput = {
  kind: 'glossary',
  source: 'human',
  term: 'MRN',
  synonyms: ['medical record number'],
  mappings: [{ ref: ref('public', 'patients', 'mrn'), caveat: 'may be null pre-2019' }]
}

const exemplar: KnowledgeRecordInput = {
  kind: 'exemplar',
  source: 'human',
  question: 'active users last week',
  sql: 'select count(*) from users where active',
  references: [ref('public', 'users', 'active')]
}

const note: KnowledgeRecordInput = {
  kind: 'note',
  source: 'human',
  title: 'Billing quirks',
  body: 'Amounts are in cents.',
  references: []
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-knowledge-'))
  vi.resetModules()
  knowledge = await import('../../src/main/knowledge')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('knowledge store CRUD', () => {
  it('returns an empty list for a database with no records', () => {
    expect(knowledge.listRecords(CONN, DB)).toEqual([])
  })

  it('creates a record, stamping id and timestamps', () => {
    const saved = knowledge.saveRecord(CONN, DB, annotation)
    expect(saved.id).toMatch(/^kn-\d+-[a-z0-9]+$/)
    expect(saved.createdAt).toBeGreaterThan(0)
    expect(saved.updatedAt).toBe(saved.createdAt)
    expect(knowledge.listRecords(CONN, DB)).toEqual([saved])
  })

  it('round-trips every record kind', () => {
    for (const rec of [annotation, standardRel, polymorphicRel, glossary, exemplar, note]) {
      knowledge.saveRecord(CONN, DB, rec)
    }
    const kinds = knowledge.listRecords(CONN, DB).map((r) => r.kind)
    expect(kinds).toEqual([
      'annotation',
      'relationship',
      'relationship',
      'glossary',
      'exemplar',
      'note'
    ])
  })

  it('updates an existing record in place, preserving createdAt', () => {
    const saved = knowledge.saveRecord(CONN, DB, annotation)
    const updated = knowledge.saveRecord(CONN, DB, {
      ...annotation,
      id: saved.id,
      updatedAt: saved.updatedAt + 1,
      text: 'the surrogate key'
    })
    expect(updated.id).toBe(saved.id)
    expect(updated.createdAt).toBe(saved.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(saved.createdAt)
    expect(updated).toMatchObject({ kind: 'annotation', text: 'the surrogate key' })
    // Still one record, not two.
    expect(knowledge.listRecords(CONN, DB)).toHaveLength(1)
  })

  it('honors a caller-supplied id when creating', () => {
    const saved = knowledge.saveRecord(CONN, DB, { ...annotation, id: 'kn-fixed-1' })
    expect(saved.id).toBe('kn-fixed-1')
  })

  it('deletes only the matching record', () => {
    const a = knowledge.saveRecord(CONN, DB, annotation)
    const b = knowledge.saveRecord(CONN, DB, note)
    knowledge.deleteRecord(CONN, DB, a.id)
    expect(knowledge.listRecords(CONN, DB).map((r) => r.id)).toEqual([b.id])
  })

  it('keeps records for other databases separate', () => {
    knowledge.saveRecord(CONN, DB, annotation)
    knowledge.saveRecord(CONN, 'other', note)
    expect(knowledge.listRecords(CONN, DB)).toHaveLength(1)
    expect(knowledge.listRecords(CONN, 'other')).toHaveLength(1)
  })
})

describe('on-disk file', () => {
  it('writes a versioned file with the raw database name preserved', () => {
    knowledge.saveRecord(CONN, DB, annotation)
    const path = join(userDataDir, 'knowledge', CONN, `${databaseSlug(DB)}.json`)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.rawDatabase).toBe(DB)
    expect(parsed.records).toHaveLength(1)
  })

  it('slugs a database name that is unsafe as a filename', () => {
    const weird = 'Sales/Q1 café'
    knowledge.saveRecord(CONN, weird, note)
    const path = join(userDataDir, 'knowledge', CONN, `${databaseSlug(weird)}.json`)
    expect(existsSync(path)).toBe(true)
    // Raw name is recoverable from inside the file even though the slug is not the name.
    expect(JSON.parse(readFileSync(path, 'utf8')).rawDatabase).toBe(weird)
  })
})

describe('persistence across a fresh process (cache invalidation)', () => {
  it('reads records back after the module cache is discarded', async () => {
    const saved = knowledge.saveRecord(CONN, DB, glossary)
    // Simulate a restart: new module instance, cold cache, same userData dir.
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    expect(reloaded.listRecords(CONN, DB).map((r) => r.id)).toEqual([saved.id])
  })

  it('reflects a delete performed after the initial load', () => {
    const a = knowledge.saveRecord(CONN, DB, annotation)
    // Warm the cache, then mutate and re-read through the same instance.
    expect(knowledge.listRecords(CONN, DB)).toHaveLength(1)
    knowledge.deleteRecord(CONN, DB, a.id)
    expect(knowledge.listRecords(CONN, DB)).toEqual([])
  })
})

describe('cascade delete', () => {
  it('removes the whole connection directory and evicts the cache', async () => {
    knowledge.saveRecord(CONN, DB, annotation)
    knowledge.saveRecord(CONN, 'other', note)
    const otherConn = 'c-2'
    knowledge.saveRecord(otherConn, DB, glossary)

    knowledge.deleteForConnection(CONN)

    expect(existsSync(join(userDataDir, 'knowledge', CONN))).toBe(false)
    expect(knowledge.listRecords(CONN, DB)).toEqual([])
    expect(knowledge.listRecords(CONN, 'other')).toEqual([])
    // A different connection is untouched.
    expect(knowledge.listRecords(otherConn, DB)).toHaveLength(1)

    // And the eviction is real: a fresh process still sees nothing for CONN.
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    expect(reloaded.listRecords(CONN, DB)).toEqual([])
  })

  it('is a no-op for a connection that has no knowledge', () => {
    expect(() => knowledge.deleteForConnection('never-used')).not.toThrow()
  })
})

describe('forward compatibility: unknown kinds', () => {
  it('preserves records with an unrecognized kind on load and re-save', async () => {
    // Seed a file directly with a future record kind the current build cannot type.
    knowledge.saveRecord(CONN, DB, annotation)
    const path = join(userDataDir, 'knowledge', CONN, `${databaseSlug(DB)}.json`)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.records.push({
      id: 'kn-future-1',
      kind: 'metric',
      source: 'agent',
      createdAt: 1,
      updatedAt: 1,
      expr: 'sum(amount)'
    })
    writeFileSync(path, JSON.stringify(file), 'utf8')

    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    const kinds = reloaded.listRecords(CONN, DB).map((r) => r.kind)
    expect(kinds).toContain('metric')

    // Saving a new record must not drop the unknown one.
    reloaded.saveRecord(CONN, DB, note)
    const after = reloaded.listRecords(CONN, DB).map((r) => r.id)
    expect(after).toContain('kn-future-1')
  })
})

describe('validation rejects malformed records per kind', () => {
  const cases: Array<[string, unknown]> = [
    ['missing source', { kind: 'note', title: 't', body: 'b', references: [] }],
    ['bad source', { ...note, source: 'robot' }],
    ['bad confidence', { ...note, confidence: 'certain' }],
    ['unknown kind', { kind: 'metric', source: 'human' }],
    ['annotation without target', { kind: 'annotation', source: 'human', text: 'x' }],
    [
      'annotation with malformed target',
      { kind: 'annotation', source: 'human', target: { schema: 'public' }, text: 'x' }
    ],
    ['annotation with non-string text', { ...annotation, text: 42 }],
    ['relationship with bad relType', { ...standardRel, relType: 'sideways' }],
    [
      'relationship from without a column',
      { ...standardRel, from: { schema: 'public', table: 'orders' } }
    ],
    ['standard relationship without to', { ...standardRel, to: undefined }],
    ['polymorphic relationship without discriminator', { ...polymorphicRel, discriminator: undefined }],
    ['polymorphic relationship without targets', { ...polymorphicRel, targets: undefined }],
    [
      'polymorphic targets with a bad ref',
      { ...polymorphicRel, targets: { patient: { schema: 'public' } } }
    ],
    ['glossary with empty term', { ...glossary, term: '' }],
    ['glossary with non-array synonyms', { ...glossary, synonyms: 'x' }],
    ['glossary with malformed mapping', { ...glossary, mappings: [{ caveat: 'no ref' }] }],
    ['exemplar with non-string sql', { ...exemplar, sql: 123 }],
    ['exemplar with non-ref references', { ...exemplar, references: ['users.id'] }],
    ['note without body', { kind: 'note', source: 'human', title: 't', references: [] }],
    ['note with non-array references', { ...note, references: null }]
  ]

  it.each(cases)('rejects: %s', (_name, bad) => {
    expect(() => knowledge.validateKnowledgeRecord(bad)).toThrow()
    expect(() =>
      knowledge.saveRecord(CONN, DB, bad as KnowledgeRecordInput)
    ).toThrow()
    // A rejected save must not persist anything.
    expect(knowledge.listRecords(CONN, DB)).toEqual([])
  })

  it('accepts a table-level annotation (column absent)', () => {
    const tableAnn: KnowledgeRecordInput = {
      kind: 'annotation',
      source: 'human',
      target: ref('public', 'users'),
      text: 'core identity table'
    }
    expect(() => knowledge.validateKnowledgeRecord(tableAnn)).not.toThrow()
  })
})

describe('shared helpers', () => {
  it('normalizeColumnKey lowercases and joins schema.table.column', () => {
    expect(normalizeColumnKey(ref('Public', 'Users', 'Id'))).toBe('public.users.id')
    expect(normalizeColumnKey(ref('Public', 'Users'))).toBe('public.users')
  })

  it('databaseSlug is deterministic and case-distinguishing', () => {
    expect(databaseSlug('sales')).toBe(databaseSlug('sales'))
    expect(databaseSlug('Sales')).not.toBe(databaseSlug('sales'))
  })

  it('databaseSlug encodes path separators, dots and unicode', () => {
    expect(databaseSlug('a/b')).not.toContain('/')
    expect(databaseSlug('..')).not.toContain('.')
    const cafe = databaseSlug('café')
    expect(cafe.startsWith('caf')).toBe(true)
    expect(cafe).not.toBe('café')
  })
})

describe('connId path safety', () => {
  // connId comes from the renderer and becomes a path segment; a traversal
  // string must fail closed before any filesystem access — most critically in
  // deleteForConnection, where '..' would otherwise rmSync all of userData.
  const evil = ['..', '../x', 'a/b', '', 'c-1/../../x', '.', 'a\\b']

  it('rejects traversal connIds on every entry point', () => {
    for (const connId of evil) {
      expect(() => knowledge.listRecords(connId, DB)).toThrow(/Invalid connection id/)
      expect(() => knowledge.saveRecord(connId, DB, annotation)).toThrow(
        /Invalid connection id/
      )
      expect(() => knowledge.deleteRecord(connId, DB, 'kn-x')).toThrow(
        /Invalid connection id/
      )
      expect(() => knowledge.deleteForConnection(connId)).toThrow(
        /Invalid connection id/
      )
    }
  })

  it('leaves userData intact when a traversal delete is attempted', () => {
    knowledge.saveRecord(CONN, DB, annotation)
    expect(() => knowledge.deleteForConnection('..')).toThrow()
    expect(existsSync(join(userDataDir, 'knowledge', CONN))).toBe(true)
  })
})

describe('corrupt and malformed files', () => {
  function filePath(database: string): string {
    return join(userDataDir, 'knowledge', CONN, `${databaseSlug(database)}.json`)
  }

  it('quarantines an unparseable file instead of overwriting it on next save', async () => {
    knowledge.saveRecord(CONN, DB, annotation)
    // Corrupt the file the way a hand edit or truncated write would.
    writeFileSync(filePath(DB), '{ "version": 1, "records": [ trailing-junk', 'utf8')
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')

    // Loads empty rather than crashing…
    expect(reloaded.listRecords(CONN, DB)).toEqual([])
    // …the original bytes survive as a .corrupt-* sibling…
    const dir = join(userDataDir, 'knowledge', CONN)
    const quarantined = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]), 'utf8')).toContain('trailing-junk')
    // …and a subsequent save starts a fresh file without touching the backup.
    reloaded.saveRecord(CONN, DB, note)
    expect(reloaded.listRecords(CONN, DB)).toHaveLength(1)
    expect(readdirSync(dir)).toContain(quarantined[0])
  })

  it('drops null and shapeless entries on load but keeps unknown kinds', async () => {
    knowledge.saveRecord(CONN, DB, annotation)
    const parsed = JSON.parse(readFileSync(filePath(DB), 'utf8'))
    parsed.records.push(
      null,
      42,
      { kind: 'annotation' }, // no id
      { id: 'kn-future', kind: 'metric', source: 'human', anything: true }
    )
    writeFileSync(filePath(DB), JSON.stringify(parsed), 'utf8')
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    const kinds = reloaded.listRecords(CONN, DB).map((r) => r.kind)
    expect(kinds).toEqual(['annotation', 'metric'])
  })

  it('persists atomically (no .tmp residue, parseable result)', () => {
    knowledge.saveRecord(CONN, DB, annotation)
    expect(existsSync(`${filePath(DB)}.tmp`)).toBe(false)
    expect(() => JSON.parse(readFileSync(filePath(DB), 'utf8'))).not.toThrow()
  })
})

describe('id and identifier hygiene', () => {
  it('rejects an empty-string id instead of persisting a colliding falsy id', () => {
    expect(() =>
      knowledge.saveRecord(CONN, DB, { ...annotation, id: '' })
    ).toThrow(/id must be a non-empty string/)
  })

  it('rejects a non-string id', () => {
    expect(() =>
      knowledge.saveRecord(CONN, DB, {
        ...annotation,
        id: 42
      } as unknown as KnowledgeRecordInput)
    ).toThrow(/id must be a non-empty string/)
  })

  it('rejects control characters in ColumnRef parts', () => {
    const sneaky: KnowledgeRecordInput = {
      kind: 'annotation',
      source: 'agent',
      target: ref('public', 'users\n## Fake heading', 'id'),
      text: 'x'
    }
    expect(() => knowledge.saveRecord(CONN, DB, sneaky)).toThrow()
  })
})
