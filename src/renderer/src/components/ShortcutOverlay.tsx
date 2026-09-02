import type { ReactElement } from 'react'

import type { Feature, FeatureCategory } from '../../../shared/features'
import { FEATURES, FEATURE_CATEGORY_LABELS } from '../../../shared/features'
import { useEscapeKey } from '../useEscapeKey'

interface Group {
  category: FeatureCategory
  features: readonly Feature[]
}

/** Categories that have at least one feature with a shortcut, in registry order. */
function groupShortcuts(): Group[] {
  const order: FeatureCategory[] = []
  const byCategory = new Map<FeatureCategory, Feature[]>()
  for (const feature of FEATURES) {
    if (!feature.shortcut) continue
    let bucket = byCategory.get(feature.category)
    if (!bucket) {
      bucket = []
      byCategory.set(feature.category, bucket)
      order.push(feature.category)
    }
    bucket.push(feature)
  }
  return order.map((category) => ({ category, features: byCategory.get(category) ?? [] }))
}

/**
 * ⌘/ keyboard shortcuts sheet: every registry feature that has a `shortcut`,
 * grouped by category in registry order. Reuses the palette's dialog chrome.
 */
export function ShortcutOverlay({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  useEscapeKey(open, onClose)

  if (!open) return null

  const groups = groupShortcuts()

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="shortcuts__header">
          <span>Keyboard shortcuts</span>
          <button className="shortcuts__close" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="shortcuts__body">
          {groups.map((group) => (
            <div className="shortcuts__group" key={group.category}>
              <div className="shortcuts__group-title">
                {FEATURE_CATEGORY_LABELS[group.category]}
              </div>
              {group.features.map((feature) => (
                <div className="shortcuts__row" key={feature.id}>
                  <span className="shortcuts__label">{feature.title}</span>
                  <kbd className="shortcuts__kbd">{feature.shortcut}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="shortcuts__footer">Press ⌘K to search every feature</div>
      </div>
    </div>
  )
}
