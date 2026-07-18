import { useCallback, useEffect, useState } from 'react'

import { pickDefaultLink } from '../../../../shared/knowledge'
import type { KnowledgeLink } from '../../../../shared/knowledge'
import type { RepoStatus } from '../../../../shared/repo'
import type { QueryTarget } from '../useQueryRunner'

/**
 * Knowledge links and per-base codebase status for the agent panel.
 * Codebase attachment lives on the knowledge base, so repo status is keyed
 * by kbId; a target's status is that of its default linked base.
 * The return type is inferred so it stays in sync with the body.
 */
export function useRepoLinks(targets: QueryTarget[]) {
  const [repoStatuses, setRepoStatuses] = useState<Record<string, RepoStatus>>({})
  /** Every knowledge link, so any target's default base resolves in-process. */
  const [links, setLinks] = useState<KnowledgeLink[]>([])

  // Keep the link table live so any target's default base resolves without a
  // round-trip; structural pushes cover bases/links created or removed.
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.dbDesk.knowledge
        .listLinks()
        .then((next) => {
          if (!cancelled) setLinks(next)
        })
        .catch(() => {
          // Best-effort: a failed load simply leaves targets with no base.
        })
    }
    load()
    const unsubscribe = window.dbDesk.knowledge.onStructureChanged(load)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Load codebase status for every base linked to a connected target, so the
  // composer's repo flag and the manage dialog's per-base codebase view both
  // resolve. Re-runs when the links change or targets come and go.
  useEffect(() => {
    let cancelled = false
    const kbIds = new Set<string>()
    for (const t of targets) {
      for (const link of links) {
        if (link.connId === t.connId && link.database === t.database) {
          kbIds.add(link.kbId)
        }
      }
    }
    for (const kbId of kbIds) {
      void window.dbDesk.repo.get(kbId).then((status) => {
        if (!cancelled) {
          setRepoStatuses((current) => ({ ...current, [status.kbId]: status }))
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [targets, links])

  /**
   * A (connection, database) target's default knowledge base — the shared
   * pickDefaultLink rule over its links, so the composer, scans, and the agent
   * write path all agree on which base is "active" when none is named.
   */
  const defaultBaseFor = useCallback(
    (connId: string | undefined, database: string | undefined): string | null => {
      if (!connId || !database) return null
      const forTarget = links.filter((l) => l.connId === connId && l.database === database)
      return pickDefaultLink(forTarget)?.kbId ?? null
    },
    [links]
  )

  /** The codebase status of a target's default base, or null when it has none. */
  const repoStatusFor = useCallback(
    (connId: string | undefined, database: string | undefined): RepoStatus | null => {
      const kbId = defaultBaseFor(connId, database)
      return kbId ? (repoStatuses[kbId] ?? null) : null
    },
    [defaultBaseFor, repoStatuses]
  )

  const rememberRepoStatus = useCallback((status: RepoStatus) => {
    setRepoStatuses((current) => ({ ...current, [status.kbId]: status }))
  }, [])

  /** Clears the base's codebase; its knowledge records are kept. */
  const detachCodebase = useCallback(
    async (kbId: string): Promise<void> => {
      const status = await window.dbDesk.repo.clear(kbId)
      rememberRepoStatus(status)
    },
    [rememberRepoStatus]
  )

  /** Clears the codebase and deletes the base everywhere it is linked. */
  const detachAndDeleteBase = useCallback(
    async (kbId: string): Promise<void> => {
      const status = await window.dbDesk.repo.clear(kbId)
      rememberRepoStatus(status)
      await window.dbDesk.knowledge.deleteBase(kbId)
    },
    [rememberRepoStatus]
  )

  return {
    links,
    repoStatuses,
    defaultBaseFor,
    repoStatusFor,
    rememberRepoStatus,
    detachCodebase,
    detachAndDeleteBase
  }
}
