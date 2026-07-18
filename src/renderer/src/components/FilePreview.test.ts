import { describe, expect, it } from 'vitest'

import { formatJsonPreview, parseMarkdownPreview } from './FilePreview'

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
