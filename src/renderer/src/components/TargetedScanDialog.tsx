import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { SearchIcon, CloseIcon } from './icons'

interface TargetedScanDialogProps {
  /** "connName / database" shown as the dialog subtitle. */
  targetLabel: string
  /** Basename of the attached repo root, shown in the hint. */
  repoName: string | null
  onClose: () => void
  /** Called with the trimmed focus text; the caller sends the scan turn. */
  onScan: (focus: string) => void
}

/**
 * Small dialog for the knowledge panel's "Targeted scan…" action: collects
 * free-form focus instructions for a follow-up codebase scan (which part of
 * the repo to re-read, what details to add). Follows the house dialog
 * pattern.
 */
export function TargetedScanDialog({
  targetLabel,
  repoName,
  onClose,
  onScan
}: TargetedScanDialogProps): ReactElement {
  const [focus, setFocus] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const start = useCallback(() => {
    const trimmed = focus.trim()
    if (!trimmed) {
      setError('Describe what the scan should focus on.')
      return
    }
    onScan(trimmed)
  }, [focus, onScan])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Targeted codebase scan"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <SearchIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Targeted Scan</div>
            <div className="dialog__subtitle">{targetLabel}</div>
          </div>
          <button
            className="dialog__close"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body">
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
            {repoName ? `"${repoName}"` : 'the attached codebase'} relevant to
            this focus and adds or updates knowledge records, instead of
            surveying the whole repo again.
          </div>
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn-primary" onClick={start} type="button">
            Start Scan
          </button>
        </div>
      </div>
    </div>
  )
}
