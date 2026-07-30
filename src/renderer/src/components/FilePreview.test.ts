import { describe, expect, it } from 'vitest'

import {
  buildDelimitedPreview,
  DELIMITED_PREVIEW_MAX_ROWS,
  formatJsonPreview,
  parseMarkdownPreview
} from './FilePreview'

describe('formatJsonPreview', () => {
  it('pretty prints valid JSON', () => {
    expect(formatJsonPreview('{"ready":true}')).toEqual({
      text: '{\n  "ready": true\n}',
      error: null
    })
  })

  it('preserves invalid JSON and returns a useful error', () => {
    const result = formatJsonPreview('{"ready":}')
    expect(result.text).toBe('{"ready":}')
    expect(result.error).toBeTruthy()
  })
})

describe('parseMarkdownPreview', () => {
  it('separates fenced code from rendered prose', () => {
    expect(parseMarkdownPreview('# Example\n\n```sql\nSELECT 1;\n```\nDone')).toEqual([
      { type: 'markdown', content: '# Example\n' },
      { type: 'code', content: 'SELECT 1;', language: 'sql' },
      { type: 'markdown', content: 'Done' }
    ])
  })
})

describe('buildDelimitedPreview', () => {
  it('uses the first row as column headers', () => {
    const preview = buildDelimitedPreview('id,name\n1,Ada\n2,Grace\n', 'csv')
    expect(preview.columns).toEqual([{ name: 'id' }, { name: 'name' }])
    expect(preview.rows).toEqual([
      ['1', 'Ada'],
      ['2', 'Grace']
    ])
    expect(preview.truncated).toBe(false)
    expect(preview.error).toBeNull()
  })

  it('names blank headers positionally and squares ragged rows', () => {
    const preview = buildDelimitedPreview('id,,note\n1,x\n2,y,z,extra\n', 'csv')
    expect(preview.columns.map((c) => c.name)).toEqual(['id', 'Column 2', 'note'])
    expect(preview.rows).toEqual([
      ['1', 'x', ''],
      ['2', 'y', 'z']
    ])
  })

  it('parses tab-delimited content for the tsv kind', () => {
    const preview = buildDelimitedPreview('a\tb\n1\t2\n', 'tsv')
    expect(preview.columns.map((c) => c.name)).toEqual(['a', 'b'])
    expect(preview.rows).toEqual([['1', '2']])
  })

  it('returns empty grid data for an empty buffer', () => {
    expect(buildDelimitedPreview('', 'csv')).toEqual({
      columns: [],
      rows: [],
      truncated: false,
      error: null
    })
  })

  it('caps the preview at the row limit and flags truncation', () => {
    const lines = [
      'n',
      ...Array.from({ length: DELIMITED_PREVIEW_MAX_ROWS + 10 }, (_, i) => `${i}`)
    ]
    const preview = buildDelimitedPreview(lines.join('\n'), 'csv')
    expect(preview.rows).toHaveLength(DELIMITED_PREVIEW_MAX_ROWS)
    expect(preview.truncated).toBe(true)
  })

  it('surfaces parse problems while keeping parsed rows', () => {
    const preview = buildDelimitedPreview('a,b\n"open,1\n', 'csv')
    expect(preview.error).toBeTruthy()
    expect(preview.columns.map((c) => c.name)).toEqual(['a', 'b'])
  })
})
