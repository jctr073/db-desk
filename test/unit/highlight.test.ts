/**
 * Chat SQL highlighting: the classifier must cover the input losslessly
 * (segments concatenate back to the source) and tag tokens with the same
 * classes the editor theme colors.
 */

import { describe, expect, it } from 'vitest'
import { highlightSql, stripSqlComments } from '../../src/renderer/src/sql/highlight'
import type { HighlightSegment } from '../../src/renderer/src/sql/highlight'

function joined(segments: HighlightSegment[]): string {
  return segments.map((s) => s.text).join('')
}

function of(segments: HighlightSegment[], cls: string): string[] {
  return segments.filter((s) => s.cls === cls).map((s) => s.text)
}

describe('highlightSql', () => {
  it('is lossless over a representative query', () => {
    const sql = [
      '-- top categories',
      'WITH ranked AS (',
      "  SELECT store_id, c.name AS category, COUNT(*) AS rentals, 'x''y' AS lit",
      '  FROM rental r JOIN inventory i ON i.inventory_id = r.inventory_id',
      ')',
      'SELECT * FROM ranked WHERE rank <= 3.5 /* cutoff */'
    ].join('\n')
    expect(joined(highlightSql(sql))).toBe(sql)
  })

  it('tags keywords, functions, strings, numbers, and comments', () => {
    const segs = highlightSql(
      "SELECT COUNT(*), lower(name) FROM t WHERE a = 'hi' AND b < 42 -- tail"
    )
    expect(of(segs, 'kw')).toEqual(['SELECT', 'FROM', 'WHERE', 'AND'])
    expect(of(segs, 'fn')).toEqual(['COUNT', 'lower'])
    expect(of(segs, 'str')).toEqual(["'hi'"])
    expect(of(segs, 'num')).toEqual(['42'])
    expect(of(segs, 'comment')).toEqual(['-- tail'])
    expect(of(highlightSql('SELECT 1 /* two words */ + 2'), 'comment')).toEqual(['/* two words */'])
    expect(of(segs, 'op')).toEqual(['*', '=', '<'])
  })

  it('keeps LEFT/RIGHT as keywords in joins but functions before a paren', () => {
    const join = highlightSql('SELECT a FROM t LEFT JOIN u ON t.id = u.id')
    expect(of(join, 'kw')).toContain('LEFT')
    const call = highlightSql('SELECT left(name, 3) FROM t')
    expect(of(call, 'fn')).toContain('left')
  })

  it('tags built-in types and casts', () => {
    const segs = highlightSql("SELECT '2024-01-01'::timestamptz, CAST(a AS integer)")
    expect(of(segs, 'type')).toEqual(['timestamptz', 'integer'])
    expect(of(segs, 'op')).toContain('::')
  })

  it('leaves identifiers and quoted identifiers unstyled', () => {
    const segs = highlightSql('SELECT "Weird Name", plain_col FROM t')
    const plain = segs.filter((s) => s.cls === null).map((s) => s.text.trim())
    expect(plain).toContain('"Weird Name"')
    expect(plain).toContain('plain_col')
  })

  it('strips comments for one-line previews', () => {
    expect(stripSqlComments('-- top 3 per store\nSELECT * /* all */ FROM t')).toBe(
      '\nSELECT *  FROM t'
    )
  })

  it('tolerates streaming-truncated input', () => {
    for (const partial of ["SELECT 'unterminated", 'SELECT 1 /* open', 'WITH x AS (']) {
      expect(joined(highlightSql(partial))).toBe(partial)
    }
  })
})
