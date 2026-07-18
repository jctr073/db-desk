/**
 * Unit tests for the reverse usage index (Phase 4 step 1) in
 * src/shared/knowledge.ts: buildUsageIndex + lookupUsages.
 *
 * Pure functions over KnowledgeRecord[], so these tests need no Electron mock,
 * temp dirs, or module resets — just construct records and assert on the index.
 * Coverage: every kind and role, key normalization (case + quoting-style
 * casing), table-level refs, dangling refs (still indexed), and graceful
 * handling of unknown/forward-compat kinds.
 */

import { describe, expect, it } from 'vitest'

import { buildUsageIndex, lookupUsages, normalizeColumnKey } from '../../src/shared/knowledge'
import type { ColumnRef, KnowledgeRecord, UsageHit } from '../../src/shared/knowledge'

const col = (schema: string, table: string, column?: string): ColumnRef => ({
  schema,
  table,
  column
})

/** Base envelope fields shared by every record kind. */
const envelope = { source: 'human' as const, createdAt: 1, updatedAt: 2 }

/** Convenience: the hits for a ref, keyed by normalized column key. */
function hitsFor(index: ReturnType<typeof buildUsageIndex>, ref: ColumnRef): UsageHit[] {
  return index.get(normalizeColumnKey(ref)) ?? []
}

describe('buildUsageIndex', () => {
  it('indexes an annotation target under the "annotates" role', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-a',
        kind: 'annotation',
        target: col('public', 'users', 'email'),
        text: 'PII'
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'users', 'email'))).toEqual([
      { recordId: 'kn-a', kind: 'annotation', role: 'annotates' }
    ])
  })

  it('indexes a standard relationship from/to as joins-from / joins-to', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-r',
        kind: 'relationship',
        relType: 'standard',
        from: col('public', 'orders', 'user_id'),
        to: col('public', 'users', 'id')
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'orders', 'user_id'))).toEqual([
      { recordId: 'kn-r', kind: 'relationship', role: 'joins-from' }
    ])
    expect(hitsFor(index, col('public', 'users', 'id'))).toEqual([
      { recordId: 'kn-r', kind: 'relationship', role: 'joins-to' }
    ])
  })

  it('indexes a polymorphic relationship: from, discriminator, and every target value', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-p',
        kind: 'relationship',
        relType: 'polymorphic',
        from: col('public', 'events', 'subject_id'),
        discriminator: col('public', 'events', 'subject_type'),
        targets: {
          patient: col('public', 'patients', 'id'),
          provider: col('public', 'providers', 'id')
        }
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'events', 'subject_id'))).toEqual([
      { recordId: 'kn-p', kind: 'relationship', role: 'joins-from' }
    ])
    expect(hitsFor(index, col('public', 'events', 'subject_type'))).toEqual([
      { recordId: 'kn-p', kind: 'relationship', role: 'discriminator' }
    ])
    expect(hitsFor(index, col('public', 'patients', 'id'))).toEqual([
      { recordId: 'kn-p', kind: 'relationship', role: 'joins-to' }
    ])
    expect(hitsFor(index, col('public', 'providers', 'id'))).toEqual([
      { recordId: 'kn-p', kind: 'relationship', role: 'joins-to' }
    ])
  })

  it('indexes glossary mappings under the "glossary-mapping" role', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-g',
        kind: 'glossary',
        term: 'MRR',
        synonyms: ['monthly recurring revenue'],
        mappings: [
          { ref: col('public', 'subscriptions', 'amount'), caveat: 'cents' },
          { ref: col('public', 'subscriptions', 'interval') }
        ]
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'subscriptions', 'amount'))).toEqual([
      { recordId: 'kn-g', kind: 'glossary', role: 'glossary-mapping' }
    ])
    expect(hitsFor(index, col('public', 'subscriptions', 'interval'))).toEqual([
      { recordId: 'kn-g', kind: 'glossary', role: 'glossary-mapping' }
    ])
  })

  it('indexes exemplar references under the "used-in-exemplar" role', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-e',
        kind: 'exemplar',
        question: 'revenue by day',
        sql: 'select ...',
        references: [col('public', 'claims', 'svc_dt'), col('public', 'claims', 'amount')]
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'claims', 'svc_dt'))).toEqual([
      { recordId: 'kn-e', kind: 'exemplar', role: 'used-in-exemplar' }
    ])
    expect(hitsFor(index, col('public', 'claims', 'amount'))).toEqual([
      { recordId: 'kn-e', kind: 'exemplar', role: 'used-in-exemplar' }
    ])
  })

  it('indexes note references under the "referenced-by-note" role', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-n',
        kind: 'note',
        title: 'billing quirks',
        body: 'see amount column',
        references: [col('public', 'invoices', 'amount')]
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'invoices', 'amount'))).toEqual([
      { recordId: 'kn-n', kind: 'note', role: 'referenced-by-note' }
    ])
  })

  it('normalizes keys to lowercase so differently-cased refs collide', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-1',
        kind: 'annotation',
        target: col('Public', 'Users', 'Email'),
        text: 'a'
      },
      {
        ...envelope,
        id: 'kn-2',
        kind: 'annotation',
        target: col('public', 'users', 'email'),
        text: 'b'
      }
    ]
    const index = buildUsageIndex(records)
    // Both records land under the single normalized key.
    expect(index.get('public.users.email')).toEqual([
      { recordId: 'kn-1', kind: 'annotation', role: 'annotates' },
      { recordId: 'kn-2', kind: 'annotation', role: 'annotates' }
    ])
    // No upper-cased key exists.
    expect(index.has('Public.Users.Email')).toBe(false)
  })

  it('indexes a table-level ref (no column) under the table key', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-t',
        kind: 'annotation',
        target: col('public', 'users'),
        text: 'soft-deleted rows kept'
      }
    ]
    const index = buildUsageIndex(records)
    expect(index.get('public.users')).toEqual([
      { recordId: 'kn-t', kind: 'annotation', role: 'annotates' }
    ])
    // A table-level ref must NOT be reachable under a column key.
    expect(index.has('public.users.undefined')).toBe(false)
  })

  it('still indexes dangling refs (store does not resolve against live schema)', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-d',
        kind: 'annotation',
        target: col('gone', 'dropped_table', 'ghost_col'),
        text: 'x'
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('gone', 'dropped_table', 'ghost_col'))).toEqual([
      { recordId: 'kn-d', kind: 'annotation', role: 'annotates' }
    ])
  })

  it('ignores records of an unknown/forward-compat kind without throwing', () => {
    const records = [
      { ...envelope, id: 'kn-future', kind: 'metric', someRef: col('public', 'x', 'y') },
      {
        ...envelope,
        id: 'kn-a',
        kind: 'annotation',
        target: col('public', 'users', 'email'),
        text: 'ok'
      }
    ] as unknown as KnowledgeRecord[]
    const index = buildUsageIndex(records)
    expect(index.size).toBe(1)
    expect(hitsFor(index, col('public', 'users', 'email'))).toEqual([
      { recordId: 'kn-a', kind: 'annotation', role: 'annotates' }
    ])
  })

  it('collects hits from multiple records touching the same column, preserving order', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-a',
        kind: 'annotation',
        target: col('public', 'orders', 'user_id'),
        text: 'fk'
      },
      {
        ...envelope,
        id: 'kn-r',
        kind: 'relationship',
        relType: 'standard',
        from: col('public', 'orders', 'user_id'),
        to: col('public', 'users', 'id')
      }
    ]
    const index = buildUsageIndex(records)
    expect(hitsFor(index, col('public', 'orders', 'user_id'))).toEqual([
      { recordId: 'kn-a', kind: 'annotation', role: 'annotates' },
      { recordId: 'kn-r', kind: 'relationship', role: 'joins-from' }
    ])
  })

  it('returns an empty index for no records', () => {
    expect(buildUsageIndex([]).size).toBe(0)
  })
})

describe('lookupUsages', () => {
  const records: KnowledgeRecord[] = [
    // Column-level annotation on users.email
    {
      ...envelope,
      id: 'kn-col',
      kind: 'annotation',
      target: col('public', 'users', 'email'),
      text: 'PII'
    },
    // Table-level note referencing the whole users table
    {
      ...envelope,
      id: 'kn-tbl',
      kind: 'note',
      title: 't',
      body: 'b',
      references: [col('public', 'users')]
    }
  ]
  const index = buildUsageIndex(records)

  it('returns column hits followed by enclosing-table hits for a column ref', () => {
    expect(lookupUsages(index, col('public', 'users', 'email'))).toEqual([
      { recordId: 'kn-col', kind: 'annotation', role: 'annotates' },
      { recordId: 'kn-tbl', kind: 'note', role: 'referenced-by-note' }
    ])
  })

  it('returns only table-level hits for a table ref', () => {
    expect(lookupUsages(index, col('public', 'users'))).toEqual([
      { recordId: 'kn-tbl', kind: 'note', role: 'referenced-by-note' }
    ])
  })

  it('is case-insensitive via key normalization', () => {
    expect(lookupUsages(index, col('PUBLIC', 'Users', 'EMAIL'))).toEqual([
      { recordId: 'kn-col', kind: 'annotation', role: 'annotates' },
      { recordId: 'kn-tbl', kind: 'note', role: 'referenced-by-note' }
    ])
  })

  it('returns [] for a ref with no usages', () => {
    expect(lookupUsages(index, col('public', 'unknown', 'col'))).toEqual([])
  })
})
