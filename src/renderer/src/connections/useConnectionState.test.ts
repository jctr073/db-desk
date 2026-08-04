import { describe, expect, it } from 'vitest'

import type { AgentCapability } from '../../../shared/db'
import { writableWarningFor } from './useConnectionState'

describe('writableWarningFor', () => {
  it('builds the warning payload for a writable verdict, passing the schema list through', () => {
    const capability: AgentCapability = {
      readOnlyAvailable: false,
      reason: 'The connecting role can write to production schema "billing".',
      verdict: 'writable',
      writableSchemas: ['billing', 'orders']
    }

    expect(writableWarningFor('conn-1', 'Prod DB', capability)).toEqual({
      connId: 'conn-1',
      connName: 'Prod DB',
      writableSchemas: ['billing', 'orders']
    })
  })

  it('defaults to an empty schema list for a role-attribute clamp (superuser/BYPASSRLS)', () => {
    const capability: AgentCapability = {
      readOnlyAvailable: false,
      reason: 'The connecting role is a superuser.',
      verdict: 'writable'
    }

    expect(writableWarningFor('conn-1', 'Prod DB', capability)).toEqual({
      connId: 'conn-1',
      connName: 'Prod DB',
      writableSchemas: []
    })
  })

  it('does not show a dialog for an indeterminate verdict (passive clamp only)', () => {
    const capability: AgentCapability = {
      readOnlyAvailable: false,
      reason: 'The write-access probe could not be completed.',
      verdict: 'indeterminate'
    }

    expect(writableWarningFor('conn-1', 'Prod DB', capability)).toBeNull()
  })

  it('does not show a dialog when the agent is unrestricted (no verdict)', () => {
    const capability: AgentCapability = {
      readOnlyAvailable: true,
      reason: null
    }

    expect(writableWarningFor('conn-1', 'Prod DB', capability)).toBeNull()
  })
})
