/**
 * Pure helpers for the agent mode picker's prod clamp. Main enforces the
 * clamp authoritatively (agent.ts, db.ts); this is display/outgoing-request
 * truth-telling only. Kept free of React so it is unit-testable.
 *
 * The raw `mode` state (and its localStorage mirror) are never rewritten by
 * clamping — only `effectiveAgentMode`'s result is: a stored Read-Only
 * preference survives a round trip through a clamped connection and is
 * restored the moment the active connection stops being clamped.
 */

import type { AgentMode } from '../../../../shared/agent'
import type { AgentCapability } from '../../../../shared/db'

/** True when the active connection's agent capability blocks Read-Only mode. */
export function isReadOnlyClamped(capability: AgentCapability | null): boolean {
  return capability != null && !capability.readOnlyAvailable
}

/**
 * The mode actually in effect: what the pill shows and what travels in the
 * outgoing AgentSendRequest. Read-Only degrades to Metadata Only while
 * clamped; every other mode (including an already-degraded Metadata Only)
 * passes through unchanged.
 */
export function effectiveAgentMode(
  mode: AgentMode,
  capability: AgentCapability | null
): AgentMode {
  return isReadOnlyClamped(capability) && mode === 'read-only' ? 'metadata' : mode
}
