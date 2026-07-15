import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { BookIcon, CloseIcon } from './icons'

interface BaseNameDialogProps {
  /** Dialog title, e.g. "New Knowledge Base" or "Rename Knowledge Base". */
  title: string
  /** "connName / database" (or the base's current name) shown as subtitle. */
  subtitle: string
  /** Prefill for the name field; empty when creating. */
  initialName?: string
  submitLabel: string
  /** Called with the trimmed name; the caller performs the create/rename. */
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}

/**
 * Names a knowledge base — shared by the "New base…" and "Rename base…"
 * actions in the knowledge panel. Follows the house dialog pattern.
 */
export function BaseNameDialog({
  title,
  subtitle,
  initialName,
  submitLabel,
  onSubmit,
  onClose
}: BaseNameDialogProps): ReactElement {
  const [name, setName] = useState(initialName ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const submit = useCallback(async () => {
    if (saving) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('A name is required.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSubmit(trimmed)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }, [saving, name, onSubmit, onClose])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <BookIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">{title}</div>
            <div className="dialog__subtitle">{subtitle}</div>
          </div>
          <button
            className="dialog__close"
            onClick={onClose}
            title="Close"
            type="button"
            disabled={saving}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body">
          <label className="field-label" htmlFor="base-name">
            NAME
          </label>
          <input
            id="base-name"
            className="text-input"
            placeholder="e.g. Billing service"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button
            className="btn-cancel"
            onClick={onClose}
            type="button"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={saving}
            type="button"
          >
            {saving && <span className="spinner" />}
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
