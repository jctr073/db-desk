import { useCallback, useEffect, useMemo, useState } from 'react'

import { buildUsageIndex } from '../../../shared/knowledge'
import type {
  ColumnRef,
  KnowledgeRecord,
  KnowledgeRecordInput,
  UsageIndex
} from '../../../shared/knowledge'

/** Stable select-option key for a knowledge (connection, database) target. */
export function knowledgeTargetKeyOf(connId: string, database: string): string {
  return JSON.stringify([connId, database])
}

/**
 * A navigation request into the knowledge panel: "Show usages" / "Add
 * annotation…" routed from the schema tree, or "open this record" from a
 * `[kb:id]` citation chip in the agent transcript.
 */
export type KnowledgeNav = {
  /** Monotonic, so repeating the same action on the same target still fires. */
  seq: number
  connId: string
  database: string
} & (
  | { action: 'usages' | 'annotate'; ref: ColumnRef }
  | { action: 'record'; recordId: string }
)

export interface KnowledgeState {
  connId: string | null
  database: string | null
  records: KnowledgeRecord[]
  /** Reverse usage index over `records`; rebuilt whenever they change. */
  index: UsageIndex
  loading: boolean
  loadError: string | null
  /**
   * Target key (`knowledgeTargetKeyOf`) the current `records` were loaded
   * for, or null while they are stale or still loading. Lets nav requests
   * that switch the target wait for the right records instead of resolving
   * against the previous database's.
   */
  loadedKey: string | null

  save: (record: KnowledgeRecordInput) => Promise<KnowledgeRecord | null>
  remove: (id: string) => Promise<boolean>
  clearLoadError: () => void
}

/**
 * Knowledge records for the active (connection, database), kept live: loaded
 * over the preload bridge, then reloaded on every knowledge:changed push that
 * matches the target — so agent writes refresh the panel and tree badges
 * without any UI action.
 */
export function useKnowledgeState(
  connId: string | null,
  database: string | null
): KnowledgeState {
  const [records, setRecords] = useState<KnowledgeRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  useEffect(() => {
    // Never show one database's records against another while loading.
    setRecords([])
    setLoadError(null)
    setLoadedKey(null)
    // Reset unconditionally: a target that clears (or changes mid-flight) must
    // not leave the spinner stuck, since the cancelled load skips its finally.
    setLoading(false)
    if (!connId || !database) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const loaded = await window.dbDesk.knowledge.list(connId, database)
        if (!cancelled) {
          setRecords(loaded)
          setLoadedKey(knowledgeTargetKeyOf(connId, database))
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            `Failed to load knowledge: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    setLoading(true)
    void load()
    const unsubscribe = window.dbDesk.knowledge.onChanged((change) => {
      if (change.connId === connId && change.database === database) void load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [connId, database])

  const save = useCallback(
    async (record: KnowledgeRecordInput): Promise<KnowledgeRecord | null> => {
      if (!connId || !database) return null
      try {
        const saved = await window.dbDesk.knowledge.save(connId, database, record)
        // The change push reloads too; upsert now so the UI doesn't wait.
        setRecords((prev) =>
          prev.some((r) => r.id === saved.id)
            ? prev.map((r) => (r.id === saved.id ? saved : r))
            : [...prev, saved]
        )
        return saved
      } catch (error) {
        setLoadError(
          `Failed to save record: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
    },
    [connId, database]
  )

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      if (!connId || !database) return false
      try {
        await window.dbDesk.knowledge.remove(connId, database, id)
        setRecords((prev) => prev.filter((r) => r.id !== id))
        return true
      } catch (error) {
        setLoadError(
          `Failed to delete record: ${error instanceof Error ? error.message : String(error)}`
        )
        return false
      }
    },
    [connId, database]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  const index = useMemo(() => buildUsageIndex(records), [records])

  return {
    connId,
    database,
    records,
    index,
    loading,
    loadError,
    loadedKey,
    save,
    remove,
    clearLoadError
  }
}

/** The subset of a QueryTarget the badge indexes key off. */
export interface KnowledgeTarget {
  connId: string
  database: string
}

/**
 * Usage indexes for every connected (connection, database) target, keyed by
 * `knowledgeTargetKeyOf`, kept live so the schema tree can badge knowledge
 * across all connected databases — not only the one the Knowledge tab views.
 * A knowledge:changed push reloads just the target it names; connect/disconnect
 * loads the newly connected targets and drops the departed ones.
 */
export function useKnowledgeIndexes(
  targets: KnowledgeTarget[]
): Map<string, UsageIndex> {
  const [indexes, setIndexes] = useState<Map<string, UsageIndex>>(() => new Map())

  // Order-independent signature: the effect only re-runs when membership shifts.
  const signature = targets
    .map((t) => knowledgeTargetKeyOf(t.connId, t.database))
    .sort()
    .join('\n')

  useEffect(() => {
    let cancelled = false
    const active = new Map(
      targets.map((t) => [knowledgeTargetKeyOf(t.connId, t.database), t])
    )

    const load = (connId: string, database: string): void => {
      const key = knowledgeTargetKeyOf(connId, database)
      window.dbDesk.knowledge
        .list(connId, database)
        .then((records) => {
          if (!cancelled) {
            setIndexes((prev) => new Map(prev).set(key, buildUsageIndex(records)))
          }
        })
        .catch(() => {
          // Badges are best-effort; a failed load simply shows no badges.
        })
    }

    // Drop indexes for targets that disconnected.
    setIndexes((prev) => {
      let changed = false
      const next = new Map<string, UsageIndex>()
      for (const [key, value] of prev) {
        if (active.has(key)) next.set(key, value)
        else changed = true
      }
      return changed ? next : prev
    })

    for (const t of active.values()) load(t.connId, t.database)

    // Reload only the target an event names — never the whole set.
    const unsubscribe = window.dbDesk.knowledge.onChanged((change) => {
      if (active.has(knowledgeTargetKeyOf(change.connId, change.database))) {
        load(change.connId, change.database)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [signature])

  return indexes
}
