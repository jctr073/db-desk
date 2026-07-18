/**
 * Guards the corpus itself, so the integration sweep tests something coherent.
 *
 * The classifier assertions live in test/unit/sql.test.ts and are written
 * against classifyStatement -- which does not exist yet (docs/agent-modes.md
 * step 1). Once it does, that file will import `expected` from the corpus and
 * assert classifyStatement(sql) === expected for every case. These checks only
 * ensure the corpus is internally consistent in the meantime.
 */

import { describe, expect, it } from 'vitest'
import { ALL_CASES, ESCAPE_CASES, PG_CASES } from '../support/statements'

describe('statement corpus integrity', () => {
  it('has cases', () => {
    expect(ALL_CASES.length).toBeGreaterThan(30)
  })

  it('gives every case a unique name', () => {
    const names = ALL_CASES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('only ever labels a mutating statement `read` when the belt also blocks it', () => {
    // The safety invariant, stated on the corpus: if we call something a read,
    // running it must not change data. The one SELECT-that-writes case is
    // `read` yet `rejected` by the belt -- so it never mutates. Nothing that
    // mutates may be `read`.
    for (const c of ALL_CASES) {
      if (c.mutates) {
        expect(c.expected, `mutating case labelled read: ${c.name}`).not.toBe('read')
      }
    }
  })

  it('lists escapes that are permitted by the belt yet mutate', () => {
    expect(ESCAPE_CASES.length).toBeGreaterThan(0)
    for (const c of ESCAPE_CASES) {
      expect(c.underReadOnly, c.name).toBe('permitted')
      expect(c.expected, c.name).toBe('unknown')
    }
  })

  it('excludes non-Postgres cases from the Postgres sweep', () => {
    for (const c of PG_CASES) expect(c.skipIntegration).toBeUndefined()
  })
})
