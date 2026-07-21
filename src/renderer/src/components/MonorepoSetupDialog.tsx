import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

import type { KnowledgeBaseSummary } from '../../../shared/knowledge'
import { suggestSchemas } from '../../../shared/repo'
import type { MonorepoMappingInput, MonorepoPick } from '../../../shared/repo'
import { CloseIcon, FolderIcon } from './icons'

/** Last path segment of the picked root, for display and base names. */
function rootName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v))
}

const POPOVER_WIDTH = 250
/** Space the popover needs below the trigger before it flips above. */
const POPOVER_MIN_HEIGHT = 180
const POPOVER_MAX_HEIGHT = 300

interface SchemaMultiSelectProps {
  folder: string
  options: string[]
  selected: string[]
  disabled: boolean
  onChange: (next: string[]) => void
}

/**
 * Compact multi-select for a mapping row: a select-styled trigger summarizing
 * the current schema set, opening a filterable checkbox popover. The popover
 * is position-fixed so it can escape the scrolling rows container (which is
 * why it closes on any outside scroll — its anchor rect would go stale).
 */
function SchemaMultiSelect({
  folder,
  options,
  selected,
  disabled,
  onChange
}: SchemaMultiSelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Capture-phase Escape so the dialog's own document-level handler (which
    // would close the whole dialog) never sees the key while the popover is up.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onScroll = (event: Event): void => {
      if (popRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const toggleOpen = (): void => {
    if (!open) {
      setAnchor(triggerRef.current?.getBoundingClientRect() ?? null)
      setFilter('')
    }
    setOpen(!open)
  }

  const toggleSchema = (schema: string): void => {
    onChange(
      selected.includes(schema)
        ? selected.filter((s) => s !== schema)
        : // Keep `options` order so the summary and saved links read stably.
          options.filter((s) => selected.includes(s) || s === schema)
    )
  }

  const shown = filter.trim()
    ? options.filter((s) => s.toLowerCase().includes(filter.trim().toLowerCase()))
    : options

  const label =
    selected.length === 0
      ? '— no schemas —'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} schemas`

  let popStyle: CSSProperties | undefined
  if (open && anchor) {
    const left = Math.max(
      8,
      Math.min(anchor.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8)
    )
    const spaceBelow = window.innerHeight - anchor.bottom - 8
    popStyle =
      spaceBelow >= POPOVER_MIN_HEIGHT
        ? {
            left,
            top: anchor.bottom + 4,
            maxHeight: Math.min(POPOVER_MAX_HEIGHT, spaceBelow)
          }
        : {
            left,
            bottom: window.innerHeight - anchor.top + 4,
            maxHeight: Math.min(POPOVER_MAX_HEIGHT, anchor.top - 8)
          }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`text-input monorepo__schema monorepo__ms-trigger${
          selected.length === 0 ? ' monorepo__ms-trigger--empty' : ''
        }`}
        disabled={disabled}
        aria-label={`Schemas for ${folder}`}
        aria-expanded={open}
        title={selected.join(', ') || undefined}
        onClick={toggleOpen}
      >
        <span className="monorepo__ms-label">{label}</span>
        <span className="monorepo__ms-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && popStyle && (
        <div className="monorepo__ms-pop" style={popStyle} ref={popRef} role="listbox">
          <input
            className="text-input monorepo__ms-filter"
            placeholder="Filter schemas…"
            value={filter}
            autoFocus
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="monorepo__ms-list">
            {shown.length === 0 && <div className="monorepo__ms-none">No schemas match.</div>}
            {shown.map((schema) => (
              <label key={schema} className="monorepo__ms-option">
                <input
                  type="checkbox"
                  checked={selected.includes(schema)}
                  onChange={() => toggleSchema(schema)}
                />
                <span className="monorepo__ms-name" title={schema}>
                  {schema}
                </span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <div className="monorepo__ms-foot">
              <button type="button" className="manage-kb__btn" onClick={() => onChange([])}>
                Clear {selected.length}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

interface MonorepoSetupDialogProps {
  /** "connName / database" shown as the dialog subtitle. */
  targetLabel: string
  connId: string
  database: string
  /** Introspected schema names of the target database (may still be loading). */
  schemaOptions: string[]
  /** Called with the first mapped base after a successful create. */
  onDone: (kbId: string | null) => void
  onClose: () => void
}

/**
 * Monorepo setup: pick the repo root once, map its immediate child folders to
 * the schemas each service owns, and create one knowledge base per checked
 * folder plus a link per selected schema (one folder → many schemas).
 * Auto-matching only prefills the schema pickers — every row stays manually
 * overridable, and unchecked folders are left alone entirely. Folders already
 * mapped (an existing base with the same root + folder) are badged and reuse
 * that base instead of minting a duplicate.
 */
export function MonorepoSetupDialog({
  targetLabel,
  connId,
  database,
  schemaOptions,
  onDone,
  onClose
}: MonorepoSetupDialogProps): ReactElement {
  const [pick, setPick] = useState<MonorepoPick | null>(null)
  /** All bases, loaded with the pick, for already-mapped detection. */
  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([])
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** folder → selected schemas ([] = none picked yet). */
  const [schemasByFolder, setSchemasByFolder] = useState<Record<string, string[]>>({})
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const busy = picking || creating

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const choosePick = useCallback(async (): Promise<void> => {
    if (busy) return
    setError(null)
    setPicking(true)
    try {
      const next = await window.dbDesk.repo.monorepoPick()
      if (!next) return // cancelled: keep whatever was on screen
      const allBases = await window.dbDesk.knowledge.listBases()
      setPick(next)
      setBases(allBases)
      setChecked(new Set())
      const prefill: Record<string, string[]> = {}
      for (const folder of next.folders) {
        prefill[folder] = suggestSchemas(folder, schemaOptions)
      }
      setSchemasByFolder(prefill)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPicking(false)
    }
  }, [busy, schemaOptions])

  interface Row {
    folder: string
    /** Auto-match hits, for the "auto" badge (selection may differ by now). */
    suggested: string[]
    /** Existing base for this root + folder, or null. */
    mapped: KnowledgeBaseSummary | null
  }

  const rows = useMemo((): Row[] => {
    if (!pick) return []
    return pick.folders.map((folder) => ({
      folder,
      suggested: suggestSchemas(folder, schemaOptions),
      mapped: bases.find((b) => b.repoRoot === pick.root && (b.subPath ?? null) === folder) ?? null
    }))
  }, [pick, bases, schemaOptions])

  const toggleFolder = useCallback((folder: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])

  /** Check every auto-matched folder that is not already mapped. */
  const selectMatched = useCallback((): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      for (const row of rows) {
        if (row.suggested.length > 0 && !row.mapped) next.add(row.folder)
      }
      return next
    })
  }, [rows])

  const selectedCount = useMemo(
    () => rows.filter((r) => checked.has(r.folder)).length,
    [rows, checked]
  )

  const create = useCallback(async (): Promise<void> => {
    if (!pick || busy) return
    const mappings: MonorepoMappingInput[] = []
    for (const row of rows) {
      if (!checked.has(row.folder)) continue
      const schemas = schemasByFolder[row.folder] ?? []
      if (schemas.length === 0) {
        setError(
          `Pick at least one schema for “${row.folder}”, or uncheck it — only checked folders are mapped.`
        )
        return
      }
      mappings.push({
        folder: row.folder,
        schemas,
        name: `${rootName(pick.root)}/${row.folder}`.slice(0, 120)
      })
    }
    if (mappings.length === 0) return
    setError(null)
    setCreating(true)
    try {
      const result = await window.dbDesk.repo.monorepoCreate({
        pickId: pick.pickId,
        connId,
        database,
        mappings
      })
      onDone(result.kbIds[0] ?? null)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setCreating(false)
    }
  }, [pick, busy, rows, checked, schemasByFolder, connId, database, onDone, onClose])

  const schemasLoading = schemaOptions.length === 0

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-configured mapping table (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div
        className="dialog monorepo-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Set up monorepo knowledge bases"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <FolderIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Set Up Monorepo</div>
            <div className="dialog__subtitle">{targetLabel}</div>
          </div>
          <button
            className="dialog__close"
            onClick={onClose}
            title="Close"
            type="button"
            disabled={busy}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body monorepo__body">
          {!pick ? (
            <>
              <p className="monorepo__intro">
                Map service folders of one repository to the schemas they own. Each mapped folder
                becomes its own knowledge base, scoped to that folder — scans and agent lookups for
                a schema read only its service&rsquo;s code.
              </p>
              <div className="manage-kb__row-actions">
                <button
                  type="button"
                  className="manage-kb__btn"
                  disabled={busy}
                  onClick={() => void choosePick()}
                >
                  {picking && <span className="spinner spinner--xs" />}
                  Choose monorepo root…
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="manage-kb__repo-path" title={pick.root}>
                {pick.root}
              </div>
              <div className="monorepo__toolbar">
                <button
                  type="button"
                  className="manage-kb__btn"
                  disabled={busy}
                  onClick={() => void choosePick()}
                >
                  Change root…
                </button>
                <button
                  type="button"
                  className="manage-kb__btn"
                  disabled={busy || rows.every((r) => r.suggested.length === 0 || r.mapped)}
                  title="Check every folder with an auto-matched schema"
                  onClick={selectMatched}
                >
                  Select matched
                </button>
              </div>
              {schemasLoading && (
                <div className="url-hint">
                  Loading schemas — the schema pickers fill in once introspection finishes.
                </div>
              )}
              {pick.folders.length === 0 ? (
                <div className="manage-kb__repo-none">
                  This folder has no subfolders to map. Choose the directory whose children are the
                  services.
                </div>
              ) : (
                <div className="monorepo__rows">
                  {rows.map((row) => {
                    const schemas = schemasByFolder[row.folder] ?? []
                    return (
                      <div key={row.folder} className="monorepo__row">
                        <label className="monorepo__row-check">
                          <input
                            type="checkbox"
                            checked={checked.has(row.folder)}
                            disabled={busy}
                            onChange={() => toggleFolder(row.folder)}
                          />
                          <span className="monorepo__folder" title={row.folder}>
                            {row.folder}
                          </span>
                        </label>
                        {row.mapped && (
                          <span
                            className="monorepo__badge monorepo__badge--mapped"
                            title={`Already mapped — “${row.mapped.name}” will be reused`}
                          >
                            mapped
                          </span>
                        )}
                        {!row.mapped &&
                          row.suggested.length > 0 &&
                          sameSet(schemas, row.suggested) && (
                            <span
                              className="monorepo__badge"
                              title="Schemas auto-matched from the folder name — change them if the guess is wrong"
                            >
                              auto
                            </span>
                          )}
                        <SchemaMultiSelect
                          folder={row.folder}
                          options={schemaOptions}
                          selected={schemas}
                          disabled={busy || schemasLoading}
                          onChange={(next) =>
                            setSchemasByFolder((prev) => ({
                              ...prev,
                              [row.folder]: next
                            }))
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="url-hint">
                Only checked folders are mapped; everything else is left alone. Re-open this setup
                any time to map more folders.
              </div>
            </>
          )}
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button" disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void create()}
            type="button"
            disabled={busy || selectedCount === 0}
          >
            {creating && <span className="spinner" />}
            Map {selectedCount || ''} folder{selectedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
