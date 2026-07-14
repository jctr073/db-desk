import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SqlCode } from '../../src/renderer/src/components/SqlCode'

describe('SqlCode', () => {
  it('renders SQL tokens with the shared theme classes', () => {
    const markup = renderToStaticMarkup(
      createElement(SqlCode, {
        sql: "SELECT COUNT(*) FROM orders WHERE total >= 10 AND state = 'paid' -- final"
      })
    )

    expect(markup).toContain('class="sql-kw"')
    expect(markup).toContain('class="sql-fn"')
    expect(markup).toContain('class="sql-num"')
    expect(markup).toContain('class="sql-str"')
    expect(markup).toContain('class="sql-comment"')
    expect(markup).toContain('class="sql-op"')
  })
})
