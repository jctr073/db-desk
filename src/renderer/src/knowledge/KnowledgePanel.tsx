import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type { DatabaseIntrospection } from '../../../shared/db'
import { lookupUsages } from '../../../shared/knowledge'
import type {
  ColumnRef,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeSource,
  UsageHit
} from '../../../shared/knowledge'
import { CloseIcon, PlusThinIcon, SearchIcon } from '../components/icons'
import { InlineMarkdown } from '../components/MarkdownText'
import type { QueryTarget } from '../components/useQueryRunner'
import {
  KIND_LABELS,
  KIND_ORDER,
  buildRefKeySet,
  danglingRefs,
  formatRef,
  isKnownKind,
  recordSearchText,
  recordTitle,
  summarizeUsage
} from './format'
import { RecordEditor } from './RecordEditor'
import type { KnowledgeNav, KnowledgeState } from './useKnowledgeState'
import { knowledgeTargetKeyOf } from './useKnowledgeState'

interface EditorState {
  record: KnowledgeRecord | null
  kind: KnowledgeKind
  prefillTarget: ColumnRef | null
  /** Monotonic per-editor id, so two different "new" drafts never share a key. */
  seq: number
}

interface KnowledgePanelProps {
  state: KnowledgeState
  targets: QueryTarget[]
  targetKey: string | null
  onTargetKeyChange: (key: string | null) => void
  /** Raw introspection per connection id → database name (dangling checks). */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  ensureSchema: (connId: string, database: string) => void
  /** Pending "Show usages" / "Add annotation…" request from the schema tree. */
  nav: KnowledgeNav | null
  /** Called once `nav` has been acted on, so the parent can clear it (one-shot). */
  onNavConsumed: () => void
  /** Bumped by the tab bar "+" button: open the new-record kind chooser. */
  newSeq: number
  /** Called once `newSeq` has been acted on, so the parent can reset it. */
  onNewConsumed: () => void
  /** Database-scoped controls that belong beside the knowledge target. */
  targetActions?: ReactNode
}

/**
 * Per-database knowledge editor: filterable record list, kind-specific forms,
 * and the "usages of a column" view the schema tree links into.
 */
export function KnowledgePanel({
  state,
  targets,
  targetKey,
  onTargetKeyChange,
  schemas,
  ensureSchema,
  nav,
  onNavConsumed,
  newSeq,
  onNewConsumed,
  targetActions
}: KnowledgePanelProps): ReactElement {
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KnowledgeKind | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<KnowledgeSource | 'all'>(
    'all'
  )
  const [usagesRef, setUsagesRef] = useState<ColumnRef | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)
  const newBtnRef = useRef<HTMLButtonElement | null>(null)
  // Fresh id per opened editor: guarantees a remount when swapping between two
  // different "new" drafts (e.g. a tree-prefilled one and a toolbar one).
  const editorSeq = useRef(0)
  const openEditor = (next: Omit<EditorState, 'seq'>): void =>
    setEditor({ ...next, seq: ++editorSeq.current })

  // Leaving the database resets the view — records and refs don't carry over.
  useEffect(() => {
    setUsagesRef(null)
    setEditor(null)
  }, [state.connId, state.database])

  // Introspection backs the ref pickers and dangling-ref warnings.
  useEffect(() => {
    if (state.connId && state.database)
      ensureSchema(state.connId, state.database)
  }, [state.connId, state.database, ensureSchema])

  // Navigation requests: "Show usages" / "Add annotation…" from the schema
  // tree, or "open record" from a [kb:id] citation chip in the agent
  // transcript. A one-shot — the parent clears `nav` once consumed, so
  // remounting this panel never replays it. The 'record' action may arrive
  // together with a target switch, so it waits until the records for its
  // target have actually loaded before resolving the id (or gives up if the
  // load fails); the ref-based actions carry their payload and act at once.
  useEffect(() => {
    if (!nav) return
    if (nav.action === 'record') {
      if (state.loadedKey !== knowledgeTargetKeyOf(nav.connId, nav.database)) {
        if (state.loadError) onNavConsumed()
        return
      }
      const record = state.records.find((r) => r.id === nav.recordId)
      if (record && isKnownKind(record.kind)) {
        setUsagesRef(null)
        openEditor({ record, kind: record.kind, prefillTarget: null })
      }
      onNavConsumed()
      return
    }
    if (nav.action === 'usages') {
      setEditor(null)
      setUsagesRef(nav.ref)
    } else {
      setUsagesRef(null)
      openEditor({ record: null, kind: 'annotation', prefillTarget: nav.ref })
    }
    onNavConsumed()
  }, [nav, onNavConsumed, state.loadedKey, state.loadError, state.records])

  // Tab bar "+" while this tab is active: open the new-record kind chooser.
  // Also a one-shot; the parent resets `newSeq` once we've opened the menu.
  useEffect(() => {
    if (newSeq === 0) return
    const rect = newBtnRef.current?.getBoundingClientRect()
    setNewMenu(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 60, y: 80 })
    onNewConsumed()
  }, [newSeq, onNewConsumed])

  useEffect(() => {
    if (!newMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setNewMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newMenu])

  const intro =
    state.connId && state.database
      ? schemas[state.connId]?.[state.database]
      : undefined
  const validKeys = useMemo(
    () => (intro ? buildRefKeySet(intro) : null),
    [intro]
  )
  const recordById = useMemo(
    () => new Map(state.records.map((r) => [r.id, r])),
    [state.records]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.records
      .filter((record) => isKnownKind(record.kind))
      .filter((record) => kindFilter === 'all' || record.kind === kindFilter)
      .filter(
        (record) => sourceFilter === 'all' || record.source === sourceFilter
      )
      .filter((record) => !q || recordSearchText(record).includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [state.records, search, kindFilter, sourceFilter])

  const usageGroups = useMemo(() => {
    if (!usagesRef) return []
    const hits = lookupUsages(state.index, usagesRef)
    const groups: Array<{ kind: KnowledgeKind; hits: UsageHit[] }> = []
    for (const kind of KIND_ORDER) {
      const inKind = hits.filter((hit) => hit.kind === kind)
      if (inKind.length > 0) groups.push({ kind, hits: inKind })
    }
    return groups
  }, [usagesRef, state.index])

  const openRecord = (record: KnowledgeRecord): void => {
    if (!isKnownKind(record.kind)) return
    openEditor({ record, kind: record.kind, prefillTarget: null })
  }

  const startNew = (kind: KnowledgeKind): void => {
    setNewMenu(null)
    setUsagesRef(null)
    openEditor({ record: null, kind, prefillTarget: null })
  }

  const saveDraft = async (
    input: Parameters<KnowledgeState['save']>[0]
  ): Promise<void> => {
    const saved = await state.save(input)
    if (saved) setEditor(null)
  }

  const deleteEditing = async (): Promise<void> => {
    if (!editor?.record) return
    const ok = await state.remove(editor.record.id)
    if (ok) setEditor(null)
  }

  const noTarget = !state.connId || !state.database
  const capTarget = targets.find(
    (t) => knowledgeTargetKeyOf(t.connId, t.database) === targetKey
  )

  return (
    <div className="knowledge">
      <div className="chat__target-bar">
        <select
          className="toolbar-select chat__target"
          title="Connection and database this knowledge belongs to"
          value={targetKey ?? ''}
          onChange={(e) => onTargetKeyChange(e.target.value || null)}
          disabled={targets.length === 0}
        >
          {targets.length === 0 && <option value="">No connection</option>}
          {targets.map((t) => (
            <option
              key={knowledgeTargetKeyOf(t.connId, t.database)}
              value={knowledgeTargetKeyOf(t.connId, t.database)}
            >
              {t.connName} / {t.database}
            </option>
          ))}
        </select>
        {targetActions}
        <button
          ref={newBtnRef}
          type="button"
          className="kn-new"
          disabled={noTarget}
          title="New knowledge record"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setNewMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <PlusThinIcon size={12} />
          New
        </button>
      </div>

      {capTarget && (
        <div className="panel-cap">
          KNOWLEDGE · {capTarget.connName} / {capTarget.database}
        </div>
      )}

      {state.loadError && (
        <div className="load-error" role="alert">
          <span className="load-error__text">{state.loadError}</span>
          <button
            className="load-error__close"
            onClick={state.clearLoadError}
            title="Dismiss"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {editor ? (
        <RecordEditor
          key={editor.record?.id ?? `new-${editor.kind}-${editor.seq}`}
          record={editor.record}
          kind={editor.kind}
          prefillTarget={editor.prefillTarget}
          intro={intro}
          validKeys={validKeys}
          onSave={(input) => void saveDraft(input)}
          onDelete={editor.record ? () => void deleteEditing() : null}
          onBack={() => setEditor(null)}
        />
      ) : usagesRef ? (
        <div className="kn-usages">
          <div className="kn-usages__head">
            <button
              type="button"
              className="kn-back"
              onClick={() => setUsagesRef(null)}
            >
              ‹ All records
            </button>
            <span className="kn-usages__title" title={formatRef(usagesRef)}>
              Usages of <code>{formatRef(usagesRef)}</code>
            </span>
          </div>
          <div className="kn-scroll">
            {state.loading && <div className="kn-loading">Loading…</div>}
            {!state.loading && usageGroups.length === 0 && (
              <div className="kn-empty">
                <div className="kn-empty__text">No usages recorded.</div>
                <div className="kn-empty__hint">
                  Annotations, relationships, glossary mappings, exemplars, and
                  notes that reference this{' '}
                  {usagesRef.column ? 'column' : 'table'} will appear here.
                </div>
              </div>
            )}
            {usageGroups.map((group) => (
              <div key={group.kind} className="kn-usage-group">
                <div className="kn-usage-group__header">
                  {KIND_LABELS[group.kind]}
                  {group.hits.length > 1 ? ` · ${group.hits.length}` : ''}
                </div>
                {group.hits.map((hit, i) => {
                  const record = recordById.get(hit.recordId)
                  return (
                    <button
                      key={`${hit.recordId}-${hit.role}-${i}`}
                      type="button"
                      className="kn-usage-hit"
                      title={record ? recordTitle(record) : hit.recordId}
                      onClick={() => record && openRecord(record)}
                    >
                      <span className="kn-usage-hit__summary">
                        <InlineMarkdown
                          text={summarizeUsage(hit, record, usagesRef)}
                        />
                      </span>
                      <span className="kn-usage-hit__role">{hit.role}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="kn-filters">
            <div className="filter-box">
              <SearchIcon />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search knowledge…"
                aria-label="Search knowledge records"
              />
            </div>
            <div className="kn-filters__row">
              <select
                className="toolbar-select kn-filters__select"
                title="Filter by kind"
                value={kindFilter}
                onChange={(e) =>
                  setKindFilter(e.target.value as KnowledgeKind | 'all')
                }
              >
                <option value="all">All kinds</option>
                {KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              <select
                className="toolbar-select kn-filters__select"
                title="Filter by source"
                value={sourceFilter}
                onChange={(e) =>
                  setSourceFilter(e.target.value as KnowledgeSource | 'all')
                }
              >
                <option value="all">All sources</option>
                <option value="human">Human</option>
                <option value="agent">Agent</option>
              </select>
            </div>
          </div>
          <div className="kn-scroll">
            {state.loading && <div className="kn-loading">Loading…</div>}
            {!state.loading && filtered.length === 0 && (
              <div className="kn-empty">
                <div className="kn-empty__text">
                  {state.records.length === 0
                    ? 'No knowledge recorded yet.'
                    : 'No records match the current filters.'}
                </div>
                {state.records.length === 0 && (
                  <div className="kn-empty__hint">
                    Right-click a table or column in the schema tree, click New,
                    or ask the agent to remember a fact about this database.
                  </div>
                )}
              </div>
            )}
            {filtered.map((record) => {
              const dangling = validKeys ? danglingRefs(record, validKeys) : []
              return (
                <button
                  key={record.id}
                  type="button"
                  className="kn-item"
                  onClick={() => openRecord(record)}
                >
                  <span className="kn-item__kind">
                    {KIND_LABELS[record.kind]}
                  </span>
                  <span className="kn-item__title">
                    <InlineMarkdown text={recordTitle(record)} />
                  </span>
                  {dangling.length > 0 && (
                    <span
                      className="kn-badge kn-badge--warn"
                      title={`Missing from the current schema: ${dangling
                        .map(formatRef)
                        .join(', ')}`}
                    >
                      !
                    </span>
                  )}
                  <span className={`kn-badge kn-badge--${record.source}`}>
                    {record.source}
                  </span>
                  {record.confidence && (
                    <span
                      className="kn-badge kn-badge--conf"
                      title="Agent confidence"
                    >
                      {record.confidence}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}

      {newMenu && (
        <div
          className="ctx-overlay"
          onMouseDown={() => setNewMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setNewMenu(null)
          }}
        >
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: newMenu.x, top: newMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {KIND_ORDER.map((kind) => (
              <button
                key={kind}
                className="ctx-menu__item"
                role="menuitem"
                onClick={() => startNew(kind)}
              >
                New {KIND_LABELS[kind].toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
