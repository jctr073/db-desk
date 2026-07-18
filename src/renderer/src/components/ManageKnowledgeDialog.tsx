import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type {
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeTargetGroup
} from '../../../shared/knowledge'
import type { RepoStatus } from '../../../shared/repo'
import { BaseNameDialog } from './BaseNameDialog'
import { DetachCodebaseDialog } from './DetachCodebaseDialog'
import { BookIcon, CloseIcon, FolderIcon, PlusThinIcon, SearchIcon } from './icons'
import { LinkBaseDialog } from './LinkBaseDialog'
import { MonorepoSetupDialog } from './MonorepoSetupDialog'
import { TargetedScanDialog } from './TargetedScanDialog'
import type { QueryTarget } from './useQueryRunner'
import { useEscapeKey } from '../useEscapeKey'

/** Last path segment of a repo root, for display — renderer never parses paths. */
function repoRootName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

interface ManageKnowledgeDialogProps {
  /** The knowledge tab's (connection, database) target the dialog is scoped to. */
  target: QueryTarget
  /** Every base linked to the target, with its links and records (kept live). */
  groups: KnowledgeTargetGroup[]
  /** The full link table, for "also linked elsewhere" delete warnings. */
  links: KnowledgeLink[]
  /** Connection id → display name, to label those warnings. */
  connNames: Record<string, string>
  /** Introspected schema names of the target database (may still be loading). */
  schemaOptions: string[]
  /** kbId → codebase status; a base absent here falls back to base.repoRoot. */
  repoStatuses: Record<string, RepoStatus>
  /** The panel's selected base, preselected here; null = all-bases view. */
  initialKbId: string | null
  /** Syncs the panel's base selector after create/link. */
  onSelectBase: (kbId: string) => void
  /** Opens the native directory picker for the base (main-process only). */
  onAttachCodebase: (kbId: string) => Promise<void>
  onDetachCodebase: (kbId: string) => Promise<void>
  onDetachAndDeleteBase: (kbId: string) => Promise<void>
  /** Sends the scan prompt pinned to the base; the caller closes the dialog. */
  onScan: (kbId: string) => void
  onTargetedScan: (kbId: string, focus: string) => void
  /** Why scans cannot run right now (agent busy, skills loading), or null. */
  scanDisabledReason: string | null
  onClose: () => void
}

type SubDialog =
  | { kind: 'new' }
  | { kind: 'rename' }
  | { kind: 'link'; candidates: KnowledgeBaseSummary[] }
  | { kind: 'monorepo' }
  | { kind: 'targeted-scan' }
  | { kind: 'detach' }
  | { kind: 'confirm-unlink' }
  | { kind: 'confirm-delete' }

/**
 * The Knowledge tab's "Manage" surface: every base linked to the active
 * connection's target in a master list, with the selected base's codebase
 * (attach / scan / detach), schema links, and lifecycle actions in the detail
 * pane. Replaces the old Manage popover and the composer-injected folder/scan
 * controls, which acted on an implicit default base and gave no way to choose
 * when several bases are linked.
 */
export function ManageKnowledgeDialog({
  target,
  groups,
  links,
  connNames,
  schemaOptions,
  repoStatuses,
  initialKbId,
  onSelectBase,
  onAttachCodebase,
  onDetachCodebase,
  onDetachAndDeleteBase,
  onScan,
  onTargetedScan,
  scanDisabledReason,
  onClose
}: ManageKnowledgeDialogProps): ReactElement {
  const [selectedKbId, setSelectedKbId] = useState<string | null>(
    initialKbId ?? groups[0]?.base.id ?? null
  )
  const [subDialog, setSubDialog] = useState<SubDialog | null>(null)
  /** Schema names whose link toggle is in flight (checkbox disabled). */
  const [pendingSchemas, setPendingSchemas] = useState<Set<string>>(new Set())
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Groups are live (structure pushes reload them, including changes made from
  // the tree submenu while this dialog is open) — keep the selection valid.
  useEffect(() => {
    setSelectedKbId((current) =>
      current && groups.some((g) => g.base.id === current) ? current : (groups[0]?.base.id ?? null)
    )
  }, [groups])

  const selectedGroup = useMemo(
    () => groups.find((g) => g.base.id === selectedKbId) ?? null,
    [groups, selectedKbId]
  )

  // Sub-dialogs register their own Escape handlers, so this one is inactive
  // while a sub-dialog is up: one Escape must close only the topmost layer.
  useEscapeKey(!subDialog && !attaching, onClose)

  const targetLabel = `${target.connName} / ${target.database}`

  const status = selectedGroup ? (repoStatuses[selectedGroup.base.id] ?? null) : null
  // Until repo:get resolves, fall back to the base record's own repoRoot.
  const repoRoot = status ? status.root : (selectedGroup?.base.repoRoot ?? null)
  const repoName = repoRoot ? repoRootName(repoRoot) : null

  /** Links of the selected base pointing anywhere but this target. */
  const linksElsewhere = useMemo(() => {
    if (!selectedGroup) return []
    return links.filter(
      (l) =>
        l.kbId === selectedGroup.base.id &&
        !(l.connId === target.connId && l.database === target.database)
    )
  }, [links, selectedGroup, target.connId, target.database])

  // --- Base lifecycle. Structural changes reload `groups` via the store's
  // structure push, so these only fire the API and adjust the selection. ---

  const createAndLinkBase = useCallback(
    async (name: string, schema?: string): Promise<void> => {
      if (!schema) return
      const base = await window.dbDesk.knowledge.createBase(name)
      await window.dbDesk.knowledge.addLink({
        kbId: base.id,
        connId: target.connId,
        database: target.database,
        schema
      })
      setSelectedKbId(base.id)
      onSelectBase(base.id)
    },
    [target.connId, target.database, onSelectBase]
  )

  const renameSelectedBase = useCallback(
    async (name: string): Promise<void> => {
      if (!selectedGroup) return
      await window.dbDesk.knowledge.renameBase(selectedGroup.base.id, name)
    },
    [selectedGroup]
  )

  const linkExistingBase = useCallback(
    async (kbId: string, schema: string): Promise<void> => {
      await window.dbDesk.knowledge.addLink({
        kbId,
        connId: target.connId,
        database: target.database,
        schema
      })
      setSelectedKbId(kbId)
      onSelectBase(kbId)
    },
    [target.connId, target.database, onSelectBase]
  )

  const openLinkDialog = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      // Every base is a candidate: links are schema-scoped, so a base already
      // linked to one schema can still be linked to another (relinking an
      // existing scope is a harmless no-op in the store).
      const candidates = await window.dbDesk.knowledge.listBases()
      setSubDialog({ kind: 'link', candidates })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const unlinkSelectedBase = useCallback(async (): Promise<void> => {
    if (!selectedGroup) return
    await Promise.all(
      selectedGroup.links.map((link) => window.dbDesk.knowledge.removeLink(link.id))
    )
  }, [selectedGroup])

  const deleteSelectedBase = useCallback(async (): Promise<void> => {
    if (!selectedGroup) return
    await window.dbDesk.knowledge.deleteBase(selectedGroup.base.id)
  }, [selectedGroup])

  const attach = useCallback(async (): Promise<void> => {
    if (!selectedGroup || attaching) return
    setError(null)
    setAttaching(true)
    try {
      await onAttachCodebase(selectedGroup.base.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAttaching(false)
    }
  }, [selectedGroup, attaching, onAttachCodebase])

  // --- Schema links. Rows are the union of introspected schemas and schemas
  // already linked (a link may point at a schema introspection doesn't show). ---

  interface SchemaRow {
    /** Display name; for a legacy database-wide link, a placeholder label. */
    label: string
    /** The schema to link on check; null for the legacy no-schema row. */
    schema: string | null
    link: KnowledgeLink | null
    missing: boolean
  }

  const schemaRows = useMemo((): SchemaRow[] => {
    if (!selectedGroup) return []
    const linkFor = (schema: string): KnowledgeLink | null =>
      selectedGroup.links.find((l) => (l.schema ?? '').toLowerCase() === schema.toLowerCase()) ??
      null
    const rows: SchemaRow[] = schemaOptions.map((schema) => ({
      label: schema,
      schema,
      link: linkFor(schema),
      missing: false
    }))
    const known = new Set(schemaOptions.map((s) => s.toLowerCase()))
    for (const link of selectedGroup.links) {
      if (link.schema === undefined) {
        rows.push({
          label: 'Entire database (legacy link)',
          schema: null,
          link,
          missing: false
        })
      } else if (!known.has(link.schema.toLowerCase())) {
        rows.push({ label: link.schema, schema: link.schema, link, missing: true })
      }
    }
    return rows
  }, [selectedGroup, schemaOptions])

  const toggleSchema = useCallback(
    async (row: SchemaRow): Promise<void> => {
      if (!selectedGroup) return
      const key = row.schema ?? row.label
      if (pendingSchemas.has(key)) return
      // Removing the base's last link here would silently drop it from this
      // connection — route through the explicit unlink confirmation instead.
      if (row.link && selectedGroup.links.length === 1) {
        setSubDialog({ kind: 'confirm-unlink' })
        return
      }
      setError(null)
      setPendingSchemas((prev) => new Set(prev).add(key))
      try {
        if (row.link) {
          await window.dbDesk.knowledge.removeLink(row.link.id)
        } else if (row.schema) {
          await window.dbDesk.knowledge.addLink({
            kbId: selectedGroup.base.id,
            connId: target.connId,
            database: target.database,
            schema: row.schema
          })
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPendingSchemas((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [selectedGroup, pendingSchemas, target.connId, target.database]
  )

  /**
   * The master list, clustered by shared repo root: bases created by the
   * monorepo setup all carry the same `repoRoot` (differing only in
   * `subPath`), so two or more of them linked here render under one repo
   * header instead of as unrelated bases. Solo bases keep their original
   * order in headerless sections.
   */
  interface ListSection {
    /** Repo display name for a monorepo cluster; null for solo bases. */
    header: string | null
    items: KnowledgeTargetGroup[]
  }

  const listSections = useMemo((): ListSection[] => {
    const rootCount = new Map<string, number>()
    for (const g of groups) {
      const root = g.base.repoRoot
      if (root) rootCount.set(root, (rootCount.get(root) ?? 0) + 1)
    }
    const sections: ListSection[] = []
    const clustered = new Set<string>()
    for (const g of groups) {
      const root = g.base.repoRoot
      if (root && (rootCount.get(root) ?? 0) > 1) {
        if (clustered.has(root)) continue
        clustered.add(root)
        sections.push({
          header: repoRootName(root),
          items: groups.filter((x) => x.base.repoRoot === root)
        })
      } else {
        const last = sections[sections.length - 1]
        if (last && last.header === null) last.items.push(g)
        else sections.push({ header: null, items: [g] })
      }
    }
    return sections
  }, [groups])

  /** " · schema: a, b" — same shape as the panel's base-selector labels. */
  const schemasLabel = (groupLinks: Array<{ schema?: string }>): string => {
    const scopes = groupLinks.map((l) => l.schema).filter((s): s is string => !!s)
    return scopes.length > 0 ? scopes.join(', ') : ''
  }

  const scanBlocked = !repoRoot ? 'Attach a codebase first' : (scanDisabledReason ?? null)

  const unlinkScopes = selectedGroup
    ? selectedGroup.links.map((l) => l.schema).filter((s): s is string => !!s)
    : []

  return (
    <>
      {/* No click-to-close on the overlay: a stray click must not dismiss
          in-flight management work (same rule as the other dialogs). */}
      <div className="dialog-overlay">
        <div
          className="dialog manage-kb-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Manage knowledge bases"
        >
          <div className="dialog__header">
            <span className="dialog__icon">
              <BookIcon size={16} />
            </span>
            <div className="dialog__titles">
              <div className="dialog__title">Manage Knowledge Bases</div>
              <div className="dialog__subtitle">{targetLabel}</div>
            </div>
            <button
              className="dialog__close"
              onClick={onClose}
              title="Close"
              type="button"
              disabled={attaching}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="dialog__body manage-kb__body">
            <div className="manage-kb__list">
              <div className="manage-kb__items">
                {listSections.map((section, index) => (
                  <div key={section.header ?? `·solo·${index}`}>
                    {section.header && (
                      <div
                        className="manage-kb__group-header"
                        title={section.items[0]?.base.repoRoot ?? undefined}
                      >
                        <FolderIcon size={10} />
                        {section.header}
                      </div>
                    )}
                    {section.items.map((g) => {
                      const gRoot = repoStatuses[g.base.id]?.root ?? g.base.repoRoot
                      const scopes = schemasLabel(g.links)
                      return (
                        <button
                          key={g.base.id}
                          type="button"
                          className={`manage-kb__item${
                            g.base.id === selectedKbId ? ' is-selected' : ''
                          }`}
                          onClick={() => setSelectedKbId(g.base.id)}
                        >
                          <span className="manage-kb__item-name">
                            {g.base.name}
                            {gRoot && !section.header && (
                              <span
                                className="manage-kb__item-repo"
                                title={`Codebase attached — ${repoRootName(gRoot)}`}
                              >
                                <FolderIcon size={11} />
                              </span>
                            )}
                          </span>
                          <span className="manage-kb__item-meta">
                            {g.base.subPath && (
                              <span title={g.base.subPath}>{g.base.subPath} · </span>
                            )}
                            {scopes && <span title={scopes}>{scopes} · </span>}
                            {g.records.length} record
                            {g.records.length === 1 ? '' : 's'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
                {groups.length === 0 && (
                  <div className="manage-kb__list-empty">
                    No knowledge bases are linked to this database yet.
                  </div>
                )}
              </div>
              <div className="manage-kb__list-actions">
                <button
                  type="button"
                  className="manage-kb__action"
                  onClick={() => setSubDialog({ kind: 'new' })}
                >
                  <PlusThinIcon size={11} />
                  New base…
                </button>
                <button
                  type="button"
                  className="manage-kb__action"
                  onClick={() => void openLinkDialog()}
                >
                  <BookIcon size={11} />
                  Link existing base…
                </button>
                <button
                  type="button"
                  className="manage-kb__action"
                  title="Map service folders of one repository to the schemas they own"
                  onClick={() => setSubDialog({ kind: 'monorepo' })}
                >
                  <FolderIcon size={11} />
                  Set up monorepo…
                </button>
              </div>
            </div>

            <div className="manage-kb__detail">
              {selectedGroup ? (
                <>
                  <div className="manage-kb__section">
                    <div className="manage-kb__section-title">Codebase</div>
                    {repoRoot ? (
                      <div className="manage-kb__repo-path" title={repoRoot}>
                        {repoRoot}
                        {status?.commit && (
                          <span className="manage-kb__repo-commit"> @ {status.commit}</span>
                        )}
                      </div>
                    ) : (
                      <div className="manage-kb__repo-none">No codebase attached.</div>
                    )}
                    {selectedGroup.base.subPath && (
                      <div className="manage-kb__repo-sub">
                        Monorepo folder <strong>{selectedGroup.base.subPath}</strong>
                        {selectedGroup.base.repoRoot && (
                          <> of {repoRootName(selectedGroup.base.repoRoot)}</>
                        )}{' '}
                        — repo tools and scans see only this folder.
                      </div>
                    )}
                    <div className="manage-kb__row-actions">
                      <button
                        type="button"
                        className="manage-kb__btn"
                        disabled={attaching}
                        title={
                          selectedGroup.base.subPath
                            ? 'Pick a different directory (replaces the monorepo folder scope)'
                            : repoRoot
                              ? 'Pick a different codebase directory for this base'
                              : 'Attach a local codebase to this base'
                        }
                        onClick={() => void attach()}
                      >
                        {attaching && <span className="spinner spinner--xs" />}
                        {repoRoot ? 'Change directory…' : 'Attach codebase…'}
                      </button>
                      <button
                        type="button"
                        className="manage-kb__btn"
                        disabled={!repoRoot || attaching}
                        title="Detach the codebase, keeping or deleting the knowledge base"
                        onClick={() => setSubDialog({ kind: 'detach' })}
                      >
                        Detach…
                      </button>
                    </div>
                    <div className="manage-kb__row-actions">
                      <button
                        type="button"
                        className="manage-kb__btn"
                        disabled={!!scanBlocked}
                        title={scanBlocked ?? 'Send the codebase-scan prompt as a chat message'}
                        onClick={() => onScan(selectedGroup.base.id)}
                      >
                        <SearchIcon size={11} />
                        Scan codebase
                      </button>
                      <button
                        type="button"
                        className="manage-kb__btn"
                        disabled={!!scanBlocked}
                        title={
                          scanBlocked ??
                          'Re-scan a specific part of the codebase with your own focus instructions'
                        }
                        onClick={() => setSubDialog({ kind: 'targeted-scan' })}
                      >
                        Targeted scan…
                      </button>
                    </div>
                  </div>

                  <div className="manage-kb__section">
                    <div className="manage-kb__section-title">Linked schemas</div>
                    {schemaRows.length === 0 ? (
                      <div className="manage-kb__repo-none">Loading schemas…</div>
                    ) : (
                      <div className="manage-kb__schemas">
                        {schemaRows.map((row) => (
                          <label key={row.schema ?? '·legacy·'} className="manage-kb__schema-row">
                            <input
                              type="checkbox"
                              checked={!!row.link}
                              disabled={pendingSchemas.has(row.schema ?? row.label)}
                              onChange={() => void toggleSchema(row)}
                            />
                            <span className="manage-kb__schema-name">
                              {row.label}
                              {row.missing && (
                                <span
                                  className="manage-kb__schema-missing"
                                  title="This schema is not in the current introspection — unchecking removes the link"
                                >
                                  {' '}
                                  (not in schema)
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="manage-kb__section">
                    <div className="manage-kb__section-title">Base</div>
                    <div className="manage-kb__row-actions">
                      <button
                        type="button"
                        className="manage-kb__btn"
                        onClick={() => setSubDialog({ kind: 'rename' })}
                      >
                        Rename…
                      </button>
                      <button
                        type="button"
                        className="manage-kb__btn"
                        title="Remove this database's links; the base and its records are kept"
                        onClick={() => setSubDialog({ kind: 'confirm-unlink' })}
                      >
                        Unlink from this database…
                      </button>
                      <button
                        type="button"
                        className="manage-kb__btn manage-kb__btn--danger"
                        title="Permanently delete the base and all of its records, everywhere it is linked"
                        onClick={() => setSubDialog({ kind: 'confirm-delete' })}
                      >
                        Delete base…
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="manage-kb__detail-empty">
                  Create a knowledge base or link an existing one to get started.
                </div>
              )}
            </div>
          </div>

          <div className="dialog__footer">
            {error ? (
              <div className="mcp-form-error" role="alert">
                {error}
              </div>
            ) : (
              <div className="test-msg" />
            )}
            <button className="btn-cancel" onClick={onClose} type="button" disabled={attaching}>
              Close
            </button>
          </div>
        </div>
      </div>

      {subDialog?.kind === 'new' && (
        <BaseNameDialog
          title="New Knowledge Base"
          subtitle={targetLabel}
          initialName={groups.length === 0 ? target.database : ''}
          submitLabel="Create Base"
          schemaOptions={schemaOptions}
          onSubmit={createAndLinkBase}
          onClose={() => setSubDialog(null)}
        />
      )}
      {subDialog?.kind === 'rename' && selectedGroup && (
        <BaseNameDialog
          title="Rename Knowledge Base"
          subtitle={selectedGroup.base.name}
          initialName={selectedGroup.base.name}
          submitLabel="Rename"
          onSubmit={renameSelectedBase}
          onClose={() => setSubDialog(null)}
        />
      )}
      {subDialog?.kind === 'link' && (
        <LinkBaseDialog
          targetLabel={targetLabel}
          bases={subDialog.candidates}
          schemaOptions={schemaOptions}
          onLink={linkExistingBase}
          onClose={() => setSubDialog(null)}
        />
      )}
      {subDialog?.kind === 'monorepo' && (
        <MonorepoSetupDialog
          targetLabel={targetLabel}
          connId={target.connId}
          database={target.database}
          schemaOptions={schemaOptions}
          onDone={(kbId) => {
            if (kbId) {
              setSelectedKbId(kbId)
              onSelectBase(kbId)
            }
          }}
          onClose={() => setSubDialog(null)}
        />
      )}
      {subDialog?.kind === 'targeted-scan' && selectedGroup && (
        <TargetedScanDialog
          targetLabel={targetLabel}
          repoName={repoName}
          onClose={() => setSubDialog(null)}
          onScan={(focus) => {
            setSubDialog(null)
            onTargetedScan(selectedGroup.base.id, focus)
          }}
        />
      )}
      {subDialog?.kind === 'detach' && selectedGroup && (
        <DetachCodebaseDialog
          targetLabel={targetLabel}
          repoName={repoName}
          baseName={selectedGroup.base.name}
          onClose={() => setSubDialog(null)}
          onDetach={async () => {
            await onDetachCodebase(selectedGroup.base.id)
            setSubDialog(null)
          }}
          onDetachAndDelete={async () => {
            await onDetachAndDeleteBase(selectedGroup.base.id)
            setSubDialog(null)
          }}
        />
      )}
      {subDialog?.kind === 'confirm-unlink' && selectedGroup && (
        <ConfirmBaseDialog
          title="Unlink Knowledge Base?"
          subtitle={targetLabel}
          confirmLabel="Unlink"
          pendingLabel="Unlinking…"
          onConfirm={unlinkSelectedBase}
          onClose={() => setSubDialog(null)}
        >
          <p>
            Unlink <strong>“{selectedGroup.base.name}”</strong> from this database
            {unlinkScopes.length > 0 && (
              <>
                {' '}
                (schema{unlinkScopes.length === 1 ? '' : 's'}{' '}
                <strong>{unlinkScopes.join(', ')}</strong>)
              </>
            )}
            ? The base and its records are kept — only the links to this database are removed.
          </p>
        </ConfirmBaseDialog>
      )}
      {subDialog?.kind === 'confirm-delete' && selectedGroup && (
        <ConfirmBaseDialog
          title="Delete Knowledge Base?"
          subtitle={selectedGroup.base.name}
          confirmLabel="Delete Base"
          pendingLabel="Deleting…"
          onConfirm={deleteSelectedBase}
          onClose={() => setSubDialog(null)}
        >
          <p>
            Permanently delete <strong>“{selectedGroup.base.name}”</strong> and all of its{' '}
            {selectedGroup.records.length} record
            {selectedGroup.records.length === 1 ? '' : 's'}? The base is removed from every database
            it is linked to, not only this one. This cannot be undone.
          </p>
          {linksElsewhere.length > 0 && (
            <p>
              Also linked to:{' '}
              <strong>
                {[
                  ...new Set(
                    linksElsewhere.map((l) => `${connNames[l.connId] ?? l.connId} / ${l.database}`)
                  )
                ].join(', ')}
              </strong>
            </p>
          )}
        </ConfirmBaseDialog>
      )}
    </>
  )
}

interface ConfirmBaseDialogProps {
  title: string
  subtitle: string
  confirmLabel: string
  pendingLabel: string
  children: ReactNode
  onConfirm: () => Promise<void>
  onClose: () => void
}

/**
 * Destructive-action confirmation for the manage dialog (unlink / delete),
 * replacing the old window.confirm flows. Same pattern as
 * DetachCodebaseDialog: alertdialog, pending label, inline error.
 */
function ConfirmBaseDialog({
  title,
  subtitle,
  confirmLabel,
  pendingLabel,
  children,
  onConfirm,
  onClose
}: ConfirmBaseDialogProps): ReactElement {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscapeKey(!pending, onClose)

  const run = useCallback(async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPending(false)
    }
  }, [pending, onConfirm, onClose])

  return (
    <div className="dialog-overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title}>
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
            disabled={pending}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body manage-kb__confirm-body">
          {children}
          {error && (
            <div className="mcp-form-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button
            className="btn-cancel"
            onClick={onClose}
            type="button"
            disabled={pending}
            autoFocus
          >
            Cancel
          </button>
          <button
            className="btn-danger"
            onClick={() => void run()}
            type="button"
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
