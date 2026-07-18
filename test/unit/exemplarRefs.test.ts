/**
 * Unit tests for exemplar reference extraction (src/main/exemplar.ts):
 * the dependency-free fallback extractor `matchReferencesInSql` (the primary
 * subject) and `extractExemplarReferences`, whose LLM and introspection seams
 * are injected so the fallback is exercised deterministically without any API
 * call or database.
 *
 * exemplar.ts imports ./db for the default introspection, so that module is
 * mocked inert; it pulls in no Electron, so no electron mock is needed.
 */

import { describe, expect, it, vi } from 'vitest'

import { normalizeColumnKey } from '../../src/shared/knowledge'
import type { ColumnRef } from '../../src/shared/knowledge'
import type { DatabaseIntrospection, RelationInfo, SchemaIntrospection } from '../../src/shared/db'

vi.mock('../../src/main/db', () => ({
  introspectDatabase: vi.fn()
}))

import { extractExemplarReferences, matchReferencesInSql } from '../../src/main/exemplar'

function rel(name: string, columns: string[]): RelationInfo {
  return { name, columns: columns.map((c) => ({ name: c, dataType: 'text', badge: null })) }
}

function schema(name: string, tables: RelationInfo[]): SchemaIntrospection {
  return {
    name,
    tables,
    views: [],
    matviews: [],
    indexes: [],
    functions: [],
    sequences: [],
    types: [],
    aggregates: []
  }
}

const INTRO: DatabaseIntrospection = {
  name: 'analytics',
  schemas: [
    schema('public', [
      rel('claims', ['id', 'svc_dt', 'member_id', 'amount']),
      rel('members', ['id', 'member_id', 'name']),
      rel('orders', ['id', 'total'])
    ]),
    schema('billing', [rel('invoices', ['id', 'invoice_no'])])
  ]
}

/** Normalized-key set for order-independent comparison. */
function keys(refs: ColumnRef[]): Set<string> {
  return new Set(refs.map(normalizeColumnKey))
}

describe('matchReferencesInSql', () => {
  it('resolves a schema.table.column reference to a table and column ref', () => {
    const refs = matchReferencesInSql('SELECT public.claims.svc_dt FROM public.claims', INTRO)
    const k = keys(refs)
    expect(k.has('public.claims')).toBe(true)
    expect(k.has('public.claims.svc_dt')).toBe(true)
  })

  it('resolves table.column and fills the schema from introspection', () => {
    const refs = matchReferencesInSql('SELECT claims.svc_dt FROM claims', INTRO)
    expect(keys(refs).has('public.claims.svc_dt')).toBe(true)
    const col = refs.find((r) => r.column === 'svc_dt')
    expect(col).toEqual({ schema: 'public', table: 'claims', column: 'svc_dt' })
  })

  it('resolves a bare schema.table to a table-level ref', () => {
    const refs = matchReferencesInSql('SELECT 1 FROM billing.invoices', INTRO)
    const k = keys(refs)
    expect(k.has('billing.invoices')).toBe(true)
    // No column mentioned, so no column ref.
    expect([...k].some((key) => key.split('.').length === 3)).toBe(false)
  })

  it('attributes a bare column to the single referenced table that owns it (acceptance)', () => {
    const refs = matchReferencesInSql(
      "SELECT svc_dt FROM claims WHERE svc_dt > '2020-01-01'",
      INTRO
    )
    const k = keys(refs)
    expect(k.has('public.claims')).toBe(true)
    expect(k.has('public.claims.svc_dt')).toBe(true)
  })

  it('does not attribute a bare column that is ambiguous across referenced tables', () => {
    // member_id exists on both claims and members; unqualified, it is ambiguous.
    const refs = matchReferencesInSql(
      'SELECT member_id FROM claims JOIN members ON claims.id = members.id',
      INTRO
    )
    const k = keys(refs)
    expect(k.has('public.claims.member_id')).toBe(false)
    expect(k.has('public.members.member_id')).toBe(false)
    // But qualified refs from the ON clause resolve fine.
    expect(k.has('public.claims.id')).toBe(true)
    expect(k.has('public.members.id')).toBe(true)
  })

  it('resolves alias.column via the referenced table', () => {
    const refs = matchReferencesInSql('SELECT c.svc_dt FROM claims c', INTRO)
    expect(keys(refs).has('public.claims.svc_dt')).toBe(true)
  })

  it('ignores identifiers inside string literals and comments', () => {
    const refs = matchReferencesInSql(
      'SELECT total FROM orders -- claims.svc_dt\nWHERE total > 0 /* members */',
      INTRO
    )
    const k = keys(refs)
    expect(k.has('public.orders')).toBe(true)
    expect(k.has('public.orders.total')).toBe(true)
    expect(k.has('public.claims.svc_dt')).toBe(false)
    expect(k.has('public.members')).toBe(false)
  })

  it('matches quoted identifiers case-insensitively and outputs canonical casing', () => {
    const refs = matchReferencesInSql('SELECT "TOTAL" FROM "Orders"', INTRO)
    const k = keys(refs)
    expect(k.has('public.orders')).toBe(true)
    expect(k.has('public.orders.total')).toBe(true)
    const table = refs.find((r) => !r.column)
    expect(table).toEqual({ schema: 'public', table: 'orders' })
  })

  it('returns an empty array when nothing matches', () => {
    expect(matchReferencesInSql('SELECT 1', INTRO)).toEqual([])
    expect(matchReferencesInSql('SELECT now()', INTRO)).toEqual([])
  })

  it('dedupes refs mentioned multiple times', () => {
    const refs = matchReferencesInSql(
      'SELECT claims.svc_dt, claims.svc_dt FROM claims, public.claims',
      INTRO
    )
    const svcDt = refs.filter((r) => r.column === 'svc_dt')
    expect(svcDt).toHaveLength(1)
  })
})

describe('extractExemplarReferences', () => {
  const introspect = vi.fn(async () => ({ ok: true as const, data: INTRO }))

  it('falls back to text matching when the LLM seam yields null', async () => {
    const llm = vi.fn(async () => null)
    const refs = await extractExemplarReferences('c1', 'analytics', 'SELECT svc_dt FROM claims', {
      introspect,
      llm
    })
    expect(llm).toHaveBeenCalledOnce()
    expect(keys(refs).has('public.claims.svc_dt')).toBe(true)
  })

  it('falls back to text matching when the LLM seam yields an empty array', async () => {
    const llm = vi.fn(async () => [] as ColumnRef[])
    const refs = await extractExemplarReferences('c1', 'analytics', 'SELECT svc_dt FROM claims', {
      introspect,
      llm
    })
    expect(llm).toHaveBeenCalledOnce()
    // Empty is a miss, not an authoritative "no references" answer.
    expect(keys(refs).has('public.claims.svc_dt')).toBe(true)
  })

  it('uses the LLM refs when the seam returns them', async () => {
    const llmRefs: ColumnRef[] = [{ schema: 'public', table: 'orders', column: 'total' }]
    const llm = vi.fn(async () => llmRefs)
    const refs = await extractExemplarReferences('c1', 'analytics', 'SELECT total FROM orders', {
      introspect,
      llm
    })
    expect(refs).toEqual(llmRefs)
  })

  it('returns [] when introspection is unavailable', async () => {
    const failing = vi.fn(async () => ({ ok: false as const, error: 'offline' }))
    const llm = vi.fn(async () => null)
    const refs = await extractExemplarReferences('c1', 'analytics', 'SELECT 1 FROM claims', {
      introspect: failing,
      llm
    })
    expect(refs).toEqual([])
    // No point extracting from SQL we cannot resolve.
    expect(llm).not.toHaveBeenCalled()
  })

  it('returns [] for empty SQL without introspecting', async () => {
    const spy = vi.fn(async () => ({ ok: true as const, data: INTRO }))
    const refs = await extractExemplarReferences('c1', 'analytics', '   ', { introspect: spy })
    expect(refs).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})
