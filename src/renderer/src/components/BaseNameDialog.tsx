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
  /**
   * When provided, the dialog also collects the schema the new base links to
   * (links are schema-scoped, so creating requires one): a picker over these
   * introspected names, or free text while introspection hasn't loaded. Omit
   * for rename, where no link is made.
   */
  schemaOptions?: string[]
  /** Called with the trimmed name (and schema when collected); the caller
   * performs the create/rename. */
  onSubmit: (name: string, schema?: string) => Promise<void>
  onClose: () => void
}

/**
 * Names a knowledge base — shared by the "New base…" and "Rename base…"
 * actions in the knowledge panel and the schema tree's "New knowledge
 * base…". Follows the house dialog pattern.
 */
export function BaseNameDialog({
  title,
  subtitle,
  initialName,
  submitLabel,
  schemaOptions,
  onSubmit,
  onClose
}: BaseNameDialogProps): ReactElement {
  const [name, setName] = useState(initialName ?? '')
  const [schema, setSchema] = useState(schemaOptions?.[0] ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const withSchema = schemaOptions !== undefined

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
    const trimmedSchema = schema.trim()
    if (withSchema && !trimmedSchema) {
      setError('A schema is required — knowledge bases link at the schema level.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSubmit(trimmed, withSchema ? trimmedSchema : undefined)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }, [saving, name, schema, withSchema, onSubmit, onClose])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
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
          {withSchema && (
            <div style={{ marginTop: 11 }}>
              <label className="field-label" htmlFor="base-schema">
                SCHEMA
              </label>
              {schemaOptions.length > 0 ? (
                <select
                  id="base-schema"
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
                  id="base-schema"
                  className="text-input"
                  placeholder="e.g. public"
                  value={schema}
                  onChange={(event) => setSchema(event.target.value)}
                />
              )}
              <div className="url-hint">
                Knowledge bases link at the schema level; the new base is linked to this schema.
              </div>
            </div>
          )}
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
