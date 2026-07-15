import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { KnowledgeBaseSummary } from '../../../shared/knowledge'
import { BookIcon, CloseIcon } from './icons'

interface LinkBaseDialogProps {
  /** "connName / database" shown as the dialog subtitle. */
  targetLabel: string
  /** Bases the target is not already linked to; empty disables the picker. */
  bases: KnowledgeBaseSummary[]
  /** Called with the chosen base and an optional schema scope. */
  onLink: (kbId: string, schema: string | undefined) => Promise<void>
  onClose: () => void
}

/**
 * Links an existing knowledge base to the current (connection, database)
 * target, optionally scoping it to a single schema (multi-schema engines such
 * as Databricks). Follows the house dialog pattern.
 */
export function LinkBaseDialog({
  targetLabel,
  bases,
  onLink,
  onClose
}: LinkBaseDialogProps): ReactElement {
  const [kbId, setKbId] = useState(bases[0]?.id ?? '')
  const [schema, setSchema] = useState('')
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
    if (!kbId) {
      setError('Choose a knowledge base to link.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onLink(kbId, schema.trim() || undefined)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }, [saving, kbId, schema, onLink, onClose])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Link existing knowledge base"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <BookIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Link Existing Base</div>
            <div className="dialog__subtitle">{targetLabel}</div>
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
          <label className="field-label" htmlFor="link-base">
            KNOWLEDGE BASE
          </label>
          {bases.length === 0 ? (
            <div className="url-hint">
              Every existing base is already linked to this database.
            </div>
          ) : (
            <select
              id="link-base"
              className="text-input"
              value={kbId}
              onChange={(event) => setKbId(event.target.value)}
            >
              {bases.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.name} ({base.recordCount} record
                  {base.recordCount === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          )}
          <div style={{ marginTop: 11 }}>
            <label className="field-label" htmlFor="link-schema">
              SCHEMA (OPTIONAL)
            </label>
            <input
              id="link-schema"
              className="text-input"
              placeholder="Scope this base to one schema, e.g. contract_db"
              value={schema}
              onChange={(event) => setSchema(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="url-hint">
              Leave blank to apply the base to the whole database. A schema
              scopes it to that one schema (for multi-schema engines).
            </div>
          </div>
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
            disabled={saving || bases.length === 0}
            type="button"
          >
            {saving && <span className="spinner" />}
            Link Base
          </button>
        </div>
      </div>
    </div>
  )
}
