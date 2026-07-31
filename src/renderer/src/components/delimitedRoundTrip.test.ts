import { describe, expect, it } from 'vitest'

import type { CellValue, QueryField } from '../../../shared/db'
import { parseDelimited } from '../../../shared/delimited'
import { serializeResult } from './resultExport'

// Round-trips values through the renderer's serializer (`resultExport.ts`,
// which owns `delimitedCell`) and the shared parser (`shared/delimited.ts`)
// to prove their quoting rules agree. Kept alongside `resultExport.test.ts`
// rather than in `src/shared/` since it depends on renderer code.

const fields: QueryField[] = [{ name: 'value', dataType: 'text' }]

const trickyValues: CellValue[] = [
  'plain',
  'has,a,comma',
  'has "a" quote',
  'has\ttab',
  'multi\nline\r\nvalue',
  '"already quoted"',
  '',
  null,
  42,
  true
]

function expectedCell(value: CellValue): string {
  if (value === null) return ''
  return String(value)
}

describe('serializeResult / parseDelimited round trip', () => {
  it('round-trips tricky values through CSV', () => {
    const rows = trickyValues.map((value) => [value])
    const csv = serializeResult(fields, rows, 'csv')
    const parsed = parseDelimited(csv, ',')

    expect(parsed.error).toBeNull()
    expect(parsed.truncated).toBe(false)
    expect(parsed.rows[0]).toEqual(['value'])
    expect(parsed.rows.slice(1)).toEqual(rows.map(([v]) => [expectedCell(v)]))
  })

  it('round-trips tricky values through TSV', () => {
    const rows = trickyValues.map((value) => [value])
    const tsv = serializeResult(fields, rows, 'tsv')
    const parsed = parseDelimited(tsv, '\t')

    expect(parsed.error).toBeNull()
    expect(parsed.truncated).toBe(false)
    expect(parsed.rows[0]).toEqual(['value'])
    expect(parsed.rows.slice(1)).toEqual(rows.map(([v]) => [expectedCell(v)]))
  })
})
