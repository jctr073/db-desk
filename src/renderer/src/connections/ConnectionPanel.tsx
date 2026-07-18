import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactElement } from 'react'

import type { AgentDbObjectItem } from '../../../shared/agent'
import type { ColumnRef, KnowledgeBaseSummary, KnowledgeLink } from '../../../shared/knowledge'
import { BaseNameDialog } from '../components/BaseNameDialog'
import { formatRef } from '../knowledge/format'
import { treeNodeRef, treeSchemaRef } from '../knowledge/treeBadges'
import type { TreeSchemaRef } from '../knowledge/treeBadges'
import {
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  DatabaseIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon
} from '../components/icons'
import type { ConnAccent } from './connColors'
import { ConnectionTree } from './ConnectionTree'
import { ReferencesPopover } from './ReferencesPopover'
import { flattenTree } from './flatten'
import { buildReferenceIndex, columnPeers, columnReferences, tableReferences } from './references'
import type { ColumnEndpoint } from './references'
import { findNode } from './treeData'
import type { NodeKind, TreeNode } from './types'
import type { ConnectionState } from './useConnectionState'

/** Design props baked to their defaults (see the DB Desk sketch). */
const ROW_HEIGHT = 24 // compact
const SHOW_STATUS_DOTS = true

interface ConnectionPanelProps {
  state: ConnectionState
  onNewQueryFile?: (connId: string, database: string) => void
  /** Open a full-height, read-only 100-row preview for a relation. */
  onOpenDataPreview?: (item: AgentDbObjectItem) => void
  /** Attach a schema/table/view to the AI agent thread as a context chip. */
  onAddToAgentThread?: (item: AgentDbObjectItem) => void
  /** "Show usages" / "Add annotation…" on a table or column node. */
  onKnowledgeAction?: (
    action: 'usages' | 'annotate',
    connId: string,
    database: string,
    ref: ColumnRef
  ) => void
  /** Ids of nodes that have local knowledge attached (dot badge). */
  knowledgeIds?: Set<string>
  /** Every knowledge base, for the schema node's link/unlink submenu. */
  knowledgeBases?: KnowledgeBaseSummary[]
  /** Every knowledge link, for the submenu's checkmarks. */
  knowledgeLinks?: KnowledgeLink[]
  /** Per-connection accent color for the active card and other-connection rows. */
  accents: Map<string, ConnAccent>
}

/** Tree kinds that can ride along to the agent thread as context chips. */
const AGENT_CONTEXT_KINDS = new Set<NodeKind>(['schema', 'table', 'view', 'matview'])

/** Tree kinds the knowledge actions (usages/annotation) apply to. */
const KNOWLEDGE_KINDS = new Set<NodeKind>(['table', 'view', 'matview', 'column'])

type MenuKind = 'connection' | 'database' | 'schema' | 'table' | 'view' | 'matview' | 'column'

interface MenuState {
  x: number
  y: number
  nodeId: string
  nodeKind: MenuKind
}

interface RefsViewState {
  x: number
  y: number
  connId: string
  database: string
  ref: ColumnRef
}

const RELATION_KINDS = new Set<NodeKind>(['table', 'view', 'matview'])

/** Build the chip payload for a schema/table/view node from its path-based id. */
function contextItemFor(node: TreeNode): AgentDbObjectItem | null {
  if (!AGENT_CONTEXT_KINDS.has(node.kind)) return null
  // Ids look like "connId/database/schema/category/relation" (see assignIds);
  // database and schema segments use the raw names as keys.
  const segs = node.id.split('/')
  const connId = segs[0] ?? ''
  const database = segs[1] ?? ''
  if (!connId || !database) return null
  if (node.kind === 'schema') {
    return { kind: 'schema', name: node.label, schema: null, database, connId }
  }
  return {
    kind: node.kind as 'table' | 'view' | 'matview',
    name: node.label,
    schema: segs[2] ?? null,
    database,
    connId
  }
}

export function ConnectionPanel({
  state,
  onNewQueryFile,
  onOpenDataPreview,
  onAddToAgentThread,
  onKnowledgeAction,
  knowledgeIds,
  knowledgeBases,
  knowledgeLinks,
  accents
}: ConnectionPanelProps): ReactElement {
  // The active card is open by default; header click toggles it independent
  // of the tree's own expand/collapse state.
  const [cardOpen, setCardOpen] = useState(true)

  const activeNode = useMemo(
    () => findNode(state.activeConnId, state.tree),
    [state.activeConnId, state.tree]
  )

  // Rows for the active connection's body: the connection root is dropped
  // (the card header replaces it) and every depth shifts up by one.
  const activeRows = useMemo(() => {
    if (!activeNode || activeNode.status !== 'online') return []
    return flattenTree([activeNode], {
      expanded: { ...state.expanded, [activeNode.id]: true },
      filter: state.filter
    })
      .slice(1)
      .map((r) => ({ ...r, depth: r.depth - 1 }))
  }, [activeNode, state.expanded, state.filter])

  const otherNodes = useMemo(
    () => state.tree.filter((node) => node.id !== state.activeConnId),
    [state.tree, state.activeConnId]
  )

  // Other connections narrow with the shared filter box, matching on name or host.
  const filteredOtherNodes = useMemo(() => {
    const query = state.filter.trim().toLowerCase()
    if (!query) return otherNodes
    return otherNodes.filter(
      (node) =>
        node.label.toLowerCase().includes(query) ||
        (node.subtitle ?? '').toLowerCase().includes(query)
    )
  }, [otherNodes, state.filter])

  const [menu, setMenu] = useState<MenuState | null>(null)
  // Whether the schema node's "Knowledge bases" submenu is open; reset with
  // every newly opened menu.
  const [kbSubOpen, setKbSubOpen] = useState(false)
  // Schema target for the "New knowledge base…" dialog; null while closed.
  const [newKbFor, setNewKbFor] = useState<TreeSchemaRef | null>(null)
  const menuNode = menu ? findNode(menu.nodeId, state.tree) : null
  const menuContextItem = menuNode ? contextItemFor(menuNode) : null
  const menuRef =
    menuNode && KNOWLEDGE_KINDS.has(menuNode.kind) ? treeNodeRef(menuNode, state.tree) : null
  const menuSchemaRef = menuNode ? treeSchemaRef(menuNode, state.tree) : null

  /** The link attaching this base to the menu's schema target, if any.
   * Names compare case-insensitively (engines fold identifier case). */
  const linkForBase = (kbId: string): KnowledgeLink | undefined => {
    if (!menuSchemaRef) return undefined
    return knowledgeLinks?.find(
      (l) =>
        l.kbId === kbId &&
        l.connId === menuSchemaRef.connId &&
        l.database.toLowerCase() === menuSchemaRef.database.toLowerCase() &&
        (l.schema ?? '').toLowerCase() === menuSchemaRef.schema.toLowerCase()
    )
  }

  /** Toggle a base's link to the menu's schema. The menu stays open so
   * several bases can be toggled in one visit; the checkmarks refresh via
   * the structure-changed push. */
  const toggleSchemaLink = (kbId: string): void => {
    if (!menuSchemaRef) return
    const existing = linkForBase(kbId)
    if (existing) {
      void window.dbDesk.knowledge.removeLink(existing.id)
    } else {
      void window.dbDesk.knowledge.addLink({
        kbId,
        connId: menuSchemaRef.connId,
        database: menuSchemaRef.database,
        schema: menuSchemaRef.schema
      })
    }
  }
  // References only work where introspection carries FK data (Postgres for now).
  const menuRefIsPostgres =
    !!menuRef &&
    state.tree.find((node) => node.id === menuRef.connId)?.connectionType === 'postgres'

  const [refsView, setRefsView] = useState<RefsViewState | null>(null)
  const refsIntro = refsView ? state.schemas[refsView.connId]?.[refsView.database] : undefined
  const refsData = useMemo(() => {
    if (!refsView || !refsIntro) return null
    const index = buildReferenceIndex(refsIntro)
    const { schema, table, column } = refsView.ref
    if (column) {
      const subject = { schema, table, column }
      return {
        lists: columnReferences(index, subject),
        peers: columnPeers(index, refsIntro, subject)
      }
    }
    return { lists: tableReferences(index, schema, table), peers: null }
  }, [refsView, refsIntro])

  /** Reveal and select the tree node for a reference endpoint, closing the popover. */
  const navigateToEndpoint = (endpoint: ColumnEndpoint): void => {
    if (!refsView) return
    const conn = state.tree.find((node) => node.id === refsView.connId)
    const db = conn?.children?.find(
      (node) => node.kind === 'database' && node.label === refsView.database
    )
    const schema = db?.children?.find(
      (node) => node.kind === 'schema' && node.label === endpoint.schema
    )
    for (const category of schema?.children ?? []) {
      const rel = category.children?.find(
        (node) => RELATION_KINDS.has(node.kind) && node.label === endpoint.table
      )
      if (!rel) continue
      const col = rel.children?.find(
        (node) => node.kind === 'column' && node.label === endpoint.column
      )
      state.reveal([conn!.id, db!.id, schema!.id, category.id, rel.id], col?.id ?? rel.id)
      setRefsView(null)
      // Rows render on the next frame; then best-effort scroll to the target.
      const targetId = col?.id ?? rel.id
      window.setTimeout(() => {
        document
          .querySelector(`[data-node-id="${CSS.escape(targetId)}"]`)
          ?.scrollIntoView({ block: 'center' })
      }, 50)
      return
    }
    setRefsView(null)
  }

  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const onRowContextMenu = (node: TreeNode, event: MouseEvent<HTMLDivElement>): void => {
    const isMenuKind =
      node.kind === 'connection' ||
      node.kind === 'database' ||
      node.kind === 'column' ||
      AGENT_CONTEXT_KINDS.has(node.kind)
    if (!isMenuKind) return
    event.preventDefault()
    state.toggleRow(node.id, false)
    setKbSubOpen(false)
    setMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id,
      nodeKind: node.kind as MenuKind
    })
  }

  return (
    <section className="conn-panel">
      <div className="panel-header">
        <span className="panel-header__title">CONNECTIONS</span>
        <div className="panel-header__spacer" />
        <button className="icon-btn" onClick={state.openDialog} title="New connection">
          <PlusIcon />
        </button>
        <button
          className="icon-btn"
          onClick={state.removeSelected}
          disabled={!state.canRemove}
          title="Remove selected connection"
        >
          <MinusIcon />
        </button>
        <button className="icon-btn" onClick={state.collapseAll} title="Collapse all">
          <ChevronUpIcon />
        </button>
      </div>

      <div className="filter-bar">
        <div className="filter-box">
          <SearchIcon />
          <input
            value={state.filter}
            onChange={(event) => state.setFilter(event.target.value)}
            placeholder="Filter connections & objects…"
            aria-label="Filter connections & objects…"
          />
        </div>
      </div>

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

      <div className="tree-scroll">
        {state.tree.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">
              <DatabaseIcon size={34} />
            </div>
            <div className="empty-state__title">No connections</div>
            <div className="empty-state__text">
              Connect to a PostgreSQL database to browse its schema.
            </div>
            <button className="btn-primary" onClick={state.openDialog}>
              New Connection
            </button>
          </div>
        ) : (
          <>
            {activeNode && (
              <div className="conn-active-card">
                <div
                  className="conn-active-card__header"
                  onClick={() => setCardOpen((open) => !open)}
                  onContextMenu={(event) => onRowContextMenu(activeNode, event)}
                >
                  <span className={`conn-active-card__chev${cardOpen ? ' is-open' : ''}`}>
                    <ChevronRightIcon size={11} />
                  </span>
                  <span className="conn-active-card__icon">
                    <DatabaseIcon size={15} />
                  </span>
                  <span className="conn-active-card__name">{activeNode.label}</span>
                  <span className="conn-active-card__host">{activeNode.subtitle ?? ''}</span>
                  <span className="conn-active-card__badge">ACTIVE</span>
                  <span
                    className={`conn-active-card__health is-${activeNode.status ?? 'offline'}`}
                  />
                </div>
                {cardOpen && (
                  <div className="conn-active-card__body">
                    {activeNode.status === 'online' ? (
                      activeRows.length > 0 ? (
                        <ConnectionTree
                          rows={activeRows}
                          selected={state.selected}
                          mode={state.mode}
                          rowHeight={ROW_HEIGHT}
                          showStatusDots={SHOW_STATUS_DOTS}
                          knowledgeIds={knowledgeIds}
                          onRowClick={state.toggleRow}
                          onRowDoubleClick={(node) => {
                            const item = contextItemFor(node)
                            if (item && item.kind !== 'schema') onOpenDataPreview?.(item)
                          }}
                          onRowContextMenu={onRowContextMenu}
                        />
                      ) : (
                        <div className="conn-active-card__empty">No objects match the filter.</div>
                      )
                    ) : (
                      <>
                        <div className="conn-active-card__empty">
                          Not connected — connect to browse objects and run queries.
                        </div>
                        <button
                          className="conn-active-card__connect"
                          disabled={!!activeNode.loading}
                          onClick={() => state.activateConnection(activeNode.id)}
                        >
                          {activeNode.loading ? 'Connecting…' : 'Connect'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {otherNodes.length > 0 && (
        <div className="conn-others">
          <div className="conn-others__header">
            <span className="conn-others__title">
              {activeNode ? 'OTHER CONNECTIONS' : 'CONNECTIONS'}
            </span>
            <span className="conn-others__count">{filteredOtherNodes.length}</span>
            <span className="conn-others__rule" />
          </div>
          <div className="conn-others__rows">
            {filteredOtherNodes.map((node) => (
              <div
                key={node.id}
                className={`conn-other-row${node.loading ? ' is-loading' : ''}`}
                style={{ '--row-accent': accents.get(node.id)?.hex } as CSSProperties}
                title={`Activate ${node.label} — make it the whole-app context`}
                onClick={() => state.activateConnection(node.id)}
                onContextMenu={(event) => onRowContextMenu(node, event)}
              >
                <span className="conn-other-row__bar" />
                <span className="conn-other-row__chev">
                  <ChevronRightIcon size={10} />
                </span>
                <span className="conn-other-row__icon">
                  <DatabaseIcon size={14} />
                </span>
                <span className="conn-other-row__name">{node.label}</span>
                <span className="conn-other-row__host">{node.subtitle ?? ''}</span>
                <span className={`conn-other-row__dot is-${node.status ?? 'offline'}`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {menu && menuNode && (
        <div
          className="ctx-overlay"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu(null)
          }}
        >
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {menuContextItem && (
              <>
                <button
                  className="ctx-menu__item ctx-menu__item--accent"
                  role="menuitem"
                  onClick={() => {
                    onAddToAgentThread?.(menuContextItem)
                    setMenu(null)
                  }}
                >
                  <SparkleIcon size={14} />
                  Add to Agent Thread
                </button>
                <div className="ctx-menu__sep" />
                <button
                  className="ctx-menu__item"
                  role="menuitem"
                  onClick={() => {
                    const qualified = menuContextItem.schema
                      ? `${menuContextItem.schema}.${menuContextItem.name}`
                      : menuContextItem.name
                    void navigator.clipboard.writeText(qualified)
                    setMenu(null)
                  }}
                >
                  Copy name
                </button>
              </>
            )}
            {menuSchemaRef && (
              <>
                <div className="ctx-menu__sep" />
                <div
                  className="ctx-menu__subwrap"
                  onMouseEnter={() => setKbSubOpen(true)}
                  onMouseLeave={() => setKbSubOpen(false)}
                >
                  <button
                    className="ctx-menu__item ctx-menu__item--sub"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={kbSubOpen}
                    onClick={() => setKbSubOpen((open) => !open)}
                  >
                    Knowledge bases
                    <ChevronRightIcon />
                  </button>
                  {kbSubOpen && (
                    <div className="ctx-menu ctx-menu--sub" role="menu">
                      {(knowledgeBases ?? []).map((base) => {
                        const linked = !!linkForBase(base.id)
                        return (
                          <button
                            key={base.id}
                            className="ctx-menu__item ctx-menu__item--check"
                            role="menuitemcheckbox"
                            aria-checked={linked}
                            title={
                              linked
                                ? `Unlink "${base.name}" from schema ${menuSchemaRef.schema}`
                                : `Link "${base.name}" to schema ${menuSchemaRef.schema}`
                            }
                            onClick={() => toggleSchemaLink(base.id)}
                          >
                            <span className="ctx-menu__check">{linked ? '✓' : ''}</span>
                            <span className="ctx-menu__check-label">{base.name}</span>
                          </button>
                        )
                      })}
                      {(knowledgeBases ?? []).length > 0 && <div className="ctx-menu__sep" />}
                      <button
                        className="ctx-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setNewKbFor(menuSchemaRef)
                          setMenu(null)
                        }}
                      >
                        New knowledge base…
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {menuRef && (
              <>
                {menuContextItem && <div className="ctx-menu__sep" />}
                {menuRefIsPostgres && (
                  <button
                    className="ctx-menu__item"
                    role="menuitem"
                    onClick={() => {
                      setRefsView({
                        x: menu.x,
                        y: menu.y,
                        connId: menuRef.connId,
                        database: menuRef.database,
                        ref: menuRef.ref
                      })
                      setMenu(null)
                    }}
                  >
                    View references
                  </button>
                )}
                <button
                  className="ctx-menu__item"
                  role="menuitem"
                  onClick={() => {
                    onKnowledgeAction?.('usages', menuRef.connId, menuRef.database, menuRef.ref)
                    setMenu(null)
                  }}
                >
                  Show knowledge entries
                </button>
                <button
                  className="ctx-menu__item"
                  role="menuitem"
                  onClick={() => {
                    onKnowledgeAction?.('annotate', menuRef.connId, menuRef.database, menuRef.ref)
                    setMenu(null)
                  }}
                >
                  Add annotation…
                </button>
                {menu.nodeKind === 'column' && (
                  <button
                    className="ctx-menu__item"
                    role="menuitem"
                    onClick={() => {
                      void navigator.clipboard.writeText(formatRef(menuRef.ref))
                      setMenu(null)
                    }}
                  >
                    Copy name
                  </button>
                )}
              </>
            )}
            {menu.nodeKind === 'database' && (
              <>
                <button
                  className="ctx-menu__item"
                  role="menuitem"
                  onClick={() => {
                    const connId = menu.nodeId.split('/')[0]
                    onNewQueryFile?.(connId, menuNode.label)
                    setMenu(null)
                  }}
                >
                  New Query File
                </button>
                {state.tree.find((node) => node.id === menu.nodeId.split('/')[0])
                  ?.connectionType === 'databricks' && (
                  <button
                    className="ctx-menu__item"
                    role="menuitem"
                    onClick={() => {
                      state.openManageCatalogs(menu.nodeId.split('/')[0], menuNode.label)
                      setMenu(null)
                    }}
                  >
                    Manage Catalogs and Schemas…
                  </button>
                )}
                <div className="ctx-menu__sep" />
              </>
            )}
            {menu.nodeKind === 'connection' && menuNode.status === 'online' && (
              <>
                <button
                  className="ctx-menu__item"
                  role="menuitem"
                  onClick={() => {
                    onNewQueryFile?.(menu.nodeId, '')
                    setMenu(null)
                  }}
                >
                  New Query File
                </button>
                <div className="ctx-menu__sep" />
              </>
            )}
            {menu.nodeKind === 'connection' && (
              <>
                {menuNode.status === 'online' ? (
                  <>
                    <button
                      className="ctx-menu__item"
                      role="menuitem"
                      onClick={() => {
                        state.refreshConnection(menu.nodeId)
                        setMenu(null)
                      }}
                    >
                      Refresh
                    </button>
                    {menuNode.connectionType === 'databricks' && (
                      <button
                        className="ctx-menu__item"
                        role="menuitem"
                        onClick={() => {
                          state.openManageCatalogs(menu.nodeId)
                          setMenu(null)
                        }}
                      >
                        Manage Catalogs and Schemas…
                      </button>
                    )}
                    <button
                      className="ctx-menu__item"
                      role="menuitem"
                      onClick={() => {
                        state.disconnectConnection(menu.nodeId)
                        setMenu(null)
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    className="ctx-menu__item"
                    role="menuitem"
                    disabled={!!menuNode.loading}
                    onClick={() => {
                      state.connectSaved(menu.nodeId)
                      setMenu(null)
                    }}
                  >
                    Connect
                  </button>
                )}
                <div className="ctx-menu__sep" />
                <button
                  className="ctx-menu__item ctx-menu__item--danger"
                  role="menuitem"
                  onClick={() => {
                    state.removeConnection(menu.nodeId)
                    setMenu(null)
                  }}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {newKbFor && (
        <BaseNameDialog
          title="New Knowledge Base"
          subtitle={`${newKbFor.connName} / ${newKbFor.database} / ${newKbFor.schema}`}
          submitLabel="Create Base"
          onSubmit={async (name) => {
            const base = await window.dbDesk.knowledge.createBase(name)
            await window.dbDesk.knowledge.addLink({
              kbId: base.id,
              connId: newKbFor.connId,
              database: newKbFor.database,
              schema: newKbFor.schema
            })
          }}
          onClose={() => setNewKbFor(null)}
        />
      )}

      {refsView && (
        <ReferencesPopover
          x={refsView.x}
          y={refsView.y}
          title={
            refsView.ref.column
              ? `${refsView.ref.schema}.${refsView.ref.table}.${refsView.ref.column}`
              : `${refsView.ref.schema}.${refsView.ref.table}`
          }
          subjectColumn={refsView.ref.column ?? null}
          lists={refsData?.lists ?? null}
          peers={refsData?.peers ?? null}
          onNavigate={navigateToEndpoint}
          onClose={() => setRefsView(null)}
        />
      )}
    </section>
  )
}
