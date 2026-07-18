import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { pickDefaultLink } from '../../../shared/knowledge'
import type { KnowledgeRecord } from '../../../shared/knowledge'
import { CloseIcon, SparkleIcon } from './icons'

interface SaveExemplarDialogProps {
  /** Connection + database the exemplar is keyed to. */
  connId: string
  database: string
  /** "connName / database" shown as the dialog subtitle. */
  targetLabel: string
  /** SQL captured from the editor or a chat code block. */
  initialSql: string
  /** Optional prefill for the question (e.g. the user's last chat prompt). */
  initialQuestion?: string
  onClose: () => void
  onSaved?: (record: KnowledgeRecord) => void
}

/**
 * Small dialog to capture a question→SQL exemplar (Phase 5). Reference
 * extraction runs in the main process on save, so this only collects the
 * question and (editable) SQL. Follows the house dialog pattern.
 */
export function SaveExemplarDialog({
  connId,
  database,
  targetLabel,
  initialSql,
  initialQuestion,
  onClose,
  onSaved
}: SaveExemplarDialogProps): ReactElement {
  const [question, setQuestion] = useState(initialQuestion ?? '')
  const [sql, setSql] = useState(initialSql)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const save = useCallback(async () => {
    if (saving) return
    const q = question.trim()
    const s = sql.trim()
    if (!q) {
      setError('A question is required.')
      return
    }
    if (!s) {
      setError('The SQL is empty.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      // The exemplar lands in the target's default base. A null kbId lets the
      // main process create and link one (named after the database, scoped to
      // the schema the SQL references — links are schema-scoped, and only the
      // main process sees the extracted references). Resolved on save so an
      // unused, cancelled dialog never mints an empty base.
      const linked = (await window.dbDesk.knowledge.listLinks()).filter(
        (l) => l.connId === connId && l.database === database
      )
      const kbId = pickDefaultLink(linked)?.kbId ?? null
      const saved = await window.dbDesk.knowledge.saveExemplar(kbId, connId, database, q, s)
      onSaved?.(saved)
      onClose()
    } catch (err) {
      setError(`Failed to save exemplar: ${err instanceof Error ? err.message : String(err)}`)
      setSaving(false)
    }
  }, [saving, question, sql, connId, database, onSaved, onClose])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Save as exemplar">
        <div className="dialog__header">
          <span className="dialog__icon">
            <SparkleIcon size={18} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Save as Exemplar</div>
            <div className="dialog__subtitle">{targetLabel}</div>
          </div>
          <button className="dialog__close" onClick={onClose} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body">
          <label className="field-label" htmlFor="exemplar-question">
            QUESTION
          </label>
          <input
            id="exemplar-question"
            className="text-input"
            placeholder="What business question does this query answer?"
            autoFocus
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div style={{ marginTop: 11 }}>
            <label className="field-label" htmlFor="exemplar-sql">
              SQL
            </label>
            <textarea
              id="exemplar-sql"
              className="text-input text-input--mono"
              rows={8}
              value={sql}
              onChange={(event) => setSql(event.target.value)}
            />
            <div className="url-hint">
              Saved as a reusable example for the AI agent. Table and column references are
              extracted automatically so it shows up under their usages.
            </div>
          </div>
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void save()}
            disabled={saving}
            type="button"
          >
            {saving && <span className="spinner" />}
            {saving ? 'Saving…' : 'Save Exemplar'}
          </button>
        </div>
      </div>
    </div>
  )
}
