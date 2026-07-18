/**
 * The classifier and the wall, asserted over the shared corpus
 * (test/support/statements.ts). The integration sweep proves the corpus's
 * `expected` labels are safe against a real engine; this file proves
 * classifyStatement and guardAgentStatement agree with those labels.
 */

import { describe, expect, it } from 'vitest'
import {
  applyAutoLimit,
  classifyStatement,
  guardAgentStatement
} from '../../src/shared/sql'
import { ALL_CASES, ESCAPE_CASES } from '../support/statements'

describe('classifyStatement', () => {
  for (const c of ALL_CASES) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(classifyStatement(c.sql)).toBe(c.expected)
    })
  }

  // Cases from docs/agent-modes.md §8 not covered by the corpus.
  const extra: Array<[string, string, ReturnType<typeof classifyStatement>]> = [
    ['empty string', '', 'read'],
    ['whitespace only', '   \n\t ', 'read'],
    ['comment only', '-- nothing here\n/* still nothing */', 'read'],
    ['EXPLAIN FORMATTED (Databricks)', 'EXPLAIN FORMATTED SELECT 1', 'read'],
    ['EXPLAIN EXTENDED (Databricks)', 'EXPLAIN EXTENDED SELECT 1', 'read'],
    ['EXPLAIN ANALYZE of a DELETE', 'EXPLAIN ANALYZE DELETE FROM t', 'dml'],
    [
      'EXPLAIN bare options then a read',
      'EXPLAIN ANALYZE VERBOSE SELECT * FROM t',
      'read'
    ],
    ['case-insensitive INSERT', 'Insert INTO t VALUES (1)', 'dml'],
    ['case-insensitive EXPLAIN of a write', 'explain update t set a = 1', 'dml'],
    ['SELECT INTO via WITH', 'WITH x AS (SELECT 1) SELECT * INTO t2 FROM x', 'ddl'],
    // The FOR UPDATE keyword trips rule 6's all-depth DML scan — the
    // documented safe-side bias; dml and unknown are equally blocked.
    ['WITH ... FOR UPDATE at top level', 'WITH x AS (SELECT 1) SELECT * FROM t FOR UPDATE', 'dml'],
    ['RENAME (Databricks)', 'RENAME TABLE a TO b', 'ddl'],
    ['OPTIMIZE (Databricks)', 'OPTIMIZE events', 'ddl'],
    ['MSCK (Databricks)', 'MSCK REPAIR TABLE t', 'ddl'],
    ['EXECUTE', 'EXECUTE prepared_thing', 'unknown']
  ]
  for (const [name, sql, expected] of extra) {
    it(`${name} → ${expected}`, () => {
      expect(classifyStatement(sql)).toBe(expected)
    })
  }
})

describe('guardAgentStatement (the wall)', () => {
  it('passes a single read', () => {
    expect(guardAgentStatement('SELECT 1')).toEqual({ ok: true })
  })

  it('passes a single read with a trailing semicolon', () => {
    expect(guardAgentStatement('SELECT 1;')).toEqual({ ok: true })
  })

  it('refuses empty input', () => {
    const res = guardAgentStatement('')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.cls).toBe('empty')
  })

  it('refuses two statements even when both are reads', () => {
    const res = guardAgentStatement('SELECT 1; SELECT 2')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.cls).toBe('multi')
  })

  // The regression tests for the live bypass: every escape payload proven to
  // mutate through the read-only belt must die on the single-statement rule
  // before classification even runs.
  for (const c of ESCAPE_CASES) {
    it(`refuses as multi: ${c.name}`, () => {
      const res = guardAgentStatement(c.sql)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.cls).toBe('multi')
    })
  }

  it('refuses the documented near miss as multi too', () => {
    // Does NOT actually escape the belt (changing the default does not touch
    // the in-flight transaction) — kept so the corrected claim stays tested.
    const res = guardAgentStatement(
      'SET default_transaction_read_only = off; DELETE FROM order_items'
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.cls).toBe('multi')
  })

  const singles: Array<[string, string]> = [
    ['DELETE FROM t', 'dml'],
    ['INSERT INTO t VALUES (1)', 'dml'],
    ['CREATE TABLE t (a int)', 'ddl'],
    ['DROP TABLE t', 'ddl'],
    ['SET transaction_read_only = off', 'unknown'],
    ['BEGIN', 'unknown'],
    ['COMMIT', 'unknown'],
    ['CALL p()', 'unknown']
  ]
  for (const [sql, cls] of singles) {
    it(`refuses single non-read (${cls}): ${sql}`, () => {
      const res = guardAgentStatement(sql)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.cls).toBe(cls)
        expect(res.reason).toMatch(/^Blocked:/)
      }
    })
  }
})

describe('applyAutoLimit', () => {
  it('appends LIMIT to a bare row-returning query', () => {
    expect(applyAutoLimit('SELECT * FROM t;', 500)).toEqual({
      text: 'SELECT * FROM t\nLIMIT 500',
      applied: true
    })
  })

  it('leaves a query with a top-level LIMIT alone', () => {
    const sql = 'SELECT * FROM t LIMIT 10'
    expect(applyAutoLimit(sql, 500)).toEqual({ text: sql, applied: false })
  })

  // The limit is interpolated into SQL text; the IPC layer types it as a
  // number but nothing enforces that at runtime. Anything but a positive
  // integer must leave the statement untouched.
  it.each([
    ['float', 1.5],
    ['zero', 0],
    ['negative', -10],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['smuggled string', '500; DROP TABLE t' as unknown as number]
  ])('refuses non-positive-integer limit (%s)', (_name, limit) => {
    const sql = 'SELECT * FROM t'
    expect(applyAutoLimit(sql, limit)).toEqual({ text: sql, applied: false })
  })
})
