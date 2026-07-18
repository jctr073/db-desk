import type { KnowledgeTargetGroup } from '../../../shared/knowledge'

/** In-flight `knowledge:listForTarget` requests, keyed by (connId, database). */
const pending = new Map<string, Promise<KnowledgeTargetGroup[]>>()

/**
 * `knowledge:listForTarget` with same-task request coalescing.
 *
 * The hooks that load a target's knowledge (`useKnowledgeState` mounted by
 * both the Knowledge tab and the agent panel, plus `useKnowledgeIndexes`) all
 * react to the same triggers — mount/target-change effects of one commit and
 * knowledge change pushes — so a single trigger used to issue up to three
 * identical IPC calls in the same synchronous burst. Callers that ask for the
 * same target while a request started in the current task share its promise.
 *
 * The entry is dropped on the next microtask, i.e. as soon as the triggering
 * task's synchronous work is done. Later calls — in particular reloads issued
 * by a subsequent knowledge:changed push — always hit the bridge again, so no
 * caller can ever observe data staler than what a fresh call would return.
 */
export function listForTargetCoalesced(
  connId: string,
  database: string
): Promise<KnowledgeTargetGroup[]> {
  const key = JSON.stringify([connId, database])
  const inflight = pending.get(key)
  if (inflight) return inflight
  const request = window.dbDesk.knowledge.listForTarget(connId, database)
  pending.set(key, request)
  queueMicrotask(() => pending.delete(key))
  return request
}
