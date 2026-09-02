import type { DiscoveryState } from '../../../shared/settings'
import { EMPTY_DISCOVERY_STATE } from '../../../shared/settings'
import { featureById } from '../../../shared/features'

/**
 * Feature usage tracking (plan §4.4). One module-level store so both React
 * (via `useSyncExternalStore` in DiscoveryProvider) and plain callbacks
 * (`useCommands.run`, the real button handlers) can record usage without
 * needing a context. Writes are debounced and go through main's settings
 * store; the storage can be swapped by editing this file alone.
 */

const WRITE_DEBOUNCE_MS = 1000

let state: DiscoveryState = EMPTY_DISCOVERY_STATE
let loaded = false
const listeners = new Set<() => void>()
let writeTimer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void window.dbDesk.settings.setDiscovery(state).catch(() => {
      // Best effort: usage is a convenience, never worth surfacing an error.
    })
  }, WRITE_DEBOUNCE_MS)
}

function update(next: DiscoveryState): void {
  state = next
  emit()
  scheduleWrite()
}

/** Feature ids by most recent use, for the palette's "Recently used". */
export function recentFrom(state: DiscoveryState, limit = 5): string[] {
  return Object.entries(state.used)
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, limit)
    .map(([id]) => id)
}

export const usage = {
  getState: (): DiscoveryState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Load once at startup; later calls are no-ops. */
  load: async (): Promise<void> => {
    if (loaded) return
    loaded = true
    try {
      state = await window.dbDesk.settings.getDiscovery()
      emit()
    } catch {
      // Keep the empty state; the first write will create the record.
    }
  },
  /** Record that the user ran a feature (any surface). Unknown ids are ignored. */
  markUsed: (featureId: string | undefined): void => {
    if (!featureId || !featureById(featureId)) return
    const prev = state.used[featureId]
    update({
      ...state,
      used: {
        ...state.used,
        [featureId]: { count: (prev?.count ?? 0) + 1, last: Date.now() }
      }
    })
  },
  /** Record that a feature was spotlighted. */
  markSeen: (featureId: string): void => {
    if (!featureById(featureId) || state.seen.includes(featureId)) return
    update({ ...state, seen: [...state.seen, featureId] })
  },
  /** Used or seen: drives the Discover ticks and progress. */
  isTried: (featureId: string): boolean =>
    featureId in state.used || state.seen.includes(featureId),
  recent: (limit = 5): string[] => recentFrom(state, limit)
}
