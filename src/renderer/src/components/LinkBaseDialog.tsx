import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { KnowledgeBaseSummary } from '../../../shared/knowledge'
import { BookIcon, CloseIcon } from './icons'

interface LinkBaseDialogProps {
  /** "connName / database" shown as the dialog subtitle. */
  targetLabel: string
  /** Every existing base; a base may gain links to several schemas. */
  bases: KnowledgeBaseSummary[]
  /** Introspected schema names of the target database; empty falls back to a
   * free-text schema field (introspection not loaded yet). */
  schemaOptions: string[]
  /** Called with the chosen base and the required schema scope. */
  onLink: (kbId: string, schema: string) => Promise<void>
  onClose: () => void
}

/**
 * Links an existing knowledge base to one schema of the current (connection,
 * database) target — links are always schema-scoped. Follows the house
 * dialog pattern.
 */
export function LinkBaseDialog({
  targetLabel,
  bases,
  schemaOptions,
  onLink,
  onClose
}: LinkBaseDialogProps): ReactElement {
  const [kbId, setKbId] = useState(bases[0]?.id ?? '')
  const [schema, setSchema] = useState(schemaOptions[0] ?? '')
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
    const trimmedSchema = schema.trim()
    if (!trimmedSchema) {
      setError('A schema is required — knowledge bases link at the schema level.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onLink(kbId, trimmedSchema)
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
            <div className="url-hint">No knowledge bases exist yet — create one first.</div>
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
              SCHEMA
            </label>
            {schemaOptions.length > 0 ? (
              <select
                id="link-schema"
                className="text-input"
                value={schema}
                onChange={(event) => setSchema(event.target.value)}
              >
                {schemaOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="link-schema"
                className="text-input"
                placeholder="e.g. contract_db"
                value={schema}
                onChange={(event) => setSchema(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
            )}
            <div className="url-hint">
              Knowledge bases link at the schema level: the base applies to this one schema. Link
              again to attach it to another schema.
            </div>
          </div>
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button" disabled={saving}>
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
