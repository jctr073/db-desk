import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import type { KnowledgeBaseSummary } from '../../../shared/knowledge'
import { suggestSchema } from '../../../shared/repo'
import type { MonorepoMappingInput, MonorepoPick } from '../../../shared/repo'
import { CloseIcon, FolderIcon } from './icons'

/** Last path segment of the picked root, for display and base names. */
function rootName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
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
 * schemas of the current target, and create one knowledge base + link per
 * checked pair. Auto-matching only prefills the schema dropdowns — every row
 * stays manually overridable, and unchecked folders are left alone entirely.
 * Folders already mapped (an existing base with the same root + folder) are
 * badged and reuse that base instead of minting a duplicate.
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
  /** folder → selected schema ('' = none picked yet). */
  const [schemaByFolder, setSchemaByFolder] = useState<Record<string, string>>(
    {}
  )
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
      const prefill: Record<string, string> = {}
      for (const folder of next.folders) {
        prefill[folder] = suggestSchema(folder, schemaOptions) ?? ''
      }
      setSchemaByFolder(prefill)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPicking(false)
    }
  }, [busy, schemaOptions])

  interface Row {
    folder: string
    /** Auto-match hit, for the "auto" badge (selection may differ by now). */
    suggested: string | null
    /** Existing base for this root + folder, or null. */
    mapped: KnowledgeBaseSummary | null
  }

  const rows = useMemo((): Row[] => {
    if (!pick) return []
    return pick.folders.map((folder) => ({
      folder,
      suggested: suggestSchema(folder, schemaOptions),
      mapped:
        bases.find(
          (b) => b.repoRoot === pick.root && (b.subPath ?? null) === folder
        ) ?? null
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
        if (row.suggested && !row.mapped) next.add(row.folder)
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
      const schema = schemaByFolder[row.folder] ?? ''
      if (!schema) {
        setError(
          `Pick a schema for “${row.folder}”, or uncheck it — only checked folders are mapped.`
        )
        return
      }
      mappings.push({
        folder: row.folder,
        schema,
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
  }, [pick, busy, rows, checked, schemaByFolder, connId, database, onDone, onClose])

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
                Map service folders of one repository to the schemas they own.
                Each mapped folder becomes its own knowledge base, scoped to
                that folder — scans and agent lookups for a schema read only
                its service&rsquo;s code.
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
                  disabled={busy || rows.every((r) => !r.suggested || r.mapped)}
                  title="Check every folder with an auto-matched schema"
                  onClick={selectMatched}
                >
                  Select matched
                </button>
              </div>
              {schemasLoading && (
                <div className="url-hint">
                  Loading schemas — the schema dropdowns fill in once
                  introspection finishes.
                </div>
              )}
              {pick.folders.length === 0 ? (
                <div className="manage-kb__repo-none">
                  This folder has no subfolders to map. Choose the directory
                  whose children are the services.
                </div>
              ) : (
                <div className="monorepo__rows">
                  {rows.map((row) => {
                    const schema = schemaByFolder[row.folder] ?? ''
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
                        {!row.mapped && row.suggested && schema === row.suggested && (
                          <span
                            className="monorepo__badge"
                            title="Schema auto-matched from the folder name — change it if the guess is wrong"
                          >
                            auto
                          </span>
                        )}
                        <select
                          className="text-input monorepo__schema"
                          value={schema}
                          disabled={busy || schemasLoading}
                          aria-label={`Schema for ${row.folder}`}
                          onChange={(event) =>
                            setSchemaByFolder((prev) => ({
                              ...prev,
                              [row.folder]: event.target.value
                            }))
                          }
                        >
                          <option value="">— no schema —</option>
                          {schemaOptions.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="url-hint">
                Only checked folders are mapped; everything else is left
                alone. Re-open this setup any time to map more folders.
              </div>
            </>
          )}
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button
            className="btn-cancel"
            onClick={onClose}
            type="button"
            disabled={busy}
          >
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
