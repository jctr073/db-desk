import { useCallback, useEffect, useMemo, useState } from 'react'

import { buildUsageIndex, pickDefaultLink } from '../../../shared/knowledge'
import type {
  ColumnRef,
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeTargetGroup,
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
} & ({ action: 'usages' | 'annotate'; ref: ColumnRef } | { action: 'record'; recordId: string })

export interface KnowledgeState {
  connId: string | null
  database: string | null
  /** Every base linked to the target, with its link and records. */
  groups: KnowledgeTargetGroup[]
  /**
   * Which base the record list acts on; null (the default) means "all linked
   * bases". New records then go to the pickDefaultLink base — the same default
   * the agent's write path uses — while edits always save to the owning base.
   */
  selectedKbId: string | null
  setSelectedKbId: (kbId: string | null) => void
  /**
   * The selected base's records, or the union of every linked base's when no
   * single base is selected (empty when no base is linked).
   */
  records: KnowledgeRecord[]
  /**
   * Reverse usage index over the UNION of every linked base's records, so tree
   * badges and the usages view span all bases a target draws on — not just the
   * one currently selected in the dropdown. Rebuilt whenever the groups change.
   */
  index: UsageIndex
  loading: boolean
  loadError: string | null
  /**
   * Target key (`knowledgeTargetKeyOf`) the current `groups` were loaded for,
   * or null while they are stale or still loading. Lets nav requests that
   * switch the target wait for the right records instead of resolving against
   * the previous database's.
   */
  loadedKey: string | null

  save: (record: KnowledgeRecordInput) => Promise<KnowledgeRecord | null>
  remove: (id: string) => Promise<boolean>
  clearLoadError: () => void
}

/**
 * Knowledge for the active (connection, database), kept live: the target's
 * linked bases and their records are loaded over the preload bridge, then
 * reloaded on every knowledge:changed push that names this target (so agent
 * writes refresh the panel and tree badges without any UI action) and on every
 * structural push (a base or link created/removed shifts what is linked here).
 */
export function useKnowledgeState(connId: string | null, database: string | null): KnowledgeState {
  const [groups, setGroups] = useState<KnowledgeTargetGroup[]>([])
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  useEffect(() => {
    // Never show one database's records against another while loading.
    setGroups([])
    setLoadError(null)
    setLoadedKey(null)
    // Reset unconditionally: a target that clears (or changes mid-flight) must
    // not leave the spinner stuck, since the cancelled load skips its finally.
    setLoading(false)
    if (!connId || !database) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const loaded = await window.dbDesk.knowledge.listForTarget(connId, database)
        if (!cancelled) {
          setGroups(loaded)
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
    const offChanged = window.dbDesk.knowledge.onChanged((change) => {
      if (change.targets.some((t) => t.connId === connId && t.database === database)) {
        void load()
      }
    })
    // Any structural change can add or drop a link for this target.
    const offStructure = window.dbDesk.knowledge.onStructureChanged(() => void load())
    return () => {
      cancelled = true
      offChanged()
      offStructure()
    }
  }, [connId, database])

  // Keep an explicit selection only while its base stays linked; otherwise
  // fall back to the all-bases view (null), which is also the initial state.
  // With a single linked base the all-bases view shows the same records, so
  // select that base outright and keep the dropdown label concrete.
  useEffect(() => {
    setSelectedKbId((current) => {
      if (current && groups.some((g) => g.base.id === current)) return current
      return groups.length === 1 ? groups[0].base.id : null
    })
  }, [groups])

  const selectedGroup = useMemo(
    () => groups.find((g) => g.base.id === selectedKbId) ?? null,
    [groups, selectedKbId]
  )
  const records = useMemo(
    () => (selectedGroup ? selectedGroup.records : groups.flatMap((g) => g.records)),
    [groups, selectedGroup]
  )

  const save = useCallback(
    async (record: KnowledgeRecordInput): Promise<KnowledgeRecord | null> => {
      // Updates go to the base that holds the record (in the all-bases view an
      // edited record can belong to any of them); new records go to the
      // selected base, or to the shared default-link base — the same rule the
      // agent's write path applies — when viewing all bases.
      const owner = record.id
        ? groups.find((g) => g.records.some((r) => r.id === record.id))?.base.id
        : undefined
      const kbId =
        owner ?? selectedKbId ?? pickDefaultLink(groups.flatMap((g) => g.links))?.kbId ?? null
      if (!kbId) return null
      try {
        const saved = await window.dbDesk.knowledge.save(kbId, record)
        // The change push reloads too; upsert now so the UI doesn't wait.
        setGroups((prev) =>
          prev.map((g) =>
            g.base.id === kbId
              ? {
                  ...g,
                  records: g.records.some((r) => r.id === saved.id)
                    ? g.records.map((r) => (r.id === saved.id ? saved : r))
                    : [...g.records, saved]
                }
              : g
          )
        )
        return saved
      } catch (error) {
        setLoadError(
          `Failed to save record: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
    },
    [groups, selectedKbId]
  )

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      // A record can belong to any linked base (the usages view spans them),
      // so route the delete to whichever base actually holds it.
      const owner = groups.find((g) => g.records.some((r) => r.id === id))
      if (!owner) return false
      try {
        await window.dbDesk.knowledge.remove(owner.base.id, id)
        setGroups((prev) =>
          prev.map((g) =>
            g.base.id === owner.base.id
              ? { ...g, records: g.records.filter((r) => r.id !== id) }
              : g
          )
        )
        return true
      } catch (error) {
        setLoadError(
          `Failed to delete record: ${error instanceof Error ? error.message : String(error)}`
        )
        return false
      }
    },
    [groups]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  const index = useMemo(() => buildUsageIndex(groups.flatMap((g) => g.records)), [groups])

  return {
    connId,
    database,
    groups,
    selectedKbId,
    setSelectedKbId,
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

/** The whole base list and link table, for structure-level UI. */
export interface KnowledgeStructure {
  bases: KnowledgeBaseSummary[]
  links: KnowledgeLink[]
}

/**
 * Every knowledge base and every link, kept live: backs the connection
 * tree's schema-node link submenu and "knowledge linked" indicators, which
 * span all connections rather than one target. Reloads wholesale on every
 * structural push, and on record pushes too (base summaries carry record
 * counts) — both lists are small.
 */
export function useKnowledgeStructure(): KnowledgeStructure {
  const [structure, setStructure] = useState<KnowledgeStructure>({
    bases: [],
    links: []
  })
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void Promise.all([window.dbDesk.knowledge.listBases(), window.dbDesk.knowledge.listLinks()])
        .then(([bases, links]) => {
          if (!cancelled) setStructure({ bases, links })
        })
        .catch(() => {
          // Structure UI is best-effort; keep the previous state on failure.
        })
    }
    load()
    const offChanged = window.dbDesk.knowledge.onChanged(load)
    const offStructure = window.dbDesk.knowledge.onStructureChanged(load)
    return () => {
      cancelled = true
      offChanged()
      offStructure()
    }
  }, [])
  return structure
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
 * Each index unions every base linked to that target. A knowledge:changed push
 * reloads only the targets it names; a structural push reloads them all (a link
 * added/removed changes which bases feed a target); connect/disconnect loads
 * the newly connected targets and drops the departed ones.
 */
export function useKnowledgeIndexes(targets: KnowledgeTarget[]): Map<string, UsageIndex> {
  const [indexes, setIndexes] = useState<Map<string, UsageIndex>>(() => new Map())

  // Order-independent signature: the effect only re-runs when membership shifts.
  const signature = targets
    .map((t) => knowledgeTargetKeyOf(t.connId, t.database))
    .sort()
    .join('\n')

  useEffect(() => {
    let cancelled = false
    const active = new Map(targets.map((t) => [knowledgeTargetKeyOf(t.connId, t.database), t]))

    const load = (connId: string, database: string): void => {
      const key = knowledgeTargetKeyOf(connId, database)
      window.dbDesk.knowledge
        .listForTarget(connId, database)
        .then((groups) => {
          if (!cancelled) {
            const records = groups.flatMap((g) => g.records)
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

    // Reload only the targets an event names — never the whole set.
    const offChanged = window.dbDesk.knowledge.onChanged((change) => {
      for (const t of change.targets) {
        if (active.has(knowledgeTargetKeyOf(t.connId, t.database))) {
          load(t.connId, t.database)
        }
      }
    })
    // Structural changes can re-link any target, so refresh them all.
    const offStructure = window.dbDesk.knowledge.onStructureChanged(() => {
      for (const t of active.values()) load(t.connId, t.database)
    })
    return () => {
      cancelled = true
      offChanged()
      offStructure()
    }
  }, [signature])

  return indexes
}
