import { describe, expect, it } from 'vitest'

import { COMMON_KEYWORDS, KEYWORDS } from '../../src/renderer/src/sql/keywords'

describe('COMMON_KEYWORDS', () => {
  it('is a subset of KEYWORDS', () => {
    const all = new Set(KEYWORDS)
    const missing = COMMON_KEYWORDS.filter((kw) => !all.has(kw))
    expect(missing).toEqual([])
  })

  it('has no duplicates', () => {
    expect(new Set(COMMON_KEYWORDS).size).toBe(COMMON_KEYWORDS.length)
  })

  it('fits the two-digit sort rank used by the completion provider', () => {
    expect(COMMON_KEYWORDS.length).toBeLessThanOrEqual(100)
  })
})
