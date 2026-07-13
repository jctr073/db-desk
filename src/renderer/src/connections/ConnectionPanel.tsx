import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'

import type { AgentContextItem } from '../../../shared/agent'
import type { ColumnRef } from '../../../shared/knowledge'
import { formatRef } from '../knowledge/format'
import { treeNodeRef } from '../knowledge/treeBadges'
import {
  ChevronUpIcon,
  CloseIcon,
  DatabaseIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon
} from '../components/icons'
import { ConnectionTree } from './ConnectionTree'
import { ReferencesPopover } from './ReferencesPopover'
import { flattenTree } from './flatten'
import {
  buildReferenceIndex,
  columnReferences,
  tableReferences
} from './references'
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
  onOpenDataPreview?: (item: AgentContextItem) => void
  /** Attach a schema/table/view to the AI agent thread as a context chip. */
  onAddToAgentThread?: (item: AgentContextItem) => void
  /** "Show usages" / "Add annotation…" on a table or column node. */
  onKnowledgeAction?: (
    action: 'usages' | 'annotate',
    connId: string,
    database: string,
    ref: ColumnRef
  ) => void
  /** Ids of nodes that have local knowledge attached (dot badge). */
  knowledgeIds?: Set<string>
}

/** Tree kinds that can ride along to the agent thread as context chips. */
const AGENT_CONTEXT_KINDS = new Set<NodeKind>(['schema', 'table', 'view', 'matview'])

/** Tree kinds the knowledge actions (usages/annotation) apply to. */
const KNOWLEDGE_KINDS = new Set<NodeKind>(['table', 'view', 'matview', 'column'])

type MenuKind =
  | 'connection'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'matview'
  | 'column'

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
function contextItemFor(node: TreeNode): AgentContextItem | null {
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
  knowledgeIds
}: ConnectionPanelProps): ReactElement {
  const rows = useMemo(
    () => flattenTree(state.tree, { expanded: state.expanded, filter: state.filter }),
    [state.tree, state.expanded, state.filter]
  )

  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuNode = menu ? findNode(menu.nodeId, state.tree) : null
  const menuContextItem = menuNode ? contextItemFor(menuNode) : null
  const menuRef =
    menuNode && KNOWLEDGE_KINDS.has(menuNode.kind)
      ? treeNodeRef(menuNode, state.tree)
      : null
  // References only work where introspection carries FK data (Postgres for now).
  const menuRefIsPostgres =
    !!menuRef &&
    state.tree.find((node) => node.id === menuRef.connId)?.connectionType ===
      'postgres'

  const [refsView, setRefsView] = useState<RefsViewState | null>(null)
  const refsIntro = refsView
    ? state.schemas[refsView.connId]?.[refsView.database]
    : undefined
  const refsLists = useMemo(() => {
    if (!refsView || !refsIntro) return null
    const index = buildReferenceIndex(refsIntro)
    const { schema, table, column } = refsView.ref
    return column
      ? columnReferences(index, { schema, table, column })
      : tableReferences(index, schema, table)
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
      state.reveal(
        [conn!.id, db!.id, schema!.id, category.id, rel.id],
        col?.id ?? rel.id
      )
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
            placeholder="Filter objects…"
            aria-label="Filter objects"
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
          <ConnectionTree
            rows={rows}
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
        )}
      </div>

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
                    onKnowledgeAction?.(
                      'usages',
                      menuRef.connId,
                      menuRef.database,
                      menuRef.ref
                    )
                    setMenu(null)
                  }}
                >
                  Show knowledge entries
                </button>
                <button
                  className="ctx-menu__item"
                  role="menuitem"
                  onClick={() => {
                    onKnowledgeAction?.(
                      'annotate',
                      menuRef.connId,
                      menuRef.database,
                      menuRef.ref
                    )
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
          lists={refsLists}
          onNavigate={navigateToEndpoint}
          onClose={() => setRefsView(null)}
        />
      )}

    </section>
  )
}
