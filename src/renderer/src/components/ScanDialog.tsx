import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { BackgroundScanKind } from '../../../shared/backgroundAgents'
import { SearchIcon, CloseIcon } from './icons'

interface ScanDialogProps {
  /** "connName / database" shown as the dialog subtitle. */
  targetLabel: string
  /** Basename of the attached repo root, shown in the hint. */
  repoName: string | null
  /** Preselected scope. 'full' from "Scan…"; 'targeted' from a targeted entry point. */
  initialScope: BackgroundScanKind
  /** Why a foreground run cannot happen now (agent busy), or null. */
  foregroundBlockedReason: string | null
  onClose: () => void
  /** The caller enqueues the background job or sends the foreground turn. */
  onStart: (opts: { kind: BackgroundScanKind; focus: string; background: boolean }) => void
}

/**
 * The knowledge dialog's scan launcher: scope (whole codebase or a focused
 * re-scan), the focus instructions for targeted runs, and whether the scan
 * runs as a background agent or as a normal chat turn. Follows the house
 * dialog pattern.
 */
export function ScanDialog({
  targetLabel,
  repoName,
  initialScope,
  foregroundBlockedReason,
  onClose,
  onStart
}: ScanDialogProps): ReactElement {
  const [kind, setKind] = useState<BackgroundScanKind>(initialScope)
  const [focus, setFocus] = useState('')
  const [background, setBackground] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Only a foreground run competes with the chat for the session.
  const blocked = !background ? foregroundBlockedReason : null

  const start = useCallback(() => {
    if (blocked) return
    const trimmed = focus.trim()
    if (kind === 'targeted' && !trimmed) {
      setError('Describe what the scan should focus on.')
      return
    }
    onStart({ kind, focus: trimmed, background })
  }, [blocked, kind, focus, background, onStart])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Codebase scan">
        <div className="dialog__header">
          <span className="dialog__icon">
            <SearchIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">
              {kind === 'full' ? 'Scan Codebase' : 'Targeted Scan'}
            </div>
            <div className="dialog__subtitle">{targetLabel}</div>
          </div>
          <button className="dialog__close" onClick={onClose} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body">
          <div className="dtabs dtabs--type" role="radiogroup" aria-label="Scan scope">
            <button
              type="button"
              role="radio"
              aria-checked={kind === 'full'}
              className={`dtab${kind === 'full' ? ' is-active' : ''}`}
              onClick={() => setKind('full')}
            >
              Full scan
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === 'targeted'}
              className={`dtab${kind === 'targeted' ? ' is-active' : ''}`}
              onClick={() => setKind('targeted')}
            >
              Targeted scan
            </button>
          </div>

          {kind === 'targeted' ? (
            <>
              <label className="field-label" htmlFor="targeted-scan-focus">
                FOCUS
              </label>
              <textarea
                id="targeted-scan-focus"
                className="text-input"
                rows={4}
                autoFocus
                placeholder={
                  'e.g. Re-read the billing service under app/services/billing and capture how proration and refunds affect the invoices table.'
                }
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    start()
                  }
                }}
              />
              <div className="url-hint">
                The agent re-scans only the parts of{' '}
                {repoName ? `"${repoName}"` : 'the attached codebase'} relevant to this focus and
                adds or updates knowledge records, instead of surveying the whole repo again.
              </div>
            </>
          ) : (
            <div className="url-hint">
              The agent surveys the whole attached codebase and records what it teaches about this
              database.
            </div>
          )}

          <label className="save-pwd">
            <input
              type="checkbox"
              checked={background}
              onChange={() => setBackground((on) => !on)}
            />
            Run in background
          </label>
          <div className="url-hint">
            The scan runs as a background agent; watch it from the status bar.
          </div>
          {blocked && <div className="url-hint">{blocked}</div>}
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={start}
            type="button"
            disabled={!!blocked}
            title={blocked ?? undefined}
          >
            Start Scan
          </button>
        </div>
      </div>
    </div>
  )
}
