import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import type { CommandId, Feature } from '../../../shared/features'
import { FEATURES, FEATURE_CATEGORY_LABELS, featureById } from '../../../shared/features'
import { searchFeatures } from '../discovery/search'
import { useEscapeKey } from '../useEscapeKey'

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  run: (id: CommandId) => void
  enabled: (id: CommandId) => boolean
  /** Feature ids recently used, most recent first (empty until phase 3). */
  recent?: string[]
}

interface Section {
  heading: string | null
  features: readonly Feature[]
}

interface Toast {
  title: string
  location: string
}

const TOAST_MS = 4000

/**
 * ⌘K command palette: search-first launcher over the feature registry. A
 * feature with a `command` runs it and closes; a gesture-only feature
 * closes the palette and shows a toast naming where to find it (Phase 3
 * replaces that toast with a Spotlight pointer).
 *
 * The component stays mounted regardless of `open` so the toast can outlive
 * the palette closing — it renders null only once both the overlay and the
 * toast have nothing to show.
 */
export function CommandPalette({
  open,
  onClose,
  run,
  enabled,
  recent
}: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowEls = useRef<(HTMLDivElement | null)[]>([])

  // Reset search + selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  // The toast must survive the palette unmounting, so its timer lives at
  // this level and is cleared on unmount rather than on close.
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  const sections = useMemo<Section[]>(() => {
    const trimmed = query.trim()
    if (trimmed) {
      return [{ heading: null, features: searchFeatures(trimmed, FEATURES) }]
    }

    const result: Section[] = []

    const recentFeatures = (recent ?? [])
      .map((id) => featureById(id))
      .filter((f): f is Feature => f !== undefined)
    if (recentFeatures.length > 0) {
      result.push({ heading: 'Recently used', features: recentFeatures })
    }

    const order: string[] = []
    const byCategory = new Map<string, Feature[]>()
    for (const feature of FEATURES) {
      let bucket = byCategory.get(feature.category)
      if (!bucket) {
        bucket = []
        byCategory.set(feature.category, bucket)
        order.push(feature.category)
      }
      bucket.push(feature)
    }
    for (const category of order) {
      result.push({
        heading: FEATURE_CATEGORY_LABELS[category as Feature['category']],
        features: byCategory.get(category) ?? []
      })
    }

    return result
  }, [query, recent])

  const allFeatures = useMemo(() => sections.flatMap((section) => section.features), [sections])

  useEffect(() => {
    rowEls.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const showToast = (feature: Feature): void => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ title: feature.title, location: feature.location })
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }

  const activate = (feature: Feature): void => {
    if (feature.command) {
      if (!enabled(feature.command)) return
      run(feature.command)
      onClose()
      return
    }
    onClose()
    showToast(feature)
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => (allFeatures.length === 0 ? 0 : (i + 1) % allFeatures.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) =>
        allFeatures.length === 0 ? 0 : (i - 1 + allFeatures.length) % allFeatures.length
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const feature = allFeatures[activeIndex]
      if (feature) activate(feature)
    }
  }

  useEscapeKey(open, onClose)

  if (!open && !toast) return null

  let idx = 0

  return (
    <>
      {open && (
        <div className="dialog-overlay palette-overlay" onMouseDown={onClose}>
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <input
              className="palette__input"
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search features…  (type to filter)"
            />
            <div className="palette__list">
              {allFeatures.length === 0 && (
                <div className="palette__empty">No matching features</div>
              )}
              {sections.map((section, sectionIndex) => (
                <div key={section.heading ?? `flat-${sectionIndex}`}>
                  {section.heading && <div className="palette__group">{section.heading}</div>}
                  {section.features.map((feature) => {
                    const rowIndex = idx++
                    const isDisabled = feature.command !== undefined && !enabled(feature.command)
                    return (
                      <div
                        key={`${section.heading ?? 'flat'}-${feature.id}-${rowIndex}`}
                        ref={(el) => {
                          rowEls.current[rowIndex] = el
                        }}
                        className={`palette__row${rowIndex === activeIndex ? ' is-active' : ''}${isDisabled ? ' is-disabled' : ''}`}
                        onMouseEnter={() => setActiveIndex(rowIndex)}
                        onClick={() => activate(feature)}
                      >
                        <span className="palette__cat">
                          {FEATURE_CATEGORY_LABELS[feature.category]}
                        </span>
                        <span className="palette__title">{feature.title}</span>
                        <span className="palette__desc">{feature.description}</span>
                        {feature.shortcut && <kbd className="palette__kbd">{feature.shortcut}</kbd>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="palette__footer">↑↓ navigate · ⏎ run · esc close</div>
          </div>
        </div>
      )}
      {toast && (
        <div className="palette-toast">
          <strong>{toast.title}</strong> — {toast.location}
        </div>
      )}
    </>
  )
}
