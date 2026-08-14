import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type {
  BackgroundAgentJob,
  BackgroundScanKind,
  BackgroundScanStartResult
} from '../../../shared/backgroundAgents'
import type {
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeTargetGroup
} from '../../../shared/knowledge'
import type { RepoStatus } from '../../../shared/repo'
import { BaseNameDialog } from './BaseNameDialog'
import { DetachCodebaseDialog } from './DetachCodebaseDialog'
import { BookIcon, CloseIcon, FolderIcon, KebabIcon, PlusThinIcon, SearchIcon } from './icons'
import { LinkBaseDialog } from './LinkBaseDialog'
import { buildRailSections, repoRootName } from './manageKb'
import { MonorepoSetupDialog } from './MonorepoSetupDialog'
import { ScanDialog } from './ScanDialog'
import type { QueryTarget } from './useQueryRunner'
import { useEscapeKey } from '../useEscapeKey'

interface ManageKnowledgeDialogProps {
  /** The knowledge tab's (connection, database) target the dialog is scoped to. */
  target: QueryTarget
  /** Every base linked to the target, with its links and records (kept live). */
  groups: KnowledgeTargetGroup[]
  /** The full link table, for "also linked elsewhere" delete warnings. */
  links: KnowledgeLink[]
  /** Every base in the store, for the rail's "mapped elsewhere" rows. */
  allBases: KnowledgeBaseSummary[]
  /** Connection id → display name, to label those warnings. */
  connNames: Record<string, string>
  /** Introspected schema names of the target database (may still be loading). */
  schemaOptions: string[]
  /** kbId → codebase status; a base absent here falls back to base.repoRoot. */
  repoStatuses: Record<string, RepoStatus>
  /** All background scan jobs; the dialog filters by base + target. */
  jobs: BackgroundAgentJob[]
  /** Schema name → relation count (tables+views+matviews), for schema chips. */
  schemaTableCounts: Record<string, number>
  /** The panel's selected base, preselected here; null = all-bases view. */
  initialKbId: string | null
  /** Syncs the panel's base selector after create/link. */
  onSelectBase: (kbId: string) => void
  /** Opens the native directory picker for the base (main-process only). */
  onAttachCodebase: (kbId: string) => Promise<void>
  onDetachCodebase: (kbId: string) => Promise<void>
  onDetachAndDeleteBase: (kbId: string) => Promise<void>
  /**
   * Launches a scan pinned to the base. Resolves null when the foreground
   * path ran (the caller closes this dialog to reveal the chat), else the
   * background runner's result — `{ ok: false }` is surfaced as the error.
   */
  onStartScan: (
    kbId: string,
    opts: { kind: BackgroundScanKind; focus: string; background: boolean }
  ) => Promise<BackgroundScanStartResult | null>
  onCancelJob: (jobId: string) => void
  onRetryJob: (jobId: string) => void
  /** Blocks both scan paths (skills loading), or null. */
  scanBlockedReason: string | null
  /** Blocks only the foreground path (agent busy), or null. */
  foregroundBlockedReason: string | null
  onClose: () => void
}

type SubDialog =
  | { kind: 'new' }
  | { kind: 'rename' }
  | { kind: 'link'; candidates: KnowledgeBaseSummary[] }
  | { kind: 'monorepo' }
  | { kind: 'scan'; initialScope: BackgroundScanKind }
  | { kind: 'detach' }
  | { kind: 'confirm-unlink' }
  | { kind: 'confirm-delete' }

/** Coarse "started 4m ago" age; minutes then hours, never seconds. */
function agoLabel(at: number): string {
  const minutes = Math.max(1, Math.floor((Date.now() - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/**
 * The Knowledge tab's "Manage" surface, presented as a mapping view: a rail
 * of code→schema mappings (solo bases, monorepo clusters, and an Unmapped
 * section), and a detail pane with the selected base's scan state, its code
 * path and schemas as two joined cards, and its knowledge footer. All base
 * lifecycle (create / link / monorepo / rename / unlink / delete) and the
 * codebase attachment flows live here.
 */
export function ManageKnowledgeDialog({
  target,
  groups,
  links,
  allBases,
  connNames,
  schemaOptions,
  repoStatuses,
  jobs,
  schemaTableCounts,
  initialKbId,
  onSelectBase,
  onAttachCodebase,
  onDetachCodebase,
  onDetachAndDeleteBase,
  onStartScan,
  onCancelJob,
  onRetryJob,
  scanBlockedReason,
  foregroundBlockedReason,
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
  /** Schemas card flipped to the checkbox link editor. */
  const [editLinks, setEditLinks] = useState(false)
  /** The rail-footer "New mapping…" menu or the footer ••• menu, when open. */
  const [menu, setMenu] = useState<'new' | 'kebab' | null>(null)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)

  // Groups are live (structure pushes reload them, including changes made from
  // the tree submenu while this dialog is open) — keep the selection valid.
  useEffect(() => {
    setSelectedKbId((current) =>
      current && groups.some((g) => g.base.id === current) ? current : (groups[0]?.base.id ?? null)
    )
  }, [groups])

  // The link editor and menus are per-selection UI; changing bases resets them.
  useEffect(() => {
    setEditLinks(false)
    setMenu(null)
  }, [selectedKbId])

  const selectedGroup = useMemo(
    () => groups.find((g) => g.base.id === selectedKbId) ?? null,
    [groups, selectedKbId]
  )

  // Sub-dialogs and menus register their own Escape handlers, so this one is
  // inactive while either is up: one Escape must close only the topmost layer.
  useEscapeKey(!subDialog && !attaching && !menu, onClose)
  useEscapeKey(!!menu, () => setMenu(null))

  // An open menu dismisses on any pointerdown outside its wrap (its trigger
  // button is inside the wrap, so its own toggle still works).
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      const at = event.target as Node | null
      if (at && menuWrapRef.current?.contains(at)) return
      setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menu])

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

  // --- Background scan state per base -----------------------------------------

  /** This target's jobs only — a base may also be scanning for another target. */
  const targetJobs = useMemo(
    () =>
      jobs.filter(
        (j) => j.target.connId === target.connId && j.target.database === target.database
      ),
    [jobs, target.connId, target.database]
  )

  const activeJobFor = useCallback(
    (kbId: string): BackgroundAgentJob | null =>
      targetJobs.find((j) => j.kbId === kbId && j.status === 'running') ??
      targetJobs.find((j) => j.kbId === kbId && j.status === 'queued') ??
      null,
    [targetJobs]
  )

  const lastJobFor = useCallback(
    (kbId: string): BackgroundAgentJob | null =>
      targetJobs
        .filter((j) => j.kbId === kbId && (j.status === 'done' || j.status === 'failed'))
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0] ?? null,
    [targetJobs]
  )

  /** Codebase attached but no agent-written records and no scan under way. */
  const neverScannedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const g of groups) {
      const root = repoStatuses[g.base.id]?.root ?? g.base.repoRoot
      if (!root) continue
      if (g.records.some((r) => r.source === 'agent')) continue
      if (activeJobFor(g.base.id)) continue
      ids.add(g.base.id)
    }
    return ids
  }, [groups, repoStatuses, activeJobFor])

  const railSections = useMemo(
    () =>
      buildRailSections({
        groups,
        allBases,
        links,
        connNames,
        target: { connId: target.connId, database: target.database },
        schemaOptions,
        neverScannedIds
      }),
    [
      groups,
      allBases,
      links,
      connNames,
      target.connId,
      target.database,
      schemaOptions,
      neverScannedIds
    ]
  )

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

  // --- Selected-base derivations for the detail pane ---------------------------

  const activeJob = selectedKbId ? activeJobFor(selectedKbId) : null
  const lastJob = selectedKbId ? lastJobFor(selectedKbId) : null
  const neverScanned = !!selectedKbId && neverScannedIds.has(selectedKbId)

  /** Linked schema scopes of the selected base (legacy link = empty). */
  const linkedScopes = useMemo(
    () =>
      selectedGroup ? selectedGroup.links.map((l) => l.schema).filter((s): s is string => !!s) : [],
    [selectedGroup]
  )

  /** Relation count per schema, case-insensitive against the introspection. */
  const tableCountFor = useMemo(() => {
    const lower = new Map(
      Object.entries(schemaTableCounts).map(([name, n]) => [name.toLowerCase(), n])
    )
    return (schema: string): number | null => lower.get(schema.toLowerCase()) ?? null
  }, [schemaTableCounts])

  /** Schemas of this database covered by *other* bases, for the coverage line. */
  const otherCoveredCount = useMemo(() => {
    if (!selectedGroup) return 0
    const mine = new Set(linkedScopes.map((s) => s.toLowerCase()))
    return schemaOptions.filter(
      (s) =>
        !mine.has(s.toLowerCase()) &&
        groups.some(
          (g) =>
            g.base.id !== selectedGroup.base.id &&
            g.links.some((l) => (l.schema ?? '').toLowerCase() === s.toLowerCase())
        )
    ).length
  }, [selectedGroup, linkedScopes, schemaOptions, groups])

  const scanBlocked = !repoRoot
    ? 'Attach a codebase first'
    : activeJob
      ? 'A scan for this base is already running or queued'
      : (scanBlockedReason ?? null)

  const openScanDialog = useCallback((): void => {
    setSubDialog({ kind: 'scan', initialScope: 'full' })
  }, [])

  // --- Detail-pane pieces -------------------------------------------------------

  const renderBanner = (): ReactElement | null => {
    if (activeJob?.status === 'running') {
      const startedAgo = activeJob.startedAt ? `${agoLabel(activeJob.startedAt)} ago` : 'just now'
      return (
        <div className="manage-kb__banner manage-kb__banner--running">
          <div className="manage-kb__banner-row">
            <span className="spinner spinner--xs" aria-hidden="true" />
            <div className="manage-kb__banner-body">
              <div className="manage-kb__banner-title">
                Background scan running · {activeJob.percent}%
              </div>
              <div className="manage-kb__banner-sub">
                {activeJob.filesRead} of {activeJob.filesTotal ?? '?'} files ·{' '}
                {activeJob.recordsWritten} records written · started {startedAgo}
              </div>
            </div>
            <button
              type="button"
              className="manage-kb__btn"
              onClick={() => onCancelJob(activeJob.id)}
            >
              Cancel
            </button>
          </div>
          <div className="manage-kb__banner-rail" aria-hidden="true">
            <div
              className="manage-kb__banner-rail-fill"
              style={{ width: `${activeJob.percent}%` }}
            />
          </div>
        </div>
      )
    }
    if (activeJob?.status === 'queued') {
      return (
        <div className="manage-kb__banner manage-kb__banner--queued">
          <div className="manage-kb__banner-row">
            <span className="manage-kb__hollow" aria-hidden="true" />
            <div className="manage-kb__banner-body">
              <div className="manage-kb__banner-title">Scan queued</div>
              <div className="manage-kb__banner-sub">Starts when a slot frees up</div>
            </div>
            <button
              type="button"
              className="manage-kb__btn"
              onClick={() => onCancelJob(activeJob.id)}
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }
    if (lastJob?.status === 'failed') {
      return (
        <div className="manage-kb__banner manage-kb__banner--failed">
          <div className="manage-kb__banner-row">
            <span className="manage-kb__disc manage-kb__disc--failed" aria-hidden="true">
              <CloseIcon size={8} />
            </span>
            <div className="manage-kb__banner-body">
              <div className="manage-kb__banner-title">Scan failed</div>
              <div
                className="manage-kb__banner-sub manage-kb__banner-sub--failed"
                title={lastJob.error ?? undefined}
              >
                {lastJob.error ?? 'Unknown error'}
              </div>
            </div>
            <button type="button" className="manage-kb__btn" onClick={() => onRetryJob(lastJob.id)}>
              Retry
            </button>
          </div>
        </div>
      )
    }
    if (neverScanned) {
      return (
        <div className="manage-kb__banner manage-kb__banner--muted">
          <div className="manage-kb__banner-row">
            <div className="manage-kb__banner-body">
              <div className="manage-kb__banner-title manage-kb__banner-title--muted">
                Not scanned yet
              </div>
              <div className="manage-kb__banner-sub">
                Run a scan to teach the agent this codebase.
              </div>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={!!scanBlocked}
              title={scanBlocked ?? undefined}
              onClick={openScanDialog}
            >
              Scan…
            </button>
          </div>
        </div>
      )
    }
    return null
  }

  const renderCodePathCard = (group: KnowledgeTargetGroup): ReactElement => {
    const sub = group.base.subPath ?? null
    // For a monorepo base the card names the service folder, not the repo.
    const title = sub ? (sub.split('/').filter(Boolean).pop() ?? sub) : repoName
    return (
      <div className="manage-kb__card">
        <div className="manage-kb__card-head">
          <span className="manage-kb__card-label">Code path</span>
        </div>
        <div className="manage-kb__card-body">
          {repoRoot ? (
            <>
              <div className="manage-kb__card-title">
                <FolderIcon size={13} />
                {title}
              </div>
              <div className="manage-kb__card-path" title={repoRoot}>
                {repoRoot}
              </div>
              {sub && (
                <div className="manage-kb__repo-sub">
                  Monorepo folder <strong>{sub}</strong>
                  {group.base.repoRoot && <> of {repoRootName(group.base.repoRoot)}</>} — repo tools
                  and scans see only this folder.
                </div>
              )}
              <div className="manage-kb__chips">
                {status?.commit && (
                  <span className="manage-kb__chip manage-kb__chip--mono">{status.commit}</span>
                )}
                <span className="manage-kb__chip">{sub ?? 'whole repo'}</span>
              </div>
              <div className="manage-kb__row-actions">
                <button
                  type="button"
                  className="manage-kb__btn"
                  disabled={attaching}
                  title={
                    sub
                      ? 'Pick a different directory (replaces the monorepo folder scope)'
                      : 'Pick a different codebase directory for this base'
                  }
                  onClick={() => void attach()}
                >
                  {attaching && <span className="spinner spinner--xs" />}
                  Change…
                </button>
                <button
                  type="button"
                  className="manage-kb__btn"
                  disabled={attaching}
                  title="Detach the codebase, keeping or deleting the knowledge base"
                  onClick={() => setSubDialog({ kind: 'detach' })}
                >
                  Detach…
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="manage-kb__attach-drop"
              disabled={attaching}
              title="Attach a local codebase to this base"
              onClick={() => void attach()}
            >
              {attaching && <span className="spinner spinner--xs" />}+ Attach codebase…
            </button>
          )}
        </div>
      </div>
    )
  }

  const renderSchemasCard = (group: KnowledgeTargetGroup): ReactElement => {
    const scopeList = linkedScopes.join(', ')
    return (
      <div className="manage-kb__card">
        <div className="manage-kb__card-head">
          <span className="manage-kb__card-label">Schemas in {target.database}</span>
          <span className="manage-kb__card-head-spacer" />
          <button
            type="button"
            className="manage-kb__chip-btn"
            onClick={() => setEditLinks((open) => !open)}
          >
            {editLinks ? 'Done' : 'Edit links…'}
          </button>
        </div>
        <div className="manage-kb__card-body">
          {editLinks ? (
            schemaRows.length === 0 ? (
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
            )
          ) : (
            <>
              <div className="manage-kb__schema-chips">
                {group.links.map((link) =>
                  link.schema === undefined ? (
                    <span
                      key={link.id}
                      className="manage-kb__schema-chip manage-kb__schema-chip--faint"
                      title="Legacy database-wide link"
                    >
                      entire database
                    </span>
                  ) : (
                    <span key={link.id} className="manage-kb__schema-chip" title={link.schema}>
                      {link.schema}
                      {tableCountFor(link.schema) !== null && (
                        <span className="manage-kb__schema-chip-count">
                          {tableCountFor(link.schema)} tables
                        </span>
                      )}
                    </span>
                  )
                )}
                <button
                  type="button"
                  className="manage-kb__add-chip"
                  onClick={() => setEditLinks(true)}
                >
                  + add schema
                </button>
              </div>
              {linkedScopes.length > 0 && (
                <div className="manage-kb__coverage">
                  Records written here answer questions about the {scopeList} schema
                  {linkedScopes.length === 1 ? '' : 's'} only.
                  {otherCoveredCount > 0 && (
                    <>
                      {' '}
                      {otherCoveredCount} other schema{otherCoveredCount === 1 ? '' : 's'} in{' '}
                      {target.database} {otherCoveredCount === 1 ? 'is' : 'are'} covered by other
                      bases.
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  const renderKnowledgeFooter = (group: KnowledgeTargetGroup): ReactElement => (
    <div className="manage-kb__kfooter">
      <div className="manage-kb__kfooter-info">
        <div className="manage-kb__card-label">Knowledge</div>
        <div className="manage-kb__kfooter-sub">
          {group.records.length} record{group.records.length === 1 ? '' : 's'}
          {lastJob?.status === 'done' && <> · last scan added {lastJob.recordsWritten}</>}
          {' · '}
          <button
            type="button"
            className="manage-kb__kfooter-link"
            onClick={() => {
              onSelectBase(group.base.id)
              onClose()
            }}
          >
            view in panel
          </button>
        </div>
      </div>
      <button
        type="button"
        className="manage-kb__btn"
        disabled={!!scanBlocked}
        title={scanBlocked ?? 'Scan the attached codebase into this base'}
        onClick={openScanDialog}
      >
        <SearchIcon size={12} />
        {neverScanned ? 'Scan…' : 'Scan again…'}
      </button>
      <div className="manage-kb__menu-wrap" ref={menu === 'kebab' ? menuWrapRef : undefined}>
        <button
          type="button"
          className="manage-kb__btn manage-kb__kebab"
          title="Rename, unlink or delete this base"
          aria-haspopup="menu"
          aria-expanded={menu === 'kebab'}
          onClick={() => setMenu((m) => (m === 'kebab' ? null : 'kebab'))}
        >
          <KebabIcon size={14} />
        </button>
        {menu === 'kebab' && (
          <div className="manage-kb__menu" role="menu">
            <button
              type="button"
              className="manage-kb__menu-item"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                setSubDialog({ kind: 'rename' })
              }}
            >
              Rename…
            </button>
            <button
              type="button"
              className="manage-kb__menu-item"
              role="menuitem"
              title="Remove this database's links; the base and its records are kept"
              onClick={() => {
                setMenu(null)
                setSubDialog({ kind: 'confirm-unlink' })
              }}
            >
              Unlink from this database…
            </button>
            <button
              type="button"
              className="manage-kb__menu-item manage-kb__menu-item--danger"
              role="menuitem"
              title="Permanently delete the base and all of its records, everywhere it is linked"
              onClick={() => {
                setMenu(null)
                setSubDialog({ kind: 'confirm-delete' })
              }}
            >
              Delete base…
            </button>
          </div>
        )}
      </div>
    </div>
  )

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
            <div className="manage-kb__rail">
              <div className="manage-kb__rail-items">
                {railSections.map((section) => (
                  <div key={section.header}>
                    <div className="manage-kb__rail-header" title={section.header}>
                      {section.header}
                    </div>
                    {section.items.map((item) =>
                      item.kind === 'base' ? (
                        <button
                          key={item.group.base.id}
                          type="button"
                          className={`manage-kb__rail-item${
                            item.group.base.id === selectedKbId ? ' is-selected' : ''
                          }`}
                          onClick={() => setSelectedKbId(item.group.base.id)}
                        >
                          <span
                            className={`manage-kb__rail-bar${
                              item.group.base.id === selectedKbId
                                ? ' manage-kb__rail-bar--selected'
                                : item.monorepo
                                  ? ' manage-kb__rail-bar--mono'
                                  : ''
                            }`}
                            aria-hidden="true"
                          />
                          <span className="manage-kb__rail-text">
                            <span className="manage-kb__rail-name" title={item.group.base.name}>
                              {item.label}
                            </span>
                            <span
                              className={`manage-kb__rail-map${
                                item.neverScanned ? ' manage-kb__rail-map--warn' : ''
                              }`}
                              title={item.mappingTitle}
                            >
                              {item.mappingLabel}
                              {item.neverScanned && ' · never scanned'}
                            </span>
                          </span>
                          {(() => {
                            const job = activeJobFor(item.group.base.id)
                            if (!job) return null
                            return job.status === 'running' ? (
                              <span className="manage-kb__rail-live">● scan</span>
                            ) : (
                              <span className="manage-kb__rail-live manage-kb__rail-live--queued">
                                queued
                              </span>
                            )
                          })()}
                        </button>
                      ) : (
                        <div
                          key={`${item.label}·${item.sublabel}`}
                          className="manage-kb__rail-item manage-kb__rail-item--inert"
                          title={item.title}
                        >
                          <span className="manage-kb__rail-bar" aria-hidden="true" />
                          <span className="manage-kb__rail-text">
                            <span className="manage-kb__rail-name">{item.label}</span>
                            <span className="manage-kb__rail-map">{item.sublabel}</span>
                          </span>
                        </div>
                      )
                    )}
                  </div>
                ))}
                {groups.length === 0 && (
                  <div className="manage-kb__list-empty">
                    No knowledge bases are linked to this database yet.
                  </div>
                )}
              </div>
              <div
                className="manage-kb__rail-foot manage-kb__menu-wrap"
                ref={menu === 'new' ? menuWrapRef : undefined}
              >
                <button
                  type="button"
                  className="manage-kb__new-btn"
                  aria-haspopup="menu"
                  aria-expanded={menu === 'new'}
                  onClick={() => setMenu((m) => (m === 'new' ? null : 'new'))}
                >
                  <PlusThinIcon size={11} />
                  New mapping…
                </button>
                {menu === 'new' && (
                  <div className="manage-kb__menu manage-kb__menu--rail" role="menu">
                    <button
                      type="button"
                      className="manage-kb__menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null)
                        setSubDialog({ kind: 'new' })
                      }}
                    >
                      New base…
                    </button>
                    <button
                      type="button"
                      className="manage-kb__menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null)
                        void openLinkDialog()
                      }}
                    >
                      Link existing base…
                    </button>
                    <button
                      type="button"
                      className="manage-kb__menu-item"
                      role="menuitem"
                      title="Map service folders of one repository to the schemas they own"
                      onClick={() => {
                        setMenu(null)
                        setSubDialog({ kind: 'monorepo' })
                      }}
                    >
                      Set up monorepo…
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="manage-kb__detail">
              {selectedGroup ? (
                <>
                  {renderBanner()}
                  <div className="manage-kb__grid">
                    {renderCodePathCard(selectedGroup)}
                    <div className="manage-kb__arrow" aria-hidden="true">
                      <span className="manage-kb__arrow-line" />
                      <span className="manage-kb__arrow-glyph">→</span>
                      <span className="manage-kb__arrow-line" />
                    </div>
                    {renderSchemasCard(selectedGroup)}
                  </div>
                  {renderKnowledgeFooter(selectedGroup)}
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
              <div className="manage-kb__footer-hint">
                Rename, unlink and delete live in the ••• menu of the mapping.
              </div>
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
      {subDialog?.kind === 'scan' && selectedGroup && (
        <ScanDialog
          targetLabel={targetLabel}
          repoName={repoName}
          initialScope={subDialog.initialScope}
          foregroundBlockedReason={foregroundBlockedReason}
          onClose={() => setSubDialog(null)}
          onStart={(opts) => {
            const kbId = selectedGroup.base.id
            setError(null)
            // Close either way: a rejected launch reports in the footer, which
            // the scan dialog's overlay would hide. The foreground path takes
            // this dialog down with it.
            setSubDialog(null)
            void onStartScan(kbId, opts).then((result) => {
              if (result && !result.ok) setError(result.error)
            })
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
            {linkedScopes.length > 0 && (
              <>
                {' '}
                (schema{linkedScopes.length === 1 ? '' : 's'}{' '}
                <strong>{linkedScopes.join(', ')}</strong>)
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
