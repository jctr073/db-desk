import { describe, expect, it } from 'vitest'

import {
  effectiveAgentMode,
  isModeSelectable,
  isReadOnlyClamped
} from '../../src/renderer/src/components/agent/agentMode'
import { AGENT_MODES } from '../../src/shared/agent'
import type { AgentMode } from '../../src/shared/agent'

const option = (id: AgentMode) => AGENT_MODES.find((m) => m.id === id)!
const CLAMPED = { readOnlyAvailable: false, reason: 'writable role' }
const OPEN = { readOnlyAvailable: true, reason: null }

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

describe('isModeSelectable', () => {
  it('blocks Read-Only on a clamped connection (leaving the stored preference untouched)', () => {
    expect(isModeSelectable(option('read-only'), CLAMPED)).toBe(false)
  })

  it('allows Read-Only when the connection is unclamped or unknown', () => {
    expect(isModeSelectable(option('read-only'), OPEN)).toBe(true)
    expect(isModeSelectable(option('read-only'), null)).toBe(true)
  })

  it('always allows Metadata Only', () => {
    expect(isModeSelectable(option('metadata'), CLAMPED)).toBe(true)
    expect(isModeSelectable(option('metadata'), OPEN)).toBe(true)
  })

  it('never allows the disabled write-admin option', () => {
    expect(isModeSelectable(option('write-admin'), OPEN)).toBe(false)
  })
})
