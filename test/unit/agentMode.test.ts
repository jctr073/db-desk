import { describe, expect, it } from 'vitest'

import { effectiveAgentMode, isReadOnlyClamped } from '../../src/renderer/src/components/agent/agentMode'

describe('isReadOnlyClamped', () => {
  it('is false for a null capability (no active connection, or not yet known)', () => {
    expect(isReadOnlyClamped(null)).toBe(false)
  })

  it('is false when the capability allows Read-Only mode', () => {
    expect(isReadOnlyClamped({ readOnlyAvailable: true, reason: null })).toBe(false)
  })

  it('is true when the capability blocks Read-Only mode', () => {
    expect(isReadOnlyClamped({ readOnlyAvailable: false, reason: 'writable role' })).toBe(true)
  })
})

describe('effectiveAgentMode', () => {
  it('degrades read-only to metadata when clamped', () => {
    const capability = { readOnlyAvailable: false, reason: 'writable role' }
    expect(effectiveAgentMode('read-only', capability)).toBe('metadata')
  })

  it('leaves metadata as metadata when clamped', () => {
    const capability = { readOnlyAvailable: false, reason: 'writable role' }
    expect(effectiveAgentMode('metadata', capability)).toBe('metadata')
  })

  it('passes every mode through unchanged when unclamped', () => {
    const capability = { readOnlyAvailable: true, reason: null }
    expect(effectiveAgentMode('read-only', capability)).toBe('read-only')
    expect(effectiveAgentMode('metadata', capability)).toBe('metadata')
    expect(effectiveAgentMode('write-admin', capability)).toBe('write-admin')
  })

  it('passes every mode through unchanged when capability is null', () => {
    expect(effectiveAgentMode('read-only', null)).toBe('read-only')
    expect(effectiveAgentMode('metadata', null)).toBe('metadata')
  })
})
