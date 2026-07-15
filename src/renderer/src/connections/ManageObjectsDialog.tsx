import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

import { CloseIcon, DatabaseIcon, SearchIcon } from '../components/icons'

interface ManageObjectsDialogProps {
  /** "Manage Schemas" / "Manage Catalogs". */
  title: string
  /** e.g. "catalog `sales` on My Warehouse" or the connection name. */
  subtitle: string
  /** "schemas" / "catalogs", for the footer count. */
  noun: string
  /** Full list to pick from; null while it loads. */
  items: string[] | null
  /** Saved selection; null = no selection saved (everything checked). */
  initialSelected: string[] | null
  /** Item that cannot be unchecked (the connected catalog). */
  lockedItem?: string
  /** Load failure to surface instead of the list. */
  error?: string
  /**
   * Called with the chosen items, or null when every item is checked —
   * "all" is stored as no-selection so new items keep appearing.
   */
  onSubmit: (selected: string[] | null) => Promise<void>
  onClose: () => void
}

const listStyle: CSSProperties = {
  maxHeight: 320,
  overflowY: 'auto',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 0'
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 10px',
  fontSize: 13,
  cursor: 'pointer',
  userSelect: 'none'
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8
}

const linkBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
  color: 'var(--accent)',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
}

const emptyStyle: CSSProperties = {
  padding: '18px 10px',
  textAlign: 'center',
  fontSize: 12.5,
  color: 'var(--text-faint)'
}

/**
 * Checkbox picker for schema/catalog pinning (Databricks) — one component
 * for both "Manage Schemas…" and "Manage Catalogs…". Follows the house
 * dialog pattern (BaseNameDialog).
 */
export function ManageObjectsDialog({
  title,
  subtitle,
  noun,
  items,
  initialSelected,
  lockedItem,
  error,
  onSubmit,
  onClose
}: ManageObjectsDialogProps): ReactElement {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // (Re)initialize once the list and the saved selection arrive.
  useEffect(() => {
    if (!items) return
    const initial = initialSelected
      ? items.filter((item) => initialSelected.includes(item))
      : [...items]
    if (lockedItem && items.includes(lockedItem) && !initial.includes(lockedItem)) {
      initial.push(lockedItem)
    }
    setChecked(new Set(initial))
  }, [items, initialSelected, lockedItem])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const visible = useMemo(() => {
    if (!items) return []
    const needle = filter.trim().toLowerCase()
    return needle
      ? items.filter((item) => item.toLowerCase().includes(needle))
      : items
  }, [items, filter])

  const toggle = (item: string): void => {
    if (item === lockedItem) return
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(item)) next.delete(item)
      else next.add(item)
      return next
    })
  }

  /** Check or uncheck every visible item (the locked one stays checked). */
  const setVisible = (on: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      for (const item of visible) {
        if (on) next.add(item)
        else if (item !== lockedItem) next.delete(item)
      }
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (saving || !items || checked.size === 0) return
    setSubmitError(null)
    setSaving(true)
    try {
      const selection =
        checked.size === items.length
          ? null
          : items.filter((item) => checked.has(item))
      await onSubmit(selection)
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }

  return (
    // No click-to-close on the overlay (house rule: a stray click must not
    // discard the selection being built).
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog__header">
          <span className="dialog__icon">
            <DatabaseIcon size={16} />
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
          <div style={toolbarStyle}>
            <div className="filter-box" style={{ flex: '1 1 auto' }}>
              <SearchIcon />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={`Filter ${noun}…`}
                aria-label={`Filter ${noun}`}
                autoFocus
              />
            </div>
            <button type="button" style={linkBtnStyle} onClick={() => setVisible(true)}>
              Select all
            </button>
            <button type="button" style={linkBtnStyle} onClick={() => setVisible(false)}>
              Select none
            </button>
          </div>

          {error ? (
            <div className="mcp-form-error">{error}</div>
          ) : (
            <div style={listStyle}>
              {!items && <div style={emptyStyle}>Loading {noun}…</div>}
              {items && items.length === 0 && (
                <div style={emptyStyle}>No {noun} found.</div>
              )}
              {items && items.length > 0 && visible.length === 0 && (
                <div style={emptyStyle}>No {noun} match the filter.</div>
              )}
              {visible.map((item) => (
                <label
                  key={item}
                  style={{
                    ...rowStyle,
                    opacity: item === lockedItem ? 0.65 : 1,
                    cursor: item === lockedItem ? 'default' : 'pointer'
                  }}
                  title={
                    item === lockedItem
                      ? 'The connected catalog is always shown'
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked.has(item)}
                    disabled={item === lockedItem}
                    onChange={() => toggle(item)}
                  />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {item}
                  </span>
                </label>
              ))}
            </div>
          )}
          {submitError && <div className="mcp-form-error">{submitError}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg">
            {items
              ? `${checked.size} of ${items.length} ${noun} selected`
              : ''}
          </div>
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
            disabled={saving || !items || !!error || checked.size === 0}
            type="button"
          >
            {saving && <span className="spinner" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
