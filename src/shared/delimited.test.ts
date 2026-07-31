import { describe, expect, it } from 'vitest'

import { delimiterForKind, parseDelimited } from './delimited'

describe('parseDelimited', () => {
  it('parses plain unquoted rows', () => {
    expect(parseDelimited('a,b,c\nd,e,f', ',')).toEqual({
      rows: [
        ['a', 'b', 'c'],
        ['d', 'e', 'f']
      ],
      truncated: false,
      error: null
    })
  })

  it('parses quoted fields containing the delimiter', () => {
    expect(parseDelimited('"a,b",c\nd,e', ',')).toEqual({
      rows: [
        ['a,b', 'c'],
        ['d', 'e']
      ],
      truncated: false,
      error: null
    })
  })

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseDelimited('"say ""hi""",x', ',')).toEqual({
      rows: [['say "hi"', 'x']],
      truncated: false,
      error: null
    })
  })

  it('keeps embedded LF newlines inside a quoted field', () => {
    expect(parseDelimited('"line1\nline2",b\nc,d', ',')).toEqual({
      rows: [
        ['line1\nline2', 'b'],
        ['c', 'd']
      ],
      truncated: false,
      error: null
    })
  })

  it('keeps embedded CRLF newlines inside a quoted field', () => {
    expect(parseDelimited('"line1\r\nline2",b\nc,d', ',')).toEqual({
      rows: [
        ['line1\r\nline2', 'b'],
        ['c', 'd']
      ],
      truncated: false,
      error: null
    })
  })

  it('treats CRLF as a row separator', () => {
    expect(parseDelimited('a,b\r\nc,d\r\n', ',')).toEqual({
      rows: [
        ['a', 'b'],
        ['c', 'd']
      ],
      truncated: false,
      error: null
    })
  })

  it('does not produce an extra empty row for a trailing newline', () => {
    expect(parseDelimited('a,b\n', ',')).toEqual({
      rows: [['a', 'b']],
      truncated: false,
      error: null
    })
  })

  it('preserves empty fields', () => {
    expect(parseDelimited('a,,c\n', ',')).toEqual({
      rows: [['a', '', 'c']],
      truncated: false,
      error: null
    })
  })

  it('returns no rows for empty input', () => {
    expect(parseDelimited('', ',')).toEqual({ rows: [], truncated: false, error: null })
  })

  it('parses tab-delimited text', () => {
    expect(parseDelimited('a\tb\nc\td', '\t')).toEqual({
      rows: [
        ['a', 'b'],
        ['c', 'd']
      ],
      truncated: false,
      error: null
    })
  })

  it('is lenient about a stray quote in the middle of an unquoted field', () => {
    expect(parseDelimited('he said "hi" ok,b\n', ',')).toEqual({
      rows: [['he said "hi" ok', 'b']],
      truncated: false,
      error: null
    })
  })

  it('reports but does not throw on an unterminated quoted field at EOF', () => {
    const result = parseDelimited('"abc', ',')
    expect(result.rows).toEqual([['abc']])
    expect(result.truncated).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('stops scanning once maxRows is reached and marks truncated', () => {
    const result = parseDelimited('a,b\nc,d\ne,f\ng,h\n', ',', { maxRows: 2 })
    expect(result.rows).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(result.truncated).toBe(true)
    expect(result.error).toBeNull()
  })

  it('does not scan past the maxRows cutoff, even if later text is malformed', () => {
    // The unterminated quote lives entirely after the cutoff row; if the
    // parser kept scanning past maxRows it would surface an error here.
    const result = parseDelimited('a,b\nc,d\n"unterminated', ',', { maxRows: 2 })
    expect(result.rows).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(result.truncated).toBe(true)
    expect(result.error).toBeNull()
  })
})

describe('delimiterForKind', () => {
  it('maps csv to comma and tsv to tab', () => {
    expect(delimiterForKind('csv')).toBe(',')
    expect(delimiterForKind('tsv')).toBe('\t')
  })
})
