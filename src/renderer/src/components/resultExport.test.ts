import { describe, expect, it } from 'vitest'

import type { QueryField } from '../../../shared/db'
import { exportNeedsFullQuery, selectedResultRows, serializeResult } from './resultExport'

const fields: QueryField[] = [
  { name: 'id', dataType: 'integer' },
  { name: 'description', dataType: 'text' },
  { name: 'active', dataType: 'boolean' }
]

describe('selectedResultRows', () => {
  it('returns selected rows in grid order', () => {
    const rows = [
      [1, 'one', true],
      [2, 'two', false],
      [3, 'three', true]
    ]

    expect(selectedResultRows(rows, new Set([2, 0, 99]))).toEqual([rows[0], rows[2]])
  })
})

describe('exportNeedsFullQuery', () => {
  it('re-runs unselected CSV and TSV exports without the grid limit', () => {
    expect(exportNeedsFullQuery('csv', 0)).toBe(true)
    expect(exportNeedsFullQuery('tsv', 0)).toBe(true)
  })

  it('never re-runs JSON or selected-row exports', () => {
    expect(exportNeedsFullQuery('json', 0)).toBe(false)
    expect(exportNeedsFullQuery('csv', 2)).toBe(false)
    expect(exportNeedsFullQuery('tsv', 2)).toBe(false)
    expect(exportNeedsFullQuery('json', 2)).toBe(false)
  })
})

describe('serializeResult', () => {
  it('quotes CSV delimiters, quotes, and line breaks', () => {
    expect(serializeResult(fields, [[1, 'comma, quote " and\nline', null]], 'csv')).toBe(
      'id,description,active\n1,"comma, quote "" and\nline",\n'
    )
  })

  it('uses tabs for TSV without quoting commas', () => {
    expect(serializeResult(fields, [[1, 'comma,ok', true]], 'tsv')).toBe(
      'id\tdescription\tactive\n1\tcomma,ok\ttrue\n'
    )
  })

  it('preserves JSON value types and disambiguates duplicate columns', () => {
    const json = serializeResult(
      [
        { name: 'value', dataType: 'integer' },
        { name: 'value', dataType: 'text' },
        { name: 'value_2', dataType: 'boolean' }
      ],
      [[7, 'seven', null]],
      'json'
    )

    expect(JSON.parse(json)).toEqual([{ value: 7, value_2: 'seven', value_2_2: null }])
  })
})
