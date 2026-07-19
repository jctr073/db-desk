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

import type { AgentMode, AgentModeOption } from '../../../../shared/agent'
import type { AgentCapability } from '../../../../shared/db'

/** True when the active connection's agent capability blocks Read-Only mode. */
export function isReadOnlyClamped(capability: AgentCapability | null): boolean {
  return capability != null && !capability.readOnlyAvailable
}

/**
 * Whether a picker selection should take effect. A disabled option (write-admin)
 * or Read-Only on a clamped connection is a no-op — and, crucially, must leave
 * the stored preference untouched, so a Read-Only choice survives a detour
 * through a clamped connection. This is the single rule the pick handler and
 * its tests share, so the guard and the UX contract cannot drift apart.
 */
export function isModeSelectable(
  option: AgentModeOption,
  capability: AgentCapability | null
): boolean {
  if (!option.enabled) return false
  return !(option.id === 'read-only' && isReadOnlyClamped(capability))
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
