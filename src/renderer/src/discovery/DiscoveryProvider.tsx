import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type { DiscoveryState } from '../../../shared/settings'
import type { Commands } from './useCommands'
import { Spotlight } from './Spotlight'
import { usage } from './usage'

export interface SpotlightRequest {
  featureId: string
  /** Ids to show after this one ("Next"). */
  queue?: string[]
}

export interface DiscoveryContextValue {
  commands: Commands
  /** Live usage state (re-renders subscribers on change). */
  usageState: DiscoveryState
  markUsed: (featureId: string | undefined) => void
  isTried: (featureId: string) => boolean
  spotlight: {
    show: (req: SpotlightRequest) => void
    hide: () => void
    current: string | null
  }
  /** Open the bundled guide, optionally at a heading slug. */
  openGuide: (anchor?: string) => void
  openDiscover: () => void
}

const DiscoveryContext = createContext<DiscoveryContextValue | null>(null)

/**
 * Shares the command table, usage store and the Spotlight primitive with
 * every discovery surface (palette, Discover, highlight mode, /help) so none
 * of them need props drilled through App. Renders the Spotlight layer itself.
 */
export function DiscoveryProvider({
  commands,
  openGuide,
  openDiscover,
  children
}: {
  commands: Commands
  openGuide: (anchor?: string) => void
  openDiscover: () => void
  children: ReactNode
}): ReactElement {
  const usageState = useSyncExternalStore(usage.subscribe, usage.getState)
  useEffect(() => {
    void usage.load()
  }, [])

  const [spot, setSpot] = useState<{ current: string; queue: string[] } | null>(null)
  const show = useCallback((req: SpotlightRequest) => {
    setSpot({ current: req.featureId, queue: req.queue ?? [] })
  }, [])
  const hide = useCallback(() => setSpot(null), [])
  // The guide dialog sits below the spotlight layer, so dismiss first.
  const learnMore = useCallback(
    (anchor?: string) => {
      setSpot(null)
      openGuide(anchor)
    },
    [openGuide]
  )
  const next = useCallback(() => {
    setSpot((prev) => {
      if (!prev || prev.queue.length === 0) return null
      const [current, ...queue] = prev.queue
      return { current, queue }
    })
  }, [])
  // Spotlighting counts as "seen" the moment the card appears.
  useEffect(() => {
    if (spot) usage.markSeen(spot.current)
  }, [spot])

  const value = useMemo<DiscoveryContextValue>(
    () => ({
      commands,
      usageState,
      markUsed: usage.markUsed,
      isTried: (id) => id in usageState.used || usageState.seen.includes(id),
      spotlight: { show, hide, current: spot?.current ?? null },
      openGuide,
      openDiscover
    }),
    [commands, usageState, show, hide, spot, openGuide, openDiscover]
  )

  return (
    <DiscoveryContext.Provider value={value}>
      {children}
      <Spotlight
        featureId={spot?.current ?? null}
        hasNext={(spot?.queue.length ?? 0) > 0}
        runCommand={commands.run}
        onNext={next}
        onClose={hide}
        onLearnMore={learnMore}
      />
    </DiscoveryContext.Provider>
  )
}

export function useDiscovery(): DiscoveryContextValue {
  const ctx = useContext(DiscoveryContext)
  if (!ctx) throw new Error('useDiscovery must be used inside DiscoveryProvider')
  return ctx
}

/** Optional variant for components that may render outside the provider (tests). */
export function useDiscoveryOptional(): DiscoveryContextValue | null {
  return useContext(DiscoveryContext)
}
