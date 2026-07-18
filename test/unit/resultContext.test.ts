import { describe, expect, it } from 'vitest'

import {
  RESULT_CONTEXT_CELL_CHARS,
  RESULT_CONTEXT_MAX_CHARS,
  RESULT_CONTEXT_MAX_ROWS,
  buildResultContextItem
} from '../../src/shared/resultContext'
import type { QueryResult } from '../../src/shared/db'

/**
 * Test helper only: `rows` accepts arbitrary runtime values (Date, bigint,
 * Uint8Array, plain objects) even though QueryResult types it as CellValue[][]
 * — real driver rows carry these too; buildResultContextItem must handle them.
 */
function makeResult(
  overrides: Partial<Omit<QueryResult, 'rows'>> & { rows?: unknown[][] } = {}
): QueryResult {
  return {
    command: 'SELECT',
    fields: [
      { name: 'id', dataType: 'int4' },
      { name: 'email', dataType: 'text' }
    ],
    rows: [
      [1, 'a@example.com'],
      [2, 'b@example.com'],
      [3, 'c@example.com']
    ],
    rowCount: 3,
    durationMs: 5,
    limitApplied: null,
    truncated: false,
    ...overrides
  } as QueryResult
}

const baseArgs = {
  id: 'item-1',
  title: 'AI Result 1 · orders',
  sql: 'select * from orders',
  connId: 'conn-1',
  database: 'analytics'
}

describe('buildResultContextItem — error tabs', () => {
  it('produces an empty item with the error passed through when result is null', () => {
    const item = buildResultContextItem({
      ...baseArgs,
      result: null,
      error: 'relation "orders" does not exist'
    })
    expect(item).toEqual({
      kind: 'result',
      id: 'item-1',
      title: 'AI Result 1 · orders',
      sql: 'select * from orders',
      connId: 'conn-1',
      database: 'analytics',
      columns: [],
      rows: [],
      totalRows: null,
      scope: 'failed query',
      error: 'relation "orders" does not exist'
    })
  })
})

describe('buildResultContextItem — cell stringification', () => {
  it.each<[string, unknown, string]>([
    ['null → NULL', null, 'NULL'],
    ['undefined → NULL', undefined, 'NULL'],
    ['string as-is', 'hello', 'hello'],
    ['number via String()', 42, '42'],
    ['float via String()', 3.14, '3.14'],
    ['boolean true via String()', true, 'true'],
    ['boolean false via String()', false, 'false'],
    ['bigint via String()', BigInt('9007199254740993'), '9007199254740993']
  ])('%s', (_name, cell, expected) => {
    const result = makeResult({ fields: [{ name: 'v', dataType: 'any' }], rows: [[cell]] })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toBe(expected)
  })

  it('stringifies Date as ISO string', () => {
    const date = new Date('2026-01-15T10:30:00.000Z')
    const result = makeResult({ fields: [{ name: 'v', dataType: 'timestamptz' }], rows: [[date]] })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toBe('2026-01-15T10:30:00.000Z')
  })

  it('renders Uint8Array/Buffer-like values as a capped hex preview', () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0xab, 0xff])
    const result = makeResult({ fields: [{ name: 'v', dataType: 'bytea' }], rows: [[bytes]] })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toBe('\\x0102abff')
  })

  it('stringifies plain objects/arrays via JSON.stringify', () => {
    const result = makeResult({
      fields: [
        { name: 'obj', dataType: 'jsonb' },
        { name: 'arr', dataType: 'jsonb' }
      ],
      rows: [[{ a: 1, b: 'two' }, [1, 2, 3]]]
    })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toBe('{"a":1,"b":"two"}')
    expect(item.rows[0][1]).toBe('[1,2,3]')
  })

  it('falls back to String() when JSON.stringify throws (circular reference)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = makeResult({ fields: [{ name: 'v', dataType: 'jsonb' }], rows: [[circular]] })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toBe(String(circular))
  })

  it('caps a long cell at RESULT_CONTEXT_CELL_CHARS with a trailing ellipsis', () => {
    const long = 'x'.repeat(RESULT_CONTEXT_CELL_CHARS + 50)
    const result = makeResult({ fields: [{ name: 'v', dataType: 'text' }], rows: [[long]] })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toHaveLength(RESULT_CONTEXT_CELL_CHARS + 1)
    expect(item.rows[0][0].endsWith('…')).toBe(true)
    expect(item.rows[0][0].slice(0, RESULT_CONTEXT_CELL_CHARS)).toBe(
      long.slice(0, RESULT_CONTEXT_CELL_CHARS)
    )
  })

  it('does not cap a cell exactly at the char limit', () => {
    const exact = 'y'.repeat(RESULT_CONTEXT_CELL_CHARS)
    const result = makeResult({ fields: [{ name: 'v', dataType: 'text' }], rows: [[exact]] })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows[0][0]).toBe(exact)
  })
})

describe('buildResultContextItem — row/column selection filtering', () => {
  it('keeps only selected row indexes, in ascending order, regardless of insertion order', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedRows: new Set([2, 0])
    })
    expect(item.rows).toEqual([
      ['1', 'a@example.com'],
      ['3', 'c@example.com']
    ])
    expect(item.totalRows).toBe(3)
  })

  it('keeps only selected column indexes, in ascending order, and filters columns metadata to match', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedColumns: new Set([1])
    })
    expect(item.columns).toEqual([{ name: 'email', dataType: 'text' }])
    expect(item.rows).toEqual([['a@example.com'], ['b@example.com'], ['c@example.com']])
  })

  it('combines row and column selection', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedRows: new Set([1]),
      selectedColumns: new Set([0])
    })
    expect(item.rows).toEqual([['2']])
    expect(item.columns).toEqual([{ name: 'id', dataType: 'int4' }])
  })

  it('ignores out-of-range selected row/column indexes', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedRows: new Set([0, 99, -1]),
      selectedColumns: new Set([0, 5])
    })
    expect(item.rows).toEqual([['1']])
    expect(item.columns).toEqual([{ name: 'id', dataType: 'int4' }])
  })

  it('treats a null or empty selectedRows/selectedColumns as "all"', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedRows: new Set(),
      selectedColumns: null
    })
    expect(item.rows).toHaveLength(3)
    expect(item.columns).toHaveLength(2)
  })
})

describe('buildResultContextItem — row cap', () => {
  it('keeps at most RESULT_CONTEXT_MAX_ROWS rows when unfiltered', () => {
    const rows = Array.from({ length: RESULT_CONTEXT_MAX_ROWS + 20 }, (_, i) => [i])
    const result = makeResult({ fields: [{ name: 'v', dataType: 'int4' }], rows })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows).toHaveLength(RESULT_CONTEXT_MAX_ROWS)
    expect(item.rows[0][0]).toBe('0')
    expect(item.rows[RESULT_CONTEXT_MAX_ROWS - 1][0]).toBe(String(RESULT_CONTEXT_MAX_ROWS - 1))
    expect(item.totalRows).toBe(RESULT_CONTEXT_MAX_ROWS + 20)
  })

  it('does not cap when row count is at or under the max', () => {
    const rows = Array.from({ length: RESULT_CONTEXT_MAX_ROWS }, (_, i) => [i])
    const result = makeResult({ fields: [{ name: 'v', dataType: 'int4' }], rows })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows).toHaveLength(RESULT_CONTEXT_MAX_ROWS)
    expect(item.scope).toBe(`all ${RESULT_CONTEXT_MAX_ROWS} rows`)
  })
})

describe('buildResultContextItem — char-budget halving', () => {
  it('halves the row count repeatedly until under RESULT_CONTEXT_MAX_CHARS', () => {
    // Wide rows so RESULT_CONTEXT_MAX_ROWS rows blow well past the char budget.
    const wideCell = 'z'.repeat(RESULT_CONTEXT_CELL_CHARS)
    const rows = Array.from({ length: RESULT_CONTEXT_MAX_ROWS }, () => [wideCell, wideCell])
    const result = makeResult({
      fields: [
        { name: 'a', dataType: 'text' },
        { name: 'b', dataType: 'text' }
      ],
      rows
    })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows.length).toBeLessThan(RESULT_CONTEXT_MAX_ROWS)
    expect(item.rows.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(item).length).toBeLessThanOrEqual(RESULT_CONTEXT_MAX_CHARS)
    expect(item.scope).toContain('(trimmed to fit)')
  })

  it('halves down to a minimum of 1 row when even one row cannot fit under budget', () => {
    // Cells are capped per-cell, so blowing the budget at 1 row needs many
    // wide columns rather than one huge cell.
    const fields = Array.from({ length: 100 }, (_, i) => ({
      name: `col_${i}`,
      dataType: 'text'
    }))
    const wideCell = 'w'.repeat(RESULT_CONTEXT_CELL_CHARS)
    const rows = Array.from({ length: 10 }, () => fields.map(() => wideCell))
    const result = makeResult({ fields, rows })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.rows).toHaveLength(1)
    expect(JSON.stringify(item).length).toBeGreaterThan(RESULT_CONTEXT_MAX_CHARS)
  })
})

describe('buildResultContextItem — scope strings', () => {
  it('"all N rows" when everything fits unfiltered', () => {
    const result = makeResult()
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.scope).toBe('all 3 rows')
  })

  it('"first N of M rows" when capped by RESULT_CONTEXT_MAX_ROWS', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i])
    const result = makeResult({ fields: [{ name: 'v', dataType: 'int4' }], rows })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.scope).toBe(`first ${RESULT_CONTEXT_MAX_ROWS} of 500 rows`)
  })

  it('"rows A–B of M (selected)" for a contiguous multi-row selection that fits', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i])
    const result = makeResult({ fields: [{ name: 'v', dataType: 'int4' }], rows })
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedRows: new Set([3, 4, 5, 6, 7, 8])
    })
    expect(item.scope).toBe('rows 4–9 of 500 (selected)')
  })

  it('"row N of M (selected)" for a single selected row', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedRows: new Set([1])
    })
    expect(item.scope).toBe('row 2 of 3 (selected)')
  })

  it('appends the columns clause when column-filtered', () => {
    const result = makeResult()
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedColumns: new Set([1])
    })
    expect(item.scope).toBe('all 3 rows, columns email (selected)')
  })

  it('caps the listed column names at 5 and folds the rest into "and N more"', () => {
    const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({
      name,
      dataType: 'text'
    }))
    const result = makeResult({ fields, rows: [fields.map((_, i) => `v${i}`)] })
    const item = buildResultContextItem({
      ...baseArgs,
      result,
      error: null,
      selectedColumns: new Set([0, 1, 2, 3, 4, 5, 6])
    })
    expect(item.scope).toBe('all 1 row, columns a, b, c, d, e, and 2 more (selected)')
  })

  it('honestly reflects the final kept count when char-budget trimming applied, on top of the row cap', () => {
    const wideCell = 'z'.repeat(RESULT_CONTEXT_CELL_CHARS)
    const rows = Array.from({ length: 500 }, () => [wideCell, wideCell])
    const result = makeResult({
      fields: [
        { name: 'a', dataType: 'text' },
        { name: 'b', dataType: 'text' }
      ],
      rows
    })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.scope).toBe(`first ${item.rows.length} of 500 rows (trimmed to fit)`)
    expect(item.rows.length).toBeLessThan(RESULT_CONTEXT_MAX_ROWS)
  })
})

describe('buildResultContextItem — totalRows', () => {
  it('uses the fetched row count (result.rows.length), not rowCount', () => {
    const result = makeResult({ rowCount: 99999 })
    const item = buildResultContextItem({ ...baseArgs, result, error: null })
    expect(item.totalRows).toBe(3)
  })
})
