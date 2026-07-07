import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'

import type { AgentContextItem } from '../../../shared/agent'
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
import { flattenTree } from './flatten'
import { findNode } from './treeData'
import type { NodeKind, TreeNode } from './types'
import type { ConnectionState } from './useConnectionState'

/** Design props baked to their defaults (see the DB Desk sketch). */
const ROW_HEIGHT = 24 // compact
const SHOW_STATUS_DOTS = true

/** Categories fall through with no prefix, so the footer shows just their label. */
const KIND_NAMES: Partial<Record<NodeKind, string>> = {
  connection: 'Connection',
  database: 'Database',
  schema: 'Schema',
  table: 'Table',
  view: 'View',
  matview: 'Materialized View',
  index: 'Index',
  function: 'Function',
  sequence: 'Sequence',
  type: 'Data Type',
  aggregate: 'Aggregate',
  column: 'Column'
}

interface ConnectionPanelProps {
  state: ConnectionState
  onNewQueryFile?: (connId: string, database: string) => void
  /** Attach a schema/table/view to the AI agent thread as a context chip. */
  onAddToAgentThread?: (item: AgentContextItem) => void
  /** Report the selected node + object count up to the app status bar. */
  onStatus?: (sel: string, count: string) => void
}

/** Tree kinds that can ride along to the agent thread as context chips. */
const AGENT_CONTEXT_KINDS = new Set<NodeKind>(['schema', 'table', 'view', 'matview'])

type MenuKind = 'connection' | 'database' | 'schema' | 'table' | 'view' | 'matview'

interface MenuState {
  x: number
  y: number
  nodeId: string
  nodeKind: MenuKind
}

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
  onAddToAgentThread,
  onStatus
}: ConnectionPanelProps): ReactElement {
  const rows = useMemo(
    () => flattenTree(state.tree, { expanded: state.expanded, filter: state.filter }),
    [state.tree, state.expanded, state.filter]
  )

  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuNode = menu ? findNode(menu.nodeId, state.tree) : null
  const menuContextItem = menuNode ? contextItemFor(menuNode) : null

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

  let selText = 'No selection'
  if (state.selectedNode) {
    const kindName = KIND_NAMES[state.selectedNode.kind]
    selText = kindName
      ? `${kindName}  ·  ${state.selectedNode.label}`
      : state.selectedNode.label
  }
  const rowCountText = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`

  useEffect(() => {
    onStatus?.(selText, rowCountText)
  }, [selText, rowCountText, onStatus])

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
            onRowClick={state.toggleRow}
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

    </section>
  )
}
