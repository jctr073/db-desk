/**
 * Unit tests for resolveSchemaListing (src/main/drivers/databricks.ts) — the
 * pure decision helper behind schema pinning and the prompt-when-large flow.
 */

import { describe, expect, it } from 'vitest'

import { resolveSchemaListing } from '../../src/main/drivers/databricks'

const NAMES = ['analytics', 'default', 'ops', 'sales', 'staging']

describe('resolveSchemaListing', () => {
  it('keeps only pinned schemas, preserving listing order', () => {
    const out = resolveSchemaListing(NAMES, ['sales', 'analytics'], 25)
    expect(out).toEqual({
      schemas: ['analytics', 'sales'],
      needsSelection: false,
      availableCount: 5
    })
  })

  it('drops pinned names that no longer exist', () => {
    const out = resolveSchemaListing(NAMES, ['sales', 'dropped'], 25)
    expect(out.schemas).toEqual(['sales'])
  })

  it('a pinned catalog never prompts, whatever its size', () => {
    const out = resolveSchemaListing(NAMES, ['sales'], 2)
    expect(out.needsSelection).toBe(false)
    expect(out.schemas).toEqual(['sales'])
  })

  it('an empty pinned list yields zero schemas without prompting', () => {
    const out = resolveSchemaListing(NAMES, [], 25)
    expect(out).toEqual({ schemas: [], needsSelection: false, availableCount: 5 })
  })

  it('unpinned over the threshold flags needsSelection with no schemas', () => {
    const out = resolveSchemaListing(NAMES, null, 4)
    expect(out).toEqual({ schemas: [], needsSelection: true, availableCount: 5 })
  })

  it('unpinned at or under the threshold loads everything', () => {
    expect(resolveSchemaListing(NAMES, null, 5).schemas).toEqual(NAMES)
    expect(resolveSchemaListing(NAMES, null, 5).needsSelection).toBe(false)
  })

  it('no threshold means everything loads', () => {
    const out = resolveSchemaListing(NAMES, null, undefined)
    expect(out).toEqual({ schemas: NAMES, needsSelection: false, availableCount: 5 })
  })
})
