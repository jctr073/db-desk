import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { featureById } from '../../../shared/features'
import { useDiscovery } from './DiscoveryProvider'
import { useEscapeKey } from '../useEscapeKey'

const RECOMPUTE_INTERVAL_MS = 500

interface Beacon {
  id: string
  title: string
  x: number
  y: number
}

function collectBeacons(): Beacon[] {
  const nodes = document.querySelectorAll<HTMLElement>('[data-feature]')
  const seen = new Set<string>()
  const beacons: Beacon[] = []

  for (const el of nodes) {
    const id = el.dataset.feature
    if (!id || seen.has(id)) continue

    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      continue
    }

    const feature = featureById(id)
    if (!feature) continue

    seen.add(id)
    beacons.push({
      id,
      title: feature.title,
      x: rect.right - 9,
      y: rect.top - 9
    })
  }

  return beacons
}

/**
 * ⌘⇧/ (Help › Highlight Features): draws a numbered beacon on every
 * anchored, visible control at once, so a user can scan "everything DB Desk
 * can do from here" instead of hunting one feature at a time. Built on the
 * Spotlight primitive from phase 3 — a beacon click just calls
 * `spotlight.show`, keeping highlight mode active underneath so the user can
 * click through several.
 */
export function HighlightMode({
  active,
  onExit
}: {
  active: boolean
  onExit: () => void
}): ReactElement | null {
  const { spotlight, openDiscover } = useDiscovery()
  const [beacons, setBeacons] = useState<Beacon[]>([])

  useEffect(() => {
    if (!active) {
      setBeacons([])
      return
    }

    const recompute = (): void => setBeacons(collectBeacons())
    recompute()

    window.addEventListener('resize', recompute)
    window.addEventListener('scroll', recompute, true)
    const interval = window.setInterval(recompute, RECOMPUTE_INTERVAL_MS)

    return () => {
      window.removeEventListener('resize', recompute)
      window.removeEventListener('scroll', recompute, true)
      window.clearInterval(interval)
    }
  }, [active])

  // When a spotlight card is open, Esc closes the card (Spotlight owns that
  // listener); only exit highlight mode when nothing is spotlit.
  useEscapeKey(active && spotlight.current === null, onExit)

  if (!active) return null

  return (
    <>
      <div className="beacon-layer">
        {beacons.map((beacon, index) => (
          <button
            key={beacon.id}
            type="button"
            className="beacon"
            title={beacon.title}
            style={{ left: beacon.x, top: beacon.y }}
            onClick={() => spotlight.show({ featureId: beacon.id })}
          >
            {index + 1}
          </button>
        ))}
      </div>
      <div className="highlight-banner">
        <span>Highlight mode — click a beacon to learn about it · Esc to exit</span>
        <button
          type="button"
          className="highlight-banner__link"
          onClick={() => {
            onExit()
            openDiscover()
          }}
        >
          Show unanchored features
        </button>
        <button type="button" className="btn-cancel highlight-banner__exit" onClick={onExit}>
          Exit
        </button>
      </div>
    </>
  )
}
