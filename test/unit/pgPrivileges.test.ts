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

const PROBES = [
  'any_super',
  'any_bypassrls',
  'any_createdb',
  'any_table_write',
  'any_sequence_write',
  'any_schema_create',
  'any_db_create'
] as const

function probeResult(overrides: Partial<Record<(typeof PROBES)[number], unknown>> = {}): QueryResult {
  const values = PROBES.map((name) => (name in overrides ? overrides[name] : false))
  return {
    command: 'SELECT',
    fields: PROBES.map((name) => ({ name, dataType: 'bool' })),
    rows: [values as QueryResult['rows'][number]],
    rowCount: 1,
    durationMs: 1,
    limitApplied: null,
    truncated: false
  }
}

describe('classifyPrivilegeRow', () => {
  it('classifies all-false as readonly', () => {
    expect(classifyPrivilegeRow(probeResult())).toBe('readonly')
  })

  it.each(PROBES)('classifies %s alone as writable', (probe) => {
    expect(classifyPrivilegeRow(probeResult({ [probe]: true }))).toBe('writable')
  })

  it('reads columns by name, not position', () => {
    const result = probeResult({ any_db_create: true })
    result.fields = [...result.fields].reverse()
    result.rows = [[...result.rows[0]].reverse()]
    expect(classifyPrivilegeRow(result)).toBe('writable')
  })

  it.each([
    ['zero rows', { ...probeResult(), rows: [] }],
    ['two rows', { ...probeResult(), rows: [probeResult().rows[0], probeResult().rows[0]] }],
    [
      'a missing probe column',
      { ...probeResult(), fields: probeResult().fields.slice(1), rows: [probeResult().rows[0].slice(1)] }
    ]
  ])('classifies %s as indeterminate', (_label, result) => {
    expect(classifyPrivilegeRow(result as QueryResult)).toBe('indeterminate')
  })

  it.each([null, 'true', 1])('classifies a non-boolean probe value (%o) as indeterminate', (value) => {
    // bool_or over an empty set is NULL; drivers may also stringify. Neither
    // may pass as readonly.
    expect(classifyPrivilegeRow(probeResult({ any_super: value }))).toBe('indeterminate')
  })
})

describe('checkPgWriteCapability', () => {
  it('runs the probe SQL and folds the row', async () => {
    let seen: string | null = null
    const verdict = await checkPgWriteCapability(async (sql) => {
      seen = sql
      return { ok: true, data: probeResult() }
    })
    expect(verdict).toBe('readonly')
    expect(seen).toBe(PG_WRITE_CAPABILITY_SQL)
  })

  it('maps a failed query to indeterminate', async () => {
    const verdict = await checkPgWriteCapability(async () => ({
      ok: false,
      error: 'connection lost'
    }))
    expect(verdict).toBe('indeterminate')
  })

  it('maps a throwing runner to indeterminate', async () => {
    const verdict = await checkPgWriteCapability(() => {
      throw new Error('boom')
    })
    expect(verdict).toBe('indeterminate')
  })
})
