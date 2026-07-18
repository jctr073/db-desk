import { describe, expect, it } from 'vitest'

import {
  formatElapsed,
  lastSqlFence,
  splitFences
} from '../../src/renderer/src/components/agentTurn'

describe('splitFences', () => {
  it('returns plain text as a single non-code segment', () => {
    expect(splitFences('hello world')).toEqual([{ code: false, body: 'hello world' }])
  })

  it('marks fenced segments as code and strips the language tag', () => {
    const segs = splitFences('before\n```sql\nSELECT 1;\n```\nafter')
    expect(segs).toEqual([
      { code: false, body: 'before\n' },
      { code: true, body: 'SELECT 1;\n' },
      { code: false, body: '\nafter' }
    ])
  })

  it('keeps a first line that is not a bare language tag', () => {
    const segs = splitFences('```SELECT 1\nFROM t```')
    expect(segs[1]).toEqual({ code: true, body: 'SELECT 1\nFROM t' })
  })
})

describe('lastSqlFence', () => {
  it('returns null when there is no fence', () => {
    expect(lastSqlFence('just prose, no SQL')).toBeNull()
  })

  it('returns null when the only fence is empty', () => {
    expect(lastSqlFence('look:\n```sql\n\n```')).toBeNull()
  })

  it('returns the single fenced query', () => {
    expect(lastSqlFence('Here you go:\n```sql\nSELECT 1;\n```')).toBe('SELECT 1;')
  })

  it('returns the last of several fences', () => {
    const text = [
      'First I tried:',
      '```sql',
      'SELECT wrong;',
      '```',
      'The final version:',
      '```sql',
      'SELECT right FROM answers;',
      '```',
      'Done.'
    ].join('\n')
    expect(lastSqlFence(text)).toBe('SELECT right FROM answers;')
  })

  it('skips a trailing empty fence in favour of the last real one', () => {
    const text = '```sql\nSELECT 1;\n```\nand\n```sql\n\n```'
    expect(lastSqlFence(text)).toBe('SELECT 1;')
  })
})

describe('formatElapsed', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(8_400)).toBe('8s')
    expect(formatElapsed(59_400)).toBe('59s')
  })

  it('formats minutes with a seconds remainder', () => {
    expect(formatElapsed(72_000)).toBe('1m 12s')
    expect(formatElapsed(120_000)).toBe('2m')
  })

  it('never goes negative on clock skew', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})
