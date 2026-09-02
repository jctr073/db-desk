/**
 * Pure scoring/ranking for the command palette and Discover browser: title
 * matches outrank keyword matches, which outrank description matches, which
 * outrank a loose subsequence match; ties keep registry order.
 */

import { describe, expect, it } from 'vitest'
import {
  scoreMatch,
  searchFeatures,
  type Searchable
} from '../../src/renderer/src/discovery/search'

function item(overrides: Partial<Searchable> & { id: string }): Searchable {
  return {
    title: '',
    description: '',
    category: 'app',
    ...overrides
  }
}

describe('scoreMatch', () => {
  it('scores a title-prefix match above a title-word-prefix match', () => {
    const titlePrefix = item({ id: 'a', title: 'Export results' })
    const wordPrefix = item({ id: 'b', title: 'Full export' })
    expect(scoreMatch('export', titlePrefix)).toBeGreaterThan(scoreMatch('export', wordPrefix))
  })

  it('scores a title-word-prefix match above a plain title-contains match', () => {
    const wordPrefix = item({ id: 'a', title: 'Full export' })
    const contains = item({ id: 'b', title: 'Reexport data' })
    expect(scoreMatch('export', wordPrefix)).toBeGreaterThan(scoreMatch('export', contains))
  })

  it('scores a title-contains match above a keyword match', () => {
    const contains = item({ id: 'a', title: 'Reexport data' })
    const keyword = item({ id: 'b', title: 'Save a file', keywords: ['export'] })
    expect(scoreMatch('export', contains)).toBeGreaterThan(scoreMatch('export', keyword))
  })

  it('scores a keyword match above a description-contains match', () => {
    const keyword = item({ id: 'a', title: 'Save a file', keywords: ['export'] })
    const description = item({ id: 'b', title: 'Save a file', description: 'lets you export data' })
    expect(scoreMatch('export', keyword)).toBeGreaterThan(scoreMatch('export', description))
  })

  it('scores a description-contains match above a subsequence-only match', () => {
    const description = item({ id: 'a', title: 'Save a file', description: 'lets you export data' })
    const subsequence = item({ id: 'b', title: 'Excel port review' })
    expect(scoreMatch('export', description)).toBeGreaterThan(scoreMatch('export', subsequence))
  })

  it('is case-insensitive', () => {
    const feature = item({ id: 'a', title: 'Export results' })
    expect(scoreMatch('EXPORT', feature)).toBe(scoreMatch('export', feature))
    expect(scoreMatch('export', feature)).toBe(scoreMatch('ExPoRt', feature))
  })

  it('returns 0 for a non-match', () => {
    const feature = item({
      id: 'a',
      title: 'Run SQL',
      description: 'runs a query',
      keywords: ['execute']
    })
    expect(scoreMatch('zzzzz', feature)).toBe(0)
  })

  it('trims the query', () => {
    const feature = item({ id: 'a', title: 'Export results' })
    expect(scoreMatch('  export  ', feature)).toBe(scoreMatch('export', feature))
  })
})

describe('searchFeatures', () => {
  const items: Searchable[] = [
    item({ id: 'subsequence', title: 'Excel port review' }),
    item({ id: 'description', title: 'Save a file', description: 'lets you export data' }),
    item({ id: 'keyword', title: 'Save a file', keywords: ['export'] }),
    item({ id: 'contains', title: 'Reexport data' }),
    item({ id: 'wordPrefix', title: 'Full export' }),
    item({ id: 'titlePrefix', title: 'Export results' })
  ]

  it('orders results title-prefix > word-prefix > contains > keyword > description > subsequence', () => {
    const results = searchFeatures('export', items)
    expect(results.map((r) => r.id)).toEqual([
      'titlePrefix',
      'wordPrefix',
      'contains',
      'keyword',
      'description',
      'subsequence'
    ])
  })

  it('excludes non-matches', () => {
    const results = searchFeatures('zzzzz', items)
    expect(results).toEqual([])
  })

  it('is case-insensitive', () => {
    const results = searchFeatures('EXPORT', items)
    expect(results.map((r) => r.id)).toEqual(searchFeatures('export', items).map((r) => r.id))
  })

  it('preserves input order for an empty/whitespace query', () => {
    expect(searchFeatures('', items).map((r) => r.id)).toEqual(items.map((r) => r.id))
    expect(searchFeatures('   ', items).map((r) => r.id)).toEqual(items.map((r) => r.id))
  })

  it('respects the limit', () => {
    expect(searchFeatures('', items, 2).map((r) => r.id)).toEqual(['subsequence', 'description'])
    expect(searchFeatures('export', items, 3).map((r) => r.id)).toEqual([
      'titlePrefix',
      'wordPrefix',
      'contains'
    ])
  })

  it('keeps ties in input order (stable sort)', () => {
    const tied: Searchable[] = [
      item({ id: 'first', title: 'Alpha beam' }),
      item({ id: 'second', title: 'Alpha bay' })
    ]
    expect(searchFeatures('alpha', tied).map((r) => r.id)).toEqual(['first', 'second'])
  })
})
