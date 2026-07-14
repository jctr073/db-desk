import { useRef, useState } from 'react'
import type { ReactElement } from 'react'

import type { DatabaseIntrospection } from '../../../shared/db'
import type {
  ColumnRef,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeRecordInput
} from '../../../shared/knowledge'
import { CloseIcon, PlusThinIcon } from '../components/icons'
import { SqlCode } from '../components/SqlCode'
import { KIND_LABELS } from './format'
import { RefChipEditor, RefField } from './RefInput'

/**
 * Stable identity for dynamic form rows (polymorphic targets, glossary
 * mappings). Index keys would rebind RefField's internal text to the wrong
 * row when a row above it is removed.
 */
let rowSeq = 0
function nextRowKey(): number {
  return ++rowSeq
}

/**
 * One flat draft covering every kind's fields; only the active kind's slice
 * is read on save. Column refs are nullable while the user is still typing.
 */
interface Draft {
  // annotation
  target: ColumnRef | null
  text: string
  // relationship
  relType: 'standard' | 'polymorphic'
  from: ColumnRef | null
  to: ColumnRef | null
  discriminator: ColumnRef | null
  targetRows: Array<{ key: number; value: string; target: ColumnRef | null }>
  relNotes: string
  // glossary
  term: string
  synonyms: string
  definition: string
  mappings: Array<{ key: number; ref: ColumnRef | null; caveat: string }>
  // exemplar
  question: string
  sql: string
  // exemplar + note
  references: ColumnRef[]
  // note
  title: string
  body: string
}

function initDraft(
  record: KnowledgeRecord | null,
  prefillTarget: ColumnRef | null
): Draft {
  const draft: Draft = {
    target: prefillTarget,
    text: '',
    relType: 'standard',
    from: null,
    to: null,
    discriminator: null,
    targetRows: [{ key: nextRowKey(), value: '', target: null }],
    relNotes: '',
    term: '',
    synonyms: '',
    definition: '',
    mappings: [{ key: nextRowKey(), ref: prefillTarget, caveat: '' }],
    question: '',
    sql: '',
    references: prefillTarget ? [prefillTarget] : [],
    title: '',
    body: ''
  }
  if (!record) return draft
  switch (record.kind) {
    case 'annotation':
      return { ...draft, target: record.target, text: record.text }
    case 'relationship':
      return {
        ...draft,
        relType: record.relType,
        from: record.from,
        to: record.to ?? null,
        discriminator: record.discriminator ?? null,
        targetRows: Object.entries(record.targets ?? {}).map(([value, target]) => ({
          key: nextRowKey(),
          value,
          target
        })),
        relNotes: record.notes ?? ''
      }
    case 'glossary':
      return {
        ...draft,
        term: record.term,
        synonyms: (record.synonyms ?? []).join(', '),
        definition: record.definition ?? '',
        mappings: (record.mappings ?? []).map((m) => ({
          key: nextRowKey(),
          ref: m.ref,
          caveat: m.caveat ?? ''
        }))
      }
    case 'exemplar':
      return {
        ...draft,
        question: record.question,
        sql: record.sql,
        references: record.references ?? []
      }
    case 'note':
      return {
        ...draft,
        title: record.title,
        body: record.body,
        references: record.references ?? []
      }
    default:
      return draft
  }
}

type BuildResult = { input: KnowledgeRecordInput } | { error: string }

/** Validate the draft and assemble the wire payload for its kind. */
function buildInput(
  kind: KnowledgeKind,
  draft: Draft,
  record: KnowledgeRecord | null
): BuildResult {
  // The store owns id/timestamps; source/confidence/provenance survive edits.
  const envelope = record
    ? {
        id: record.id,
        source: record.source,
        ...(record.confidence ? { confidence: record.confidence } : {}),
        ...(record.provenance ? { provenance: record.provenance } : {})
      }
    : { source: 'human' as const }

  switch (kind) {
    case 'annotation': {
      if (!draft.target) return { error: 'A target table or column is required.' }
      if (!draft.text.trim()) return { error: 'Annotation text is required.' }
      return {
        input: { ...envelope, kind, target: draft.target, text: draft.text.trim() }
      }
    }
    case 'relationship': {
      if (!draft.from?.column) {
        return { error: 'The "from" side must be a column (schema.table.column).' }
      }
      const notes = draft.relNotes.trim()
      if (draft.relType === 'standard') {
        if (!draft.to) return { error: 'A join target is required.' }
        return {
          input: {
            ...envelope,
            kind,
            relType: 'standard',
            from: draft.from,
            to: draft.to,
            ...(notes ? { notes } : {})
          }
        }
      }
      if (!draft.discriminator?.column) {
        return { error: 'A discriminator column is required for a polymorphic join.' }
      }
      const targets: Record<string, ColumnRef> = {}
      for (const row of draft.targetRows) {
        if (!row.value.trim() && !row.target) continue // ignore blank rows
        if (!row.value.trim()) return { error: 'Every target row needs a discriminator value.' }
        if (!row.target) return { error: `Target for '${row.value.trim()}' is incomplete.` }
        const value = row.value.trim()
        // Folding into a Record would silently drop earlier rows (last wins).
        if (Object.prototype.hasOwnProperty.call(targets, value)) {
          return { error: `Duplicate discriminator value '${value}'.` }
        }
        targets[value] = row.target
      }
      if (Object.keys(targets).length === 0) {
        return { error: 'At least one discriminator value → target row is required.' }
      }
      return {
        input: {
          ...envelope,
          kind,
          relType: 'polymorphic',
          from: draft.from,
          discriminator: draft.discriminator,
          targets,
          ...(notes ? { notes } : {})
        }
      }
    }
    case 'glossary': {
      if (!draft.term.trim()) return { error: 'A term is required.' }
      const mappings: Array<{ ref: ColumnRef; caveat?: string }> = []
      for (const row of draft.mappings) {
        if (!row.ref) {
          if (row.caveat.trim()) return { error: 'Every mapping needs a column ref.' }
          continue // ignore blank rows
        }
        mappings.push({
          ref: row.ref,
          ...(row.caveat.trim() ? { caveat: row.caveat.trim() } : {})
        })
      }
      const definition = draft.definition.trim()
      return {
        input: {
          ...envelope,
          kind,
          term: draft.term.trim(),
          synonyms: draft.synonyms
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...(definition ? { definition } : {}),
          mappings
        }
      }
    }
    case 'exemplar': {
      if (!draft.question.trim()) return { error: 'A question is required.' }
      if (!draft.sql.trim()) return { error: 'The SQL is required.' }
      return {
        input: {
          ...envelope,
          kind,
          question: draft.question.trim(),
          sql: draft.sql,
          references: draft.references
        }
      }
    }
    case 'note': {
      if (!draft.title.trim()) return { error: 'A title is required.' }
      return {
        input: {
          ...envelope,
          kind,
          title: draft.title.trim(),
          body: draft.body,
          references: draft.references
        }
      }
    }
  }
}

interface RecordEditorProps {
  /** Existing record being edited, or null for a new one. */
  record: KnowledgeRecord | null
  kind: KnowledgeKind
  /** ColumnRef to prefill (from "Add annotation…" in the schema tree). */
  prefillTarget: ColumnRef | null
  intro?: DatabaseIntrospection
  validKeys: Set<string> | null
  onSave: (input: KnowledgeRecordInput) => void
  onDelete: (() => void) | null
  onBack: () => void
}

export function RecordEditor({
  record,
  kind,
  prefillTarget,
  intro,
  validKeys,
  onSave,
  onDelete,
  onBack
}: RecordEditorProps): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => initDraft(record, prefillTarget))
  const [error, setError] = useState<string | null>(null)
  const sqlHighlightRef = useRef<HTMLPreElement | null>(null)

  const patch = (changes: Partial<Draft>): void => {
    setError(null)
    setDraft((prev) => ({ ...prev, ...changes }))
  }

  const save = (): void => {
    const result = buildInput(kind, draft, record)
    if ('error' in result) {
      setError(result.error)
      return
    }
    onSave(result.input)
  }

  const refProps = { intro, validKeys }

  return (
    <div className="kn-editor">
      <div className="kn-editor__head">
        <button type="button" className="kn-back" onClick={onBack}>
          ‹ Back
        </button>
        <span className="kn-editor__title">
          {record ? 'Edit' : 'New'} {KIND_LABELS[kind].toLowerCase()}
        </span>
        <div className="kn-editor__spacer" />
        {record && (
          <>
            <span className={`kn-badge kn-badge--${record.source}`}>{record.source}</span>
            {record.confidence && (
              <span className="kn-badge kn-badge--conf" title="Agent confidence">
                {record.confidence}
              </span>
            )}
          </>
        )}
      </div>
      <div className="kn-editor__body">
        {record?.provenance && (
          <div className="kn-provenance" title="Where the agent derived this from">
            From: {record.provenance}
          </div>
        )}

        {kind === 'annotation' && (
          <>
            <div className="kn-field">
              <label className="field-label">Target (table or column)</label>
              <RefField
                {...refProps}
                value={draft.target}
                onChange={(target) => patch({ target })}
                placeholder="schema.table or schema.table.column"
              />
            </div>
            <div className="kn-field">
              <label className="field-label">Text (markdown)</label>
              <textarea
                className="text-input kn-textarea"
                rows={5}
                value={draft.text}
                placeholder="Description, caveats, gotchas…"
                onChange={(e) => patch({ text: e.target.value })}
              />
            </div>
          </>
        )}

        {kind === 'relationship' && (
          <>
            <div className="kn-field">
              <label className="field-label">Join type</label>
              <div className="kn-segs">
                {(['standard', 'polymorphic'] as const).map((rt) => (
                  <button
                    key={rt}
                    type="button"
                    className={`kn-seg${draft.relType === rt ? ' is-active' : ''}`}
                    onClick={() => patch({ relType: rt })}
                  >
                    {rt}
                  </button>
                ))}
              </div>
            </div>
            <div className="kn-field">
              <label className="field-label">From column</label>
              <RefField
                {...refProps}
                requireColumn
                value={draft.from}
                onChange={(from) => patch({ from })}
              />
            </div>
            {draft.relType === 'standard' ? (
              <div className="kn-field">
                <label className="field-label">Joins to</label>
                <RefField
                  {...refProps}
                  value={draft.to}
                  onChange={(to) => patch({ to })}
                />
              </div>
            ) : (
              <>
                <div className="kn-field">
                  <label className="field-label">Discriminator column</label>
                  <RefField
                    {...refProps}
                    requireColumn
                    value={draft.discriminator}
                    onChange={(discriminator) => patch({ discriminator })}
                  />
                </div>
                <div className="kn-field">
                  <label className="field-label">Targets by discriminator value</label>
                  {draft.targetRows.map((row) => (
                    <div key={row.key} className="kn-row">
                      <input
                        className="text-input text-input--mono kn-row__value"
                        value={row.value}
                        placeholder="value"
                        spellCheck={false}
                        onChange={(e) =>
                          patch({
                            targetRows: draft.targetRows.map((r) =>
                              r.key === row.key ? { ...r, value: e.target.value } : r
                            )
                          })
                        }
                      />
                      <span className="kn-row__arrow">→</span>
                      <div className="kn-row__ref">
                        <RefField
                          {...refProps}
                          value={row.target}
                          onChange={(target) =>
                            patch({
                              targetRows: draft.targetRows.map((r) =>
                                r.key === row.key ? { ...r, target } : r
                              )
                            })
                          }
                        />
                      </div>
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        title="Remove row"
                        onClick={() =>
                          patch({
                            targetRows: draft.targetRows.filter((r) => r.key !== row.key)
                          })
                        }
                      >
                        <CloseIcon size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="kn-add-row"
                    onClick={() =>
                      patch({
                        targetRows: [
                          ...draft.targetRows,
                          { key: nextRowKey(), value: '', target: null }
                        ]
                      })
                    }
                  >
                    <PlusThinIcon size={11} />
                    Add target
                  </button>
                </div>
              </>
            )}
            <div className="kn-field">
              <label className="field-label">Notes</label>
              <textarea
                className="text-input kn-textarea"
                rows={3}
                value={draft.relNotes}
                placeholder="Join caveats, cardinality, filters…"
                onChange={(e) => patch({ relNotes: e.target.value })}
              />
            </div>
          </>
        )}

        {kind === 'glossary' && (
          <>
            <div className="kn-field">
              <label className="field-label">Term</label>
              <input
                className="text-input"
                value={draft.term}
                placeholder="e.g. Net revenue"
                onChange={(e) => patch({ term: e.target.value })}
              />
            </div>
            <div className="kn-field">
              <label className="field-label">Synonyms (comma-separated)</label>
              <input
                className="text-input"
                value={draft.synonyms}
                placeholder="e.g. revenue, sales, turnover"
                onChange={(e) => patch({ synonyms: e.target.value })}
              />
            </div>
            <div className="kn-field">
              <label className="field-label">Definition</label>
              <textarea
                className="text-input kn-textarea"
                rows={3}
                value={draft.definition}
                onChange={(e) => patch({ definition: e.target.value })}
              />
            </div>
            <div className="kn-field">
              <label className="field-label">Column mappings</label>
              {draft.mappings.map((row) => (
                <div key={row.key} className="kn-row">
                  <div className="kn-row__ref">
                    <RefField
                      {...refProps}
                      value={row.ref}
                      onChange={(ref) =>
                        patch({
                          mappings: draft.mappings.map((r) =>
                            r.key === row.key ? { ...r, ref } : r
                          )
                        })
                      }
                    />
                  </div>
                  <input
                    className="text-input kn-row__caveat"
                    value={row.caveat}
                    placeholder="Caveat (optional)"
                    onChange={(e) =>
                      patch({
                        mappings: draft.mappings.map((r) =>
                          r.key === row.key ? { ...r, caveat: e.target.value } : r
                        )
                      })
                    }
                  />
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    title="Remove mapping"
                    onClick={() =>
                      patch({ mappings: draft.mappings.filter((r) => r.key !== row.key) })
                    }
                  >
                    <CloseIcon size={11} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="kn-add-row"
                onClick={() =>
                  patch({
                    mappings: [
                      ...draft.mappings,
                      { key: nextRowKey(), ref: null, caveat: '' }
                    ]
                  })
                }
              >
                <PlusThinIcon size={11} />
                Add mapping
              </button>
            </div>
          </>
        )}

        {kind === 'exemplar' && (
          <>
            <div className="kn-field">
              <label className="field-label">Question</label>
              <input
                className="text-input"
                value={draft.question}
                placeholder="What business question does this answer?"
                onChange={(e) => patch({ question: e.target.value })}
              />
            </div>
            <div className="kn-field">
              <label className="field-label" htmlFor="knowledge-exemplar-sql">
                SQL
              </label>
              <div className="kn-sql-input">
                <pre
                  ref={sqlHighlightRef}
                  className="kn-sql-input__highlight"
                  aria-hidden="true"
                >
                  <SqlCode sql={draft.sql} />
                  {'\n'}
                </pre>
                <textarea
                  id="knowledge-exemplar-sql"
                  className="kn-sql-input__control"
                  rows={7}
                  spellCheck={false}
                  value={draft.sql}
                  onChange={(e) => patch({ sql: e.target.value })}
                  onScroll={(e) => {
                    if (!sqlHighlightRef.current) return
                    sqlHighlightRef.current.scrollTop =
                      e.currentTarget.scrollTop
                    sqlHighlightRef.current.scrollLeft =
                      e.currentTarget.scrollLeft
                  }}
                />
              </div>
            </div>
            <div className="kn-field">
              <label className="field-label">References</label>
              <RefChipEditor
                {...refProps}
                refs={draft.references}
                onChange={(references) => patch({ references })}
              />
            </div>
          </>
        )}

        {kind === 'note' && (
          <>
            <div className="kn-field">
              <label className="field-label">Title</label>
              <input
                className="text-input"
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </div>
            <div className="kn-field">
              <label className="field-label">Body (markdown)</label>
              <textarea
                className="text-input kn-textarea"
                rows={7}
                value={draft.body}
                onChange={(e) => patch({ body: e.target.value })}
              />
            </div>
            <div className="kn-field">
              <label className="field-label">
                References (columns mentioned in the note)
              </label>
              <RefChipEditor
                {...refProps}
                refs={draft.references}
                onChange={(references) => patch({ references })}
              />
            </div>
          </>
        )}
      </div>
      <div className="kn-editor__foot">
        {onDelete && (
          <button type="button" className="kn-delete" onClick={onDelete}>
            Delete
          </button>
        )}
        {error && <span className="kn-editor__error">{error}</span>}
        <div className="kn-editor__spacer" />
        <button type="button" className="btn-cancel" onClick={onBack}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}
