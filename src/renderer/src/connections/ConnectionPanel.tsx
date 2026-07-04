import { useMemo } from 'react'
import type { ReactElement } from 'react'

import {
  ChevronUpIcon,
  CloseIcon,
  DatabaseIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon
} from '../components/icons'
import { ConnectionTree } from './ConnectionTree'
import { flattenTree } from './flatten'
import type { NodeKind } from './types'
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
}

export function ConnectionPanel({ state }: ConnectionPanelProps): ReactElement {
  const rows = useMemo(
    () => flattenTree(state.tree, { expanded: state.expanded, filter: state.filter }),
    [state.tree, state.expanded, state.filter]
  )

  let selText = 'No selection'
  if (state.selectedNode) {
    const kindName = KIND_NAMES[state.selectedNode.kind]
    selText = kindName
      ? `${kindName}  ·  ${state.selectedNode.label}`
      : state.selectedNode.label
  }
  const rowCountText = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`

  return (
    <section className="conn-panel">
      <div className="panel-header">
        <span className="panel-header__title">CONNECTIONS</span>
        <div className="panel-header__spacer" />
        <div className="seg" title="Tree style">
          <button
            className={`seg__btn${state.mode === 'A' ? ' is-active' : ''}`}
            onClick={() => state.setMode('A')}
            title="Style A — classic with guides"
          >
            A
          </button>
          <button
            className={`seg__btn${state.mode === 'B' ? ' is-active' : ''}`}
            onClick={() => state.setMode('B')}
            title="Style B — grouped rails"
          >
            B
          </button>
        </div>
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
          />
        )}
      </div>

      <div className="tree-footer">
        <span className="tree-footer__sel">{selText}</span>
        <span className="tree-footer__count">{rowCountText}</span>
      </div>
    </section>
  )
}
