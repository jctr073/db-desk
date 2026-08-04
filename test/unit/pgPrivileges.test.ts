/**
 * Unit tests for the connect-time Postgres write-capability probe
 * (src/main/pgPrivileges.ts). The classifier is pure, so the truth table
 * runs against fabricated QueryResults; the orchestrator's error paths are
 * exercised with fake runners. The direction of every failure matters: no
 * malformed input may ever classify 'readonly'.
 */

import { describe, expect, it } from 'vitest'

import type { QueryResult } from '../../src/shared/db'
import {
  checkPgWriteCapability,
  classifyPrivilegeRow,
  PG_WRITE_CAPABILITY_SQL
} from '../../src/main/pgPrivileges'

const COLUMNS = ['any_super', 'any_bypassrls', 'writable_schemas'] as const

const DEFAULTS: Record<(typeof COLUMNS)[number], unknown> = {
  any_super: false,
  any_bypassrls: false,
  // The schema list travels as JSON text (see the probe's cell-folding note).
  writable_schemas: '[]'
}

function probeResult(
  overrides: Partial<Record<(typeof COLUMNS)[number], unknown>> = {}
): QueryResult {
  const values = COLUMNS.map((name) => (name in overrides ? overrides[name] : DEFAULTS[name]))
  return {
    command: 'SELECT',
    fields: COLUMNS.map((name) => ({
      name,
      dataType: name === 'writable_schemas' ? 'text' : 'bool'
    })),
    rows: [values as QueryResult['rows'][number]],
    rowCount: 1,
    durationMs: 1,
    limitApplied: null,
    truncated: false
  }
}

describe('classifyPrivilegeRow', () => {
  it('classifies no attributes and an empty schema list as readonly', () => {
    expect(classifyPrivilegeRow(probeResult())).toEqual({
      verdict: 'readonly',
      writableSchemas: []
    })
  })

  it.each(['any_super', 'any_bypassrls'] as const)(
    'classifies %s alone as writable with an empty schema list',
    (attribute) => {
      expect(classifyPrivilegeRow(probeResult({ [attribute]: true }))).toEqual({
        verdict: 'writable',
        writableSchemas: []
      })
    }
  )

  it('classifies a non-empty schema list as writable and passes the names through', () => {
    expect(classifyPrivilegeRow(probeResult({ writable_schemas: '["billing","orders"]' }))).toEqual(
      { verdict: 'writable', writableSchemas: ['billing', 'orders'] }
    )
  })

  it('lets a role attribute empty the schema list (the role writes everywhere)', () => {
    expect(
      classifyPrivilegeRow(probeResult({ any_super: true, writable_schemas: '["billing"]' }))
    ).toEqual({ verdict: 'writable', writableSchemas: [] })
  })

  it('reads columns by name, not position', () => {
    const result = probeResult({ writable_schemas: '["billing"]' })
    result.fields = [...result.fields].reverse()
    result.rows = [[...result.rows[0]].reverse()]
    expect(classifyPrivilegeRow(result).verdict).toBe('writable')
  })

  it.each([
    ['zero rows', { ...probeResult(), rows: [] }],
    ['two rows', { ...probeResult(), rows: [probeResult().rows[0], probeResult().rows[0]] }],
    [
      'a missing probe column',
      {
        ...probeResult(),
        fields: probeResult().fields.slice(1),
        rows: [probeResult().rows[0].slice(1)]
      }
    ]
  ])('classifies %s as indeterminate', (_label, result) => {
    expect(classifyPrivilegeRow(result as QueryResult).verdict).toBe('indeterminate')
  })

  it.each([null, 'true', 1])(
    'classifies a non-boolean attribute value (%o) as indeterminate',
    (value) => {
      // bool_or over an empty set is NULL; drivers may also stringify. Neither
      // may pass as readonly.
      expect(classifyPrivilegeRow(probeResult({ any_super: value })).verdict).toBe('indeterminate')
    }
  )

  it.each([
    ['a NULL list', null],
    ['a non-string list', 123],
    ['unparseable JSON', 'not json'],
    ['a truncated JSON list (10k cell cap)', '["billing", "ord'],
    ['a JSON non-array', '{"billing": true}'],
    ['a non-string element', '["billing", 1]']
  ])('classifies %s in writable_schemas as indeterminate', (_label, value) => {
    expect(classifyPrivilegeRow(probeResult({ writable_schemas: value })).verdict).toBe(
      'indeterminate'
    )
  })
})

describe('checkPgWriteCapability', () => {
  it('runs the probe SQL and folds the row', async () => {
    let seen: string | null = null
    const result = await checkPgWriteCapability(async (sql) => {
      seen = sql
      return { ok: true, data: probeResult() }
    })
    expect(result).toEqual({ verdict: 'readonly', writableSchemas: [] })
    expect(seen).toBe(PG_WRITE_CAPABILITY_SQL)
  })

  it('maps a failed query to indeterminate', async () => {
    const result = await checkPgWriteCapability(async () => ({
      ok: false,
      error: 'connection lost'
    }))
    expect(result.verdict).toBe('indeterminate')
  })

  it('maps a throwing runner to indeterminate', async () => {
    const result = await checkPgWriteCapability(() => {
      throw new Error('boom')
    })
    expect(result.verdict).toBe('indeterminate')
  })
})
