import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { Feature, FeatureCategory } from '../../../shared/features'
import { FEATURES, FEATURE_CATEGORY_LABELS } from '../../../shared/features'
import { useDiscovery } from '../discovery/DiscoveryProvider'
import { useEscapeKey } from '../useEscapeKey'

/** Categories in registry order, deduped — drives the rail's row order. */
const CATEGORY_ORDER: FeatureCategory[] = (() => {
  const seen = new Set<FeatureCategory>()
  const order: FeatureCategory[] = []
  for (const feature of FEATURES) {
    if (!seen.has(feature.category)) {
      seen.add(feature.category)
      order.push(feature.category)
    }
  }
  return order
})()

/**
 * The "Discover features" browser: a category rail on the left and a card
 * grid on the right, every card backed by `FEATURES`. "Show me" and "Show me
 * all in <category>" close this dialog first, then hand off to Spotlight, so
 * the highlighted element is never stacked under the overlay; "Learn more"
 * closes and opens the guide viewer the same way.
 */
export function DiscoverDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const { isTried, spotlight, openGuide } = useDiscovery()
  const [category, setCategory] = useState<FeatureCategory>(CATEGORY_ORDER[0])

  // Selection resets to the first category every time the dialog opens.
  useEffect(() => {
    if (open) setCategory(CATEGORY_ORDER[0])
  }, [open])

  useEscapeKey(open, onClose)

  if (!open) return null

  const triedCount = FEATURES.filter((f) => isTried(f.id)).length
  const total = FEATURES.length
  const progressPct = total === 0 ? 0 : Math.round((triedCount / total) * 100)

  const categoryFeatures: readonly Feature[] = FEATURES.filter((f) => f.category === category)

  const showMe = (featureId: string): void => {
    onClose()
    spotlight.show({ featureId })
  }

  const showAllInCategory = (): void => {
    const [first, ...rest] = categoryFeatures
    if (!first) return
    onClose()
    spotlight.show({ featureId: first.id, queue: rest.map((f) => f.id) })
  }

  const learnMore = (guide: string): void => {
    onClose()
    openGuide(guide)
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog discover"
        role="dialog"
        aria-modal="true"
        aria-label="Discover features"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="discover__header">
          <div className="discover__titles">
            <div className="discover__title">Discover features</div>
          </div>
          <span className="discover__progress">
            {triedCount} of {total} tried
          </span>
          <div className="discover__bar" aria-hidden="true">
            <div className="discover__bar-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <button className="discover__close" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="discover__body">
          <div className="discover__rail">
            {CATEGORY_ORDER.map((cat) => {
              const feats = FEATURES.filter((f) => f.category === cat)
              const catTried = feats.filter((f) => isTried(f.id)).length
              return (
                <button
                  key={cat}
                  type="button"
                  className={`discover__rail-item${cat === category ? ' is-active' : ''}`}
                  onClick={() => setCategory(cat)}
                >
                  {FEATURE_CATEGORY_LABELS[cat]}
                  <span className="discover__rail-count">
                    {feats.length} · {catTried} tried
                  </span>
                </button>
              )
            })}
          </div>

          <div className="discover__main">
            <div className="discover__toolbar">
              <span className="discover__toolbar-label">{FEATURE_CATEGORY_LABELS[category]}</span>
              <button type="button" className="discover__btn" onClick={showAllInCategory}>
                Show me all in {FEATURE_CATEGORY_LABELS[category]}
              </button>
            </div>

            <div className="discover__cards">
              {categoryFeatures.map((feature) => {
                const tried = isTried(feature.id)
                return (
                  <div key={feature.id} className={`discover__card${tried ? ' is-tried' : ''}`}>
                    <div className="discover__card-title">
                      {feature.title}
                      {feature.shortcut && <kbd>{feature.shortcut}</kbd>}
                      {tried && (
                        <span className="discover__tick" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </div>
                    <div className="discover__card-desc">{feature.description}</div>
                    <div className="discover__card-loc">{feature.location}</div>
                    <div className="discover__card-actions">
                      <button
                        type="button"
                        className="discover__btn discover__btn--primary"
                        onClick={() => showMe(feature.id)}
                      >
                        Show me
                      </button>
                      <button
                        type="button"
                        className="discover__btn"
                        onClick={() => learnMore(feature.guide)}
                      >
                        Learn more
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
