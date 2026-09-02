import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

import type { CommandId } from '../../../shared/features'
import { featureById } from '../../../shared/features'
import { useEscapeKey } from '../useEscapeKey'

const PAD = 6
const MAX_FRAMES = 10
const CARD_WIDTH = 300
const CARD_MARGIN = 12
const GAP_BELOW_ABOVE_THRESHOLD = 200

export interface SpotlightProps {
  /** Feature id to spotlight; null hides the layer. */
  featureId: string | null
  /** Whether a "Next" queue remains. */
  hasNext: boolean
  /** Runs a command; used to reveal a feature's tab/menu before spotlighting. */
  runCommand: (id: CommandId) => void
  onNext: () => void
  onClose: () => void
  /** Opens the guide, optionally scrolled to an anchor slug. */
  onLearnMore: (anchor?: string) => void
}

interface Padded {
  top: number
  left: number
  width: number
  height: number
}

function padRect(rect: DOMRect): Padded {
  return {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2
  }
}

function measure(anchor: string): DOMRect | null {
  const el = document.querySelector(`[data-feature="${anchor}"]`)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return rect
}

/**
 * The primitive every discovery surface (palette, Discover, highlight mode,
 * /help) uses to point at a real control: a dimmed full-window layer with a
 * cut-out around the anchored element and a card explaining it, or — when no
 * anchored element exists (context-menu-only features) — a single centred
 * card with "Where to find it".
 */
export function Spotlight({
  featureId,
  hasNext,
  runCommand,
  onNext,
  onClose,
  onLearnMore
}: SpotlightProps): ReactElement | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [resolved, setResolved] = useState(false)

  useEscapeKey(featureId !== null, onClose)

  useEffect(() => {
    setRect(null)
    setResolved(false)

    if (featureId === null) return

    const feature = featureById(featureId)
    if (!feature) {
      onClose()
      return
    }

    if (feature.reveal) runCommand(feature.reveal)

    const anchor = feature.anchor ?? feature.id
    let frame = 0
    let raf = 0
    let cancelled = false

    const tick = (): void => {
      if (cancelled) return
      const found = measure(anchor)
      if (found) {
        setRect(found)
        setResolved(true)
        return
      }
      frame += 1
      if (frame >= MAX_FRAMES) {
        setRect(null)
        setResolved(true)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const onReposition = (): void => {
      const found = measure(anchor)
      setRect(found)
    }
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [featureId, runCommand, onClose])

  if (featureId === null || !resolved) return null
  const feature = featureById(featureId)
  if (!feature) return null

  const actions = (
    <div className="spotlight__actions">
      <button type="button" className="btn-cancel" onClick={() => onLearnMore(feature.guide)}>
        Learn more
      </button>
      {hasNext && (
        <button type="button" className="btn-cancel" onClick={onNext}>
          Next
        </button>
      )}
      <button type="button" className="btn-primary" onClick={onClose}>
        Done
      </button>
    </div>
  )

  const titleRow = (
    <div className="spotlight__title">
      <span>{feature.title}</span>
      {feature.shortcut && <kbd>{feature.shortcut}</kbd>}
    </div>
  )

  if (!rect) {
    return (
      <div className="spotlight">
        <div className="spotlight__backdrop" onMouseDown={onClose} />
        <div className="spotlight__card spotlight__card--centered">
          {titleRow}
          <div className="spotlight__desc">{feature.description}</div>
          <div className="spotlight__where">Where to find it:</div>
          <div className="spotlight__loc">{feature.location}</div>
          {actions}
        </div>
      </div>
    )
  }

  const hole = padRect(rect)
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight

  const roomBelow = viewportH - (hole.top + hole.height)
  const showBelow = roomBelow >= GAP_BELOW_ABOVE_THRESHOLD

  let cardLeft = hole.left + hole.width / 2 - CARD_WIDTH / 2
  cardLeft = Math.max(CARD_MARGIN, Math.min(cardLeft, viewportW - CARD_WIDTH - CARD_MARGIN))

  const cardStyle: CSSProperties = showBelow
    ? { left: cardLeft, top: hole.top + hole.height + 10, width: CARD_WIDTH }
    : { left: cardLeft, bottom: viewportH - hole.top + 10, width: CARD_WIDTH }

  return (
    <div className="spotlight">
      <div
        className="spotlight__backdrop"
        style={{ top: 0, left: 0, width: '100%', height: Math.max(hole.top, 0) }}
        onMouseDown={onClose}
      />
      <div
        className="spotlight__backdrop"
        style={{
          top: hole.top + hole.height,
          left: 0,
          width: '100%',
          height: Math.max(viewportH - (hole.top + hole.height), 0)
        }}
        onMouseDown={onClose}
      />
      <div
        className="spotlight__backdrop"
        style={{ top: hole.top, left: 0, width: Math.max(hole.left, 0), height: hole.height }}
        onMouseDown={onClose}
      />
      <div
        className="spotlight__backdrop"
        style={{
          top: hole.top,
          left: hole.left + hole.width,
          width: Math.max(viewportW - (hole.left + hole.width), 0),
          height: hole.height
        }}
        onMouseDown={onClose}
      />
      <div
        className="spotlight__hole"
        style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
      />
      <div className="spotlight__card" style={cardStyle}>
        {titleRow}
        <div className="spotlight__desc">{feature.description}</div>
        <div className="spotlight__loc">{feature.location}</div>
        {actions}
      </div>
    </div>
  )
}
