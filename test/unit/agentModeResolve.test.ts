/**
 * The main-process mode-resolution chain (src/shared/agent.ts): resolveAgentMode
 * fails closed on junk, and clampAgentMode degrades Read-Only to Metadata Only
 * for a clamped or unverifiable connection. This is the authoritative decision
 * runAgentTurn makes before building the turn's prompt and tools, so it is
 * pinned here independently of the (unexported) turn loop.
 */

import { describe, expect, it } from 'vitest'

import { clampAgentMode, resolveAgentMode } from '../../src/shared/agent'
import type { AgentCapability } from '../../src/shared/db'

const OPEN: AgentCapability = { readOnlyAvailable: true, reason: null }
const CLAMPED: AgentCapability = { readOnlyAvailable: false, reason: 'nope' }

describe('resolveAgentMode', () => {
  it('passes through enabled modes', () => {
    expect(resolveAgentMode('metadata')).toBe('metadata')
    expect(resolveAgentMode('read-only')).toBe('read-only')
  })

  it('fails closed on the disabled write-admin mode and on junk', () => {
    expect(resolveAgentMode('write-admin')).toBe('metadata')
    expect(resolveAgentMode('garbage')).toBe('metadata')
    expect(resolveAgentMode(undefined)).toBe('metadata')
  })
})

describe('clampAgentMode', () => {
  it('degrades Read-Only to Metadata Only when the connection is clamped', () => {
    expect(clampAgentMode('read-only', CLAMPED)).toBe('metadata')
  })

  it('degrades Read-Only when no capability is recorded (fail closed)', () => {
    expect(clampAgentMode('read-only', null)).toBe('metadata')
  })

  it('leaves Read-Only intact on an unrestricted connection', () => {
    expect(clampAgentMode('read-only', OPEN)).toBe('read-only')
  })

  it('passes non-Read-Only modes through regardless of capability', () => {
    expect(clampAgentMode('metadata', CLAMPED)).toBe('metadata')
    expect(clampAgentMode('metadata', null)).toBe('metadata')
    expect(clampAgentMode('write-admin', OPEN)).toBe('write-admin')
  })
})
