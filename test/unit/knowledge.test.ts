/**
 * Unit tests for the main-process knowledge store (src/main/knowledge.ts).
 *
 * v2 of the store holds free-standing knowledge bases (`knowledge/bases/
 * <kbId>.json`) plus a link table (`knowledge/links.json`) attaching bases to
 * (connection, database, schema) targets — every link is schema-scoped. This
 * file covers base CRUD, record CRUD per base, link CRUD/dedupe, target
 * aggregation (groupsForTarget/linksForTarget/defaultKbForTarget), path
 * safety, corrupt-file quarantine, and wipeAll. The migrations
 * (migrateLegacyKnowledge, migrateLinksToSchemaScope) have their own file:
 * knowledgeMigrate.test.ts.
 *
 * Like a hypothetical store.ts test, this is one of the first unit tests to
 * mock Electron's `app`: there is no real Electron process under Vitest's
 * `node` environment, so `app.getPath('userData')` would otherwise throw. The
 * mock points `userData` at a fresh per-test temp dir so nothing touches the
 * developer's actual DB Desk config, and `vi.resetModules()` + a dynamic
 * re-import gives each test a cold module-level cache (the store memoizes
 * loaded bases and the link table for the life of the process).
 *
 * Several tests need deterministic ordering by `createdAt` (link precedence,
 * base listing) even though the store mints timestamps from `Date.now()`
 * internally; those use `vi.useFakeTimers()` + `vi.setSystemTime()` rather
 * than relying on real wall-clock gaps between calls.
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

import type {
  ColumnRef,
  KnowledgeLinkInput,
  KnowledgeRecordInput
} from '../../src/shared/knowledge'

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

function basesDir(): string {
  return join(userDataDir, 'knowledge', 'bases')
}

function basePath(kbId: string): string {
  return join(basesDir(), `${kbId}.json`)
}

function linksPath(): string {
  return join(userDataDir, 'knowledge', 'links.json')
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
  mappings: [
    { ref: ref('public', 'patients', 'mrn'), caveat: 'may be null pre-2019' }
  ]
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
  vi.useRealTimers()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('knowledge base CRUD', () => {
  it('creates a base with a null repo root and stamped, equal timestamps', () => {
    const base = knowledge.createBase('Sales repo')
    expect(base.id).toMatch(/^kb-\d+-[a-z0-9]+$/)
    expect(base.name).toBe('Sales repo')
    expect(base.repoRoot).toBeNull()
    expect(base.createdAt).toBeGreaterThan(0)
    expect(base.updatedAt).toBe(base.createdAt)
  })

  it('trims the name', () => {
    const base = knowledge.createBase('  Sales repo  ')
    expect(base.name).toBe('Sales repo')
  })

  it('getBase returns the created base', () => {
    const base = knowledge.createBase('Sales repo')
    expect(knowledge.getBase(base.id)).toEqual(base)
  })

  it('getBase returns null for an unknown id', () => {
    expect(knowledge.getBase('kb-nope')).toBeNull()
  })

  it('lists bases with derived record and link counts, oldest first', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const first = knowledge.createBase('First')
    vi.setSystemTime(2_000)
    const second = knowledge.createBase('Second')
    knowledge.saveRecord(second.id, annotation)
    knowledge.addLink({ kbId: second.id, connId: CONN, database: DB, schema: 'public' })
    vi.useRealTimers()

    const summaries = knowledge.listBases()
    expect(summaries.map((b) => b.id)).toEqual([first.id, second.id])
    expect(summaries[0]).toMatchObject({ recordCount: 0, linkCount: 0 })
    expect(summaries[1]).toMatchObject({ recordCount: 1, linkCount: 1 })
  })

  it('lists no bases when none exist', () => {
    expect(knowledge.listBases()).toEqual([])
  })

  it('renameBase updates the name and updatedAt but preserves id and createdAt', () => {
    const base = knowledge.createBase('Old name')
    const renamed = knowledge.renameBase(base.id, 'New name')
    expect(renamed.id).toBe(base.id)
    expect(renamed.createdAt).toBe(base.createdAt)
    expect(renamed.name).toBe('New name')
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(base.createdAt)
    // Persisted, not just returned.
    expect(knowledge.getBase(base.id)?.name).toBe('New name')
  })

  it('renameBase throws for an unknown base', () => {
    expect(() => knowledge.renameBase('kb-nope', 'x')).toThrow(
      /Unknown knowledge base/
    )
  })

  it('deleteBase removes the base file, evicts the cache, and drops its links', () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    knowledge.addLink({ kbId: base.id, connId: 'c-2', database: 'other', schema: 'public' })
    expect(existsSync(basePath(base.id))).toBe(true)

    knowledge.deleteBase(base.id)

    expect(existsSync(basePath(base.id))).toBe(false)
    expect(knowledge.getBase(base.id)).toBeNull()
    expect(knowledge.listLinks()).toEqual([])
  })

  it('deleteBase leaves links to other bases untouched', () => {
    const kept = knowledge.createBase('Kept')
    const doomed = knowledge.createBase('Doomed')
    const survivor = knowledge.addLink({
      kbId: kept.id,
      connId: CONN,
      database: DB,
      schema: 'public'
    })
    knowledge.addLink({ kbId: doomed.id, connId: CONN, database: DB, schema: 'public' })

    knowledge.deleteBase(doomed.id)

    expect(knowledge.listLinks()).toEqual([survivor])
  })

  it('deleteBase is a no-op for an unknown id', () => {
    expect(() => knowledge.deleteBase('kb-nope')).not.toThrow()
  })
})

describe('base name validation', () => {
  const cases: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['too long', 'x'.repeat(121)],
    ['contains a newline', 'a\nb'],
    ['contains a control character', 'a\x00b'],
    ['non-string', 42]
  ]

  it.each(cases)('createBase rejects: %s', (_name, bad) => {
    expect(() => knowledge.createBase(bad as string)).toThrow()
    expect(knowledge.listBases()).toEqual([])
  })

  it.each(cases)('renameBase rejects: %s', (_name, bad) => {
    const base = knowledge.createBase('ok')
    expect(() => knowledge.renameBase(base.id, bad as string)).toThrow()
    // Rejected rename must not persist a mutation.
    expect(knowledge.getBase(base.id)?.name).toBe('ok')
  })

  it('accepts a name at exactly the length limit', () => {
    const name = 'x'.repeat(120)
    expect(() => knowledge.createBase(name)).not.toThrow()
  })
})

describe('base repo root attachment', () => {
  it('round-trips a real, existing path', () => {
    const base = knowledge.createBase('Repo base')
    const codeDir = mkdtempSync(join(tmpdir(), 'db-desk-knowledge-repo-'))
    try {
      const updated = knowledge.setBaseRepoRoot(base.id, codeDir)
      expect(updated.repoRoot).toBe(codeDir)
      expect(knowledge.getBaseRepoRoot(base.id)).toBe(codeDir)
    } finally {
      rmSync(codeDir, { recursive: true, force: true })
    }
  })

  it('reads back null once the root has vanished from disk', () => {
    const base = knowledge.createBase('Repo base')
    const codeDir = mkdtempSync(join(tmpdir(), 'db-desk-knowledge-repo-'))
    knowledge.setBaseRepoRoot(base.id, codeDir)
    rmSync(codeDir, { recursive: true, force: true })
    expect(knowledge.getBaseRepoRoot(base.id)).toBeNull()
  })

  it('clears the root with null', () => {
    const base = knowledge.createBase('Repo base')
    const codeDir = mkdtempSync(join(tmpdir(), 'db-desk-knowledge-repo-'))
    try {
      knowledge.setBaseRepoRoot(base.id, codeDir)
      knowledge.setBaseRepoRoot(base.id, null)
      expect(knowledge.getBaseRepoRoot(base.id)).toBeNull()
      expect(knowledge.getBase(base.id)?.repoRoot).toBeNull()
    } finally {
      rmSync(codeDir, { recursive: true, force: true })
    }
  })

  it('getBaseRepoRoot returns null for an unknown base', () => {
    expect(knowledge.getBaseRepoRoot('kb-nope')).toBeNull()
  })

  it('setBaseRepoRoot throws for an unknown base', () => {
    expect(() => knowledge.setBaseRepoRoot('kb-nope', '/tmp')).toThrow(
      /Unknown knowledge base/
    )
  })
})

describe('record CRUD per base', () => {
  let baseId: string

  beforeEach(() => {
    baseId = knowledge.createBase('B').id
  })

  it('returns an empty list for a fresh base', () => {
    expect(knowledge.listRecords(baseId)).toEqual([])
  })

  it('creates a record, stamping id and timestamps', () => {
    const saved = knowledge.saveRecord(baseId, annotation)
    expect(saved.id).toMatch(/^kn-\d+-[a-z0-9]+$/)
    expect(saved.createdAt).toBeGreaterThan(0)
    expect(saved.updatedAt).toBe(saved.createdAt)
    expect(knowledge.listRecords(baseId)).toEqual([saved])
  })

  it('round-trips every record kind', () => {
    for (const rec of [
      annotation,
      standardRel,
      polymorphicRel,
      glossary,
      exemplar,
      note
    ]) {
      knowledge.saveRecord(baseId, rec)
    }
    const kinds = knowledge.listRecords(baseId).map((r) => r.kind)
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
    const saved = knowledge.saveRecord(baseId, annotation)
    const updated = knowledge.saveRecord(baseId, {
      ...annotation,
      id: saved.id,
      text: 'the surrogate key'
    })
    expect(updated.id).toBe(saved.id)
    expect(updated.createdAt).toBe(saved.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(saved.createdAt)
    expect(updated).toMatchObject({
      kind: 'annotation',
      text: 'the surrogate key'
    })
    // Still one record, not two.
    expect(knowledge.listRecords(baseId)).toHaveLength(1)
  })

  it('honors a caller-supplied id when creating', () => {
    const saved = knowledge.saveRecord(baseId, { ...annotation, id: 'kn-fixed-1' })
    expect(saved.id).toBe('kn-fixed-1')
  })

  it('deletes only the matching record', () => {
    const a = knowledge.saveRecord(baseId, annotation)
    const b = knowledge.saveRecord(baseId, note)
    knowledge.deleteRecord(baseId, a.id)
    expect(knowledge.listRecords(baseId).map((r) => r.id)).toEqual([b.id])
  })

  it('keeps records for other bases separate', () => {
    const other = knowledge.createBase('Other').id
    knowledge.saveRecord(baseId, annotation)
    knowledge.saveRecord(other, note)
    expect(knowledge.listRecords(baseId)).toHaveLength(1)
    expect(knowledge.listRecords(other)).toHaveLength(1)
  })

  it('saveRecord throws for an unknown base', () => {
    expect(() => knowledge.saveRecord('kb-nope', annotation)).toThrow(
      /Unknown knowledge base/
    )
  })

  it('deleteRecord is a no-op for an unknown record id', () => {
    knowledge.saveRecord(baseId, annotation)
    expect(() => knowledge.deleteRecord(baseId, 'kn-nope')).not.toThrow()
    expect(knowledge.listRecords(baseId)).toHaveLength(1)
  })

  it('deleteRecord is a no-op for an unknown base', () => {
    expect(() => knowledge.deleteRecord('kb-nope', 'kn-x')).not.toThrow()
  })

  it('reads records back after the module cache is discarded', async () => {
    const saved = knowledge.saveRecord(baseId, glossary)
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    expect(reloaded.listRecords(baseId).map((r) => r.id)).toEqual([saved.id])
  })
})

describe('forward compatibility: unknown kinds', () => {
  it('preserves records with an unrecognized kind on load and re-save', async () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    const path = basePath(base.id)
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
    const kinds = reloaded.listRecords(base.id).map((r) => r.kind)
    expect(kinds).toContain('metric')

    // Saving a new record must not drop the unknown one.
    reloaded.saveRecord(base.id, note)
    const after = reloaded.listRecords(base.id).map((r) => r.id)
    expect(after).toContain('kn-future-1')
  })
})

describe('validation rejects malformed records per kind', () => {
  const cases: Array<[string, unknown]> = [
    ['missing source', { kind: 'note', title: 't', body: 'b', references: [] }],
    ['bad source', { ...note, source: 'robot' }],
    ['bad confidence', { ...note, confidence: 'certain' }],
    ['unknown kind', { kind: 'metric', source: 'human' }],
    [
      'annotation without target',
      { kind: 'annotation', source: 'human', text: 'x' }
    ],
    [
      'annotation with malformed target',
      {
        kind: 'annotation',
        source: 'human',
        target: { schema: 'public' },
        text: 'x'
      }
    ],
    ['annotation with non-string text', { ...annotation, text: 42 }],
    ['relationship with bad relType', { ...standardRel, relType: 'sideways' }],
    [
      'relationship from without a column',
      { ...standardRel, from: { schema: 'public', table: 'orders' } }
    ],
    ['standard relationship without to', { ...standardRel, to: undefined }],
    [
      'polymorphic relationship without discriminator',
      { ...polymorphicRel, discriminator: undefined }
    ],
    [
      'polymorphic relationship without targets',
      { ...polymorphicRel, targets: undefined }
    ],
    [
      'polymorphic targets with a bad ref',
      { ...polymorphicRel, targets: { patient: { schema: 'public' } } }
    ],
    ['glossary with empty term', { ...glossary, term: '' }],
    ['glossary with non-array synonyms', { ...glossary, synonyms: 'x' }],
    [
      'glossary with malformed mapping',
      { ...glossary, mappings: [{ caveat: 'no ref' }] }
    ],
    ['exemplar with non-string sql', { ...exemplar, sql: 123 }],
    [
      'exemplar with non-ref references',
      { ...exemplar, references: ['users.id'] }
    ],
    [
      'note without body',
      { kind: 'note', source: 'human', title: 't', references: [] }
    ],
    ['note with non-array references', { ...note, references: null }]
  ]

  it.each(cases)('rejects: %s', (_name, bad) => {
    const baseId = knowledge.createBase('B').id
    expect(() => knowledge.validateKnowledgeRecord(bad)).toThrow()
    expect(() =>
      knowledge.saveRecord(baseId, bad as KnowledgeRecordInput)
    ).toThrow()
    // A rejected save must not persist anything.
    expect(knowledge.listRecords(baseId)).toEqual([])
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

describe('id and identifier hygiene', () => {
  let baseId: string

  beforeEach(() => {
    baseId = knowledge.createBase('B').id
  })

  it('rejects an empty-string id instead of persisting a colliding falsy id', () => {
    expect(() =>
      knowledge.saveRecord(baseId, { ...annotation, id: '' })
    ).toThrow(/id must be a non-empty string/)
  })

  it('rejects a non-string id', () => {
    expect(() =>
      knowledge.saveRecord(baseId, {
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
    expect(() => knowledge.saveRecord(baseId, sneaky)).toThrow()
  })
})

describe('links', () => {
  it('creates a schema-scoped link', () => {
    const base = knowledge.createBase('B')
    const link = knowledge.addLink({
      kbId: base.id,
      connId: CONN,
      database: DB,
      schema: 'analytics'
    })
    expect(link.id).toMatch(/^kl-\d+-[a-z0-9]+$/)
    expect(link.schema).toBe('analytics')
    expect(link.createdAt).toBeGreaterThan(0)
    expect(knowledge.listLinks()).toEqual([link])
  })

  it('rejects a link without a schema — links exist only at the schema level', () => {
    const base = knowledge.createBase('B')
    expect(() =>
      knowledge.addLink({
        kbId: base.id,
        connId: CONN,
        database: DB
      } as unknown as KnowledgeLinkInput)
    ).toThrow(/Link schema/)
    expect(knowledge.listLinks()).toEqual([])
  })

  it('dedupes an identical link (same base, target and scope)', () => {
    const base = knowledge.createBase('B')
    const first = knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    const second = knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    expect(second).toEqual(first)
    expect(knowledge.listLinks()).toHaveLength(1)
  })

  it('does not dedupe links scoped to different schemas', () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'a' })
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'b' })
    expect(knowledge.listLinks()).toHaveLength(2)
  })

  it('allows the same base linked to multiple targets', () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    knowledge.addLink({ kbId: base.id, connId: 'c-2', database: 'other', schema: 'public' })
    expect(knowledge.listLinks()).toHaveLength(2)
  })

  it('addLink throws for an unknown base', () => {
    expect(() =>
      knowledge.addLink({ kbId: 'kb-nope', connId: CONN, database: DB, schema: 'public' })
    ).toThrow(/Unknown knowledge base/)
  })

  it('addLink validates the database name', () => {
    const base = knowledge.createBase('B')
    expect(() =>
      knowledge.addLink({ kbId: base.id, connId: CONN, database: '', schema: 'public' })
    ).toThrow(/Link database/)
  })

  it('addLink validates the schema name', () => {
    const base = knowledge.createBase('B')
    expect(() =>
      knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: '  ' })
    ).toThrow(/Link schema/)
  })

  it('removeLink drops one link without touching others', () => {
    const base = knowledge.createBase('B')
    const a = knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    const b = knowledge.addLink({ kbId: base.id, connId: 'c-2', database: DB, schema: 'public' })
    knowledge.removeLink(a.id)
    expect(knowledge.listLinks()).toEqual([b])
  })

  it('removeLink is a no-op for an unknown id', () => {
    expect(() => knowledge.removeLink('kl-nope')).not.toThrow()
  })
})

describe('linksForTarget, defaultKbForTarget and pickDefaultLink ordering', () => {
  it('linksForTarget returns links for the target, oldest first', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const b1 = knowledge.createBase('B1')
    const l1 = knowledge.addLink({ kbId: b1.id, connId: CONN, database: DB, schema: 'public' })
    vi.setSystemTime(2_000)
    const b2 = knowledge.createBase('B2')
    const l2 = knowledge.addLink({ kbId: b2.id, connId: CONN, database: DB, schema: 'public' })
    // A link for a different target must not appear.
    knowledge.addLink({ kbId: b2.id, connId: CONN, database: 'other', schema: 'public' })

    expect(knowledge.linksForTarget(CONN, DB).map((l) => l.id)).toEqual([
      l1.id,
      l2.id
    ])
  })

  it('returns null with no links at all', () => {
    expect(knowledge.defaultKbForTarget(CONN, DB)).toBeNull()
  })

  it('picks the oldest link, across schemas', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const first = knowledge.createBase('First scoped')
    knowledge.addLink({ kbId: first.id, connId: CONN, database: DB, schema: 'a' })
    vi.setSystemTime(2_000)
    const second = knowledge.createBase('Second scoped')
    knowledge.addLink({ kbId: second.id, connId: CONN, database: DB, schema: 'b' })

    expect(knowledge.defaultKbForTarget(CONN, DB)).toBe(first.id)
  })

  it('picks the oldest of several links to the same schema', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const first = knowledge.createBase('First')
    knowledge.addLink({ kbId: first.id, connId: CONN, database: DB, schema: 'public' })
    vi.setSystemTime(2_000)
    const second = knowledge.createBase('Second')
    knowledge.addLink({ kbId: second.id, connId: CONN, database: DB, schema: 'public' })

    expect(knowledge.defaultKbForTarget(CONN, DB)).toBe(first.id)
  })
})

describe('groupsForTarget', () => {
  it('returns an empty array for a target with no links', () => {
    expect(knowledge.groupsForTarget(CONN, DB)).toEqual([])
  })

  it('aggregates every linked base, oldest link first, with its own records and links', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const b1 = knowledge.createBase('B1')
    knowledge.saveRecord(b1.id, annotation)
    knowledge.addLink({ kbId: b1.id, connId: CONN, database: DB, schema: 'public' })
    vi.setSystemTime(2_000)
    const b2 = knowledge.createBase('B2')
    knowledge.saveRecord(b2.id, note)
    knowledge.addLink({ kbId: b2.id, connId: CONN, database: DB, schema: 'reporting' })
    vi.useRealTimers()

    const groups = knowledge.groupsForTarget(CONN, DB)
    expect(groups.map((g) => g.base.id)).toEqual([b1.id, b2.id])
    expect(groups[0].records).toHaveLength(1)
    expect(groups[0].records[0].kind).toBe('annotation')
    expect(groups[1].links.map((l) => l.schema)).toEqual(['reporting'])
    expect(groups[1].records[0].kind).toBe('note')
  })

  it('merges several schema links of one base into a single group', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'a' })
    vi.setSystemTime(2_000)
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'b' })
    vi.useRealTimers()

    const groups = knowledge.groupsForTarget(CONN, DB)
    expect(groups).toHaveLength(1)
    expect(groups[0].links.map((l) => l.schema)).toEqual(['a', 'b'])
    // Records appear once, not once per link.
    expect(groups[0].records).toHaveLength(1)
  })

  it('prunes a dangling link (base file gone) instead of surfacing an empty group', async () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    rmSync(basePath(base.id))
    // Cold cache so the missing file is actually noticed (loadBase serves
    // from its in-memory cache otherwise).
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')

    expect(reloaded.groupsForTarget(CONN, DB)).toEqual([])
    expect(reloaded.listLinks()).toEqual([])
  })

  it('leaves other links alone when pruning one dangling link', async () => {
    const gone = knowledge.createBase('Gone')
    const kept = knowledge.createBase('Kept')
    knowledge.addLink({ kbId: gone.id, connId: CONN, database: DB, schema: 'public' })
    const survivor = knowledge.addLink({
      kbId: kept.id,
      connId: CONN,
      database: DB,
      schema: 'public'
    })
    rmSync(basePath(gone.id))
    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')

    const groups = reloaded.groupsForTarget(CONN, DB)
    expect(groups.map((g) => g.base.id)).toEqual([kept.id])
    expect(reloaded.listLinks()).toEqual([survivor])
  })
})

describe('targetsForBase', () => {
  it('returns the unique set of targets a base is linked to', () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'reporting' })
    knowledge.addLink({ kbId: base.id, connId: 'c-2', database: 'other', schema: 'public' })

    const targets = knowledge.targetsForBase(base.id)
    expect(targets).toHaveLength(2)
    expect(targets).toContainEqual({ connId: CONN, database: DB })
    expect(targets).toContainEqual({ connId: 'c-2', database: 'other' })
  })

  it('returns an empty array for an unlinked base', () => {
    const base = knowledge.createBase('B')
    expect(knowledge.targetsForBase(base.id)).toEqual([])
  })
})

describe('deleteLinksForConnection', () => {
  it('drops every link for the connection but leaves the bases intact', () => {
    const b1 = knowledge.createBase('B1')
    const b2 = knowledge.createBase('B2')
    knowledge.addLink({ kbId: b1.id, connId: CONN, database: DB, schema: 'public' })
    knowledge.addLink({ kbId: b2.id, connId: CONN, database: 'other', schema: 'public' })
    const unrelated = knowledge.addLink({
      kbId: b1.id,
      connId: 'c-2',
      database: DB,
      schema: 'public'
    })

    knowledge.deleteLinksForConnection(CONN)

    expect(knowledge.listLinks()).toEqual([unrelated])
    expect(knowledge.getBase(b1.id)).not.toBeNull()
    expect(knowledge.getBase(b2.id)).not.toBeNull()
  })

  it('is a no-op for a connection with no links', () => {
    expect(() => knowledge.deleteLinksForConnection('never-used')).not.toThrow()
  })
})

describe('knowledge base id path safety', () => {
  // kbId comes from the renderer/agent and becomes a path segment; a
  // traversal string must fail closed before any filesystem access.
  const evil = ['..', '../x', 'a/b', '', 'kb-1/../../x', '.', 'a\\b']

  it('rejects traversal kbIds on every entry point', () => {
    for (const kbId of evil) {
      expect(() => knowledge.getBase(kbId)).toThrow(/Invalid knowledge base id/)
      expect(() => knowledge.renameBase(kbId, 'x')).toThrow(
        /Invalid knowledge base id/
      )
      expect(() => knowledge.deleteBase(kbId)).toThrow(
        /Invalid knowledge base id/
      )
      expect(() => knowledge.setBaseRepoRoot(kbId, '/tmp')).toThrow(
        /Invalid knowledge base id/
      )
      expect(() => knowledge.getBaseRepoRoot(kbId)).toThrow(
        /Invalid knowledge base id/
      )
      expect(() => knowledge.listRecords(kbId)).toThrow(
        /Invalid knowledge base id/
      )
      expect(() => knowledge.saveRecord(kbId, annotation)).toThrow(
        /Invalid knowledge base id/
      )
      expect(() => knowledge.deleteRecord(kbId, 'kn-x')).toThrow(
        /Invalid knowledge base id/
      )
      expect(() =>
        knowledge.addLink({ kbId, connId: CONN, database: DB, schema: 'public' })
      ).toThrow(/Invalid knowledge base id/)
    }
  })

  it('rejects traversal connIds in addLink', () => {
    const base = knowledge.createBase('B')
    for (const connId of evil) {
      expect(() =>
        knowledge.addLink({ kbId: base.id, connId, database: DB, schema: 'public' })
      ).toThrow(/Invalid connection id/)
    }
  })

  it('leaves the base file intact when a traversal delete is attempted', () => {
    const base = knowledge.createBase('B')
    expect(() => knowledge.deleteBase('..')).toThrow()
    expect(existsSync(basePath(base.id))).toBe(true)
  })
})

describe('corrupt and malformed files', () => {
  it('quarantines an unparseable base file rather than overwriting it, orphaning the id', async () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    writeFileSync(
      basePath(base.id),
      '{ "version": 2, "base": { trailing-junk',
      'utf8'
    )

    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')

    // Loads empty rather than crashing…
    expect(reloaded.listRecords(base.id)).toEqual([])
    expect(reloaded.listBases()).toEqual([])
    // …the original bytes survive as a .corrupt-* sibling…
    const dir = basesDir()
    const quarantined = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]), 'utf8')).toContain(
      'trailing-junk'
    )
    // …and the id no longer names a base until one is recreated (a base is
    // an explicit entity now, unlike the old per-database file).
    expect(() => reloaded.saveRecord(base.id, note)).toThrow(
      /Unknown knowledge base/
    )
  })

  it('quarantines a base file with a valid-JSON but malformed shape', async () => {
    const base = knowledge.createBase('B')
    writeFileSync(
      basePath(base.id),
      JSON.stringify({ version: 2, base: { id: base.id }, records: 'nope' }),
      'utf8'
    )

    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')

    expect(reloaded.getBase(base.id)).toBeNull()
    expect(
      readdirSync(basesDir()).some((f) => f.includes('.corrupt-'))
    ).toBe(true)
  })

  it('drops null and shapeless record entries on load but keeps unknown kinds', async () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    const path = basePath(base.id)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    parsed.records.push(
      null,
      42,
      { kind: 'annotation' }, // no id
      { id: 'kn-future', kind: 'metric', source: 'human', anything: true }
    )
    writeFileSync(path, JSON.stringify(parsed), 'utf8')

    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    const kinds = reloaded.listRecords(base.id).map((r) => r.kind)
    expect(kinds).toEqual(['annotation', 'metric'])
  })

  it('persists a base atomically (no .tmp residue, parseable result)', () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    expect(existsSync(`${basePath(base.id)}.tmp`)).toBe(false)
    expect(() => JSON.parse(readFileSync(basePath(base.id), 'utf8'))).not.toThrow()
  })

  it('quarantines an unparseable links.json instead of losing every link', async () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    writeFileSync(linksPath(), '{ "version": 1, "links": [ trailing-junk', 'utf8')

    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')

    expect(reloaded.listLinks()).toEqual([])
    const dir = join(userDataDir, 'knowledge')
    const quarantined = readdirSync(dir).filter((f) =>
      f.startsWith('links.json.corrupt-')
    )
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]), 'utf8')).toContain(
      'trailing-junk'
    )

    // A subsequent link starts a fresh table without touching the backup.
    reloaded.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    expect(reloaded.listLinks()).toHaveLength(1)
    expect(readdirSync(dir)).toContain(quarantined[0])
  })

  it('drops shapeless entries from links.json on load', async () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    const parsed = JSON.parse(readFileSync(linksPath(), 'utf8'))
    parsed.links.push(null, 42, { id: 'kl-bad' })
    writeFileSync(linksPath(), JSON.stringify(parsed), 'utf8')

    vi.resetModules()
    const reloaded = await import('../../src/main/knowledge')
    expect(reloaded.listLinks()).toHaveLength(1)
  })

  it('persists links.json atomically (no .tmp residue, parseable result)', () => {
    const base = knowledge.createBase('B')
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    expect(existsSync(`${linksPath()}.tmp`)).toBe(false)
    expect(() => JSON.parse(readFileSync(linksPath(), 'utf8'))).not.toThrow()
  })
})

describe('wipeAll', () => {
  it('removes bases and links, clearing the in-memory caches', () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, annotation)
    knowledge.addLink({ kbId: base.id, connId: CONN, database: DB, schema: 'public' })
    expect(existsSync(join(userDataDir, 'knowledge'))).toBe(true)

    knowledge.wipeAll()

    expect(existsSync(join(userDataDir, 'knowledge'))).toBe(false)
    expect(knowledge.listBases()).toEqual([])
    expect(knowledge.listLinks()).toEqual([])
  })

  it('is a no-op when the knowledge directory does not exist', () => {
    expect(existsSync(join(userDataDir, 'knowledge'))).toBe(false)
    expect(() => knowledge.wipeAll()).not.toThrow()
  })
})
