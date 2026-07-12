import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import type { DatabaseIntrospection } from '../../../shared/db'
import { normalizeColumnKey } from '../../../shared/knowledge'
import type { ColumnRef } from '../../../shared/knowledge'
import { CloseIcon } from '../components/icons'
import { formatRef, parseRefText, refSuggestions } from './format'

interface RefSuggestInputProps {
  text: string
  onText: (text: string) => void
  /** A suggestion was clicked (always a fully valid qualified name). */
  onPick: (text: string) => void
  /** Enter pressed with the current text. */
  onCommit?: () => void
  intro?: DatabaseIntrospection
  placeholder: string
}

/** Text input with a schema-object suggestion dropdown underneath. */
function RefSuggestInput({
  text,
  onText,
  onPick,
  onCommit,
  intro,
  placeholder
}: RefSuggestInputProps): ReactElement {
  const [focused, setFocused] = useState(false)
  const suggestions = useMemo(
    () => (focused ? refSuggestions(intro, text, 40) : []),
    [focused, intro, text]
  )
  const open = focused && suggestions.length > 0 && suggestions[0] !== text.trim()

  return (
    <div className="ref-field">
      <input
        className="text-input text-input--mono ref-field__input"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onCommit) {
            e.preventDefault()
            onCommit()
          }
        }}
      />
      {open && (
        <div className="ref-suggest">
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              className="ref-suggest__item"
              // mousedown so the pick lands before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(name)
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface RefFieldProps {
  value: ColumnRef | null
  onChange: (ref: ColumnRef | null) => void
  intro?: DatabaseIntrospection
  /** Valid normalized keys from the introspection (null while loading). */
  validKeys: Set<string> | null
  /** Require a column part (e.g. a relationship's `from` side). */
  requireColumn?: boolean
  placeholder?: string
}

/**
 * Single ColumnRef editor: free text "schema.table[.column]" with suggestions
 * from the live introspection, a shape hint while the text doesn't parse, and
 * a dangling-ref warning when the ref is missing from the current schema
 * (warn only — dangling refs are always kept).
 */
export function RefField({
  value,
  onChange,
  intro,
  validKeys,
  requireColumn = false,
  placeholder
}: RefFieldProps): ReactElement {
  const [text, setText] = useState(() => (value ? formatRef(value) : ''))

  const apply = (next: string): void => {
    setText(next)
    onChange(parseRefText(next))
  }

  const parsed = parseRefText(text)
  let hint: { text: string; warn: boolean } | null = null
  if (text.trim() && !parsed) {
    hint = { text: 'Use schema.table or schema.table.column', warn: false }
  } else if (parsed && requireColumn && !parsed.column) {
    hint = { text: 'A column is required here (schema.table.column)', warn: false }
  } else if (parsed && validKeys && !validKeys.has(normalizeColumnKey(parsed))) {
    hint = { text: 'Not found in the current schema (kept as-is)', warn: true }
  }

  return (
    <div className="ref-wrap">
      <RefSuggestInput
        text={text}
        onText={apply}
        onPick={apply}
        intro={intro}
        placeholder={placeholder ?? 'schema.table.column'}
      />
      {hint && (
        <div className={`ref-hint${hint.warn ? ' ref-hint--warn' : ''}`}>
          {hint.text}
        </div>
      )}
    </div>
  )
}

interface RefChipEditorProps {
  refs: ColumnRef[]
  onChange: (refs: ColumnRef[]) => void
  intro?: DatabaseIntrospection
  validKeys: Set<string> | null
}

/** Chip picker for a `references: ColumnRef[]` field (notes, exemplars). */
export function RefChipEditor({
  refs,
  onChange,
  intro,
  validKeys
}: RefChipEditorProps): ReactElement {
  const [text, setText] = useState('')

  const add = (raw: string): void => {
    const ref = parseRefText(raw)
    if (!ref) return
    const key = normalizeColumnKey(ref)
    if (!refs.some((r) => normalizeColumnKey(r) === key)) {
      onChange([...refs, ref])
    }
    setText('')
  }

  return (
    <div className="ref-chips">
      {refs.length > 0 && (
        <div className="ref-chips__row">
          {refs.map((ref) => {
            const dangling = !!validKeys && !validKeys.has(normalizeColumnKey(ref))
            return (
              <span
                key={normalizeColumnKey(ref)}
                className={`ref-chip${dangling ? ' ref-chip--warn' : ''}`}
                title={dangling ? 'Not found in the current schema' : undefined}
              >
                {formatRef(ref)}
                <button
                  type="button"
                  className="ref-chip__x"
                  title="Remove reference"
                  onClick={() =>
                    onChange(refs.filter((r) => normalizeColumnKey(r) !== normalizeColumnKey(ref)))
                  }
                >
                  <CloseIcon size={9} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      <RefSuggestInput
        text={text}
        onText={setText}
        onPick={add}
        onCommit={() => add(text)}
        intro={intro}
        placeholder="Add reference: schema.table.column"
      />
    </div>
  )
}
