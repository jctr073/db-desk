import { memo } from 'react'
import type { MouseEvent, ReactElement } from 'react'

import { KeyIcon, ChevronRightIcon } from '../components/icons'
import { NodeIcon } from './NodeIcon'
import { ENV_BADGE_LABELS } from './types'
import type { TreeMode, TreeNode } from './types'

const CONTAINER_KINDS = new Set<TreeNode['kind']>(['connection', 'database', 'schema', 'category'])

const STATUS_COLOR: Record<string, string> = {
  online: 'var(--green)',
  idle: 'var(--amber)',
  error: 'var(--red)',
  offline: 'var(--text-faint)'
}

interface TreeRowProps {
  node: TreeNode
  depth: number
  expandable: boolean
  expanded: boolean
  selected: boolean
  mode: TreeMode
  rowHeight: number
  showStatusDots: boolean
  /** Show the knowledge dot: local knowledge is attached to this node. */
  hasKnowledge?: boolean
  onRowClick: (id: string, expandable: boolean) => void
  onRowDoubleClick?: (node: TreeNode) => void
  onRowContextMenu: (node: TreeNode, event: MouseEvent<HTMLDivElement>) => void
}

/**
 * One tree row, memoized: the callbacks take the row's node/id (and are
 * identity-stable in the parent), so filter keystrokes and selection clicks
 * re-render only the rows whose props actually changed. Static styling lives
 * in the `.tree-row*` classes; only per-row values (indent, row height,
 * status color) stay inline.
 */
export const TreeRow = memo(function TreeRow({
  node,
  depth,
  expandable,
  expanded,
  selected,
  mode,
  rowHeight,
  showStatusDots,
  hasKnowledge = false,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu
}: TreeRowProps): ReactElement {
  const isContainer = CONTAINER_KINDS.has(node.kind)
  const isCatHeaderB = mode === 'B' && node.kind === 'category'
  const indentPx = 8 + depth * 13

  const guideLefts: number[] = []
  if (mode === 'A') {
    for (let i = 0; i < depth; i++) guideLefts.push(8 + i * 13 + 6.5)
  }

  const iconColor = selected
    ? 'var(--accent-strong)'
    : isContainer
      ? 'var(--text-dim)'
      : 'var(--text-faint)'

  const labelClass = isCatHeaderB
    ? 'tree-row__label--cat'
    : [
        'tree-row__label',
        isContainer ? 'tree-row__label--container' : '',
        node.kind === 'connection' ? 'tree-row__label--connection' : ''
      ]
        .filter(Boolean)
        .join(' ')

  const showSub = mode === 'B' && node.kind === 'connection' && !!node.subtitle

  let rightText = ''
  let rightClass = ''
  if (node.kind === 'connection' && node.loading) {
    rightText = 'Connecting…'
    rightClass = 'tree-row__right'
  } else if (node.kind === 'database' && node.loading) {
    rightText = 'Loading…'
    rightClass = 'tree-row__right'
  } else if (node.kind === 'database' && node.totalSchemaCount != null) {
    // Schema pinning is in effect: show how much of the catalog is loaded.
    rightText = `${node.pinnedSchemaCount ?? 0} of ${node.totalSchemaCount}`
    rightClass = 'tree-row__right'
  } else if (node.kind === 'column') {
    rightText = node.dtype ?? ''
    rightClass = 'tree-row__right tree-row__right--mono'
  } else if (node.kind === 'function') {
    rightText = `→ ${node.returnType ?? 'void'}`
    rightClass = 'tree-row__right tree-row__right--mono'
  } else if (node.kind === 'type') {
    rightText = node.meta ?? ''
    rightClass = 'tree-row__right'
  } else if (node.kind === 'category') {
    rightText = String(node.children?.length ?? 0)
    rightClass =
      mode === 'A'
        ? 'tree-row__right tree-row__right--count-badge'
        : 'tree-row__right tree-row__right--count'
  }

  const showDot = node.kind === 'connection' && showStatusDots && !!node.status
  const dotColor = node.status ? (STATUS_COLOR[node.status] ?? 'var(--red)') : 'var(--red)'

  const rowClass = [
    'tree-row',
    mode === 'B' ? 'tree-row--mode-b' : '',
    showSub ? 'tree-row--sub' : '',
    isCatHeaderB ? 'tree-row--cat-b' : '',
    selected ? 'is-selected' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      data-node-id={node.id}
      className={rowClass}
      style={{
        minHeight: rowHeight,
        height: showSub ? 'auto' : rowHeight,
        paddingLeft: indentPx
      }}
      onClick={(event) => {
        // A double-click also emits two click events. Keep the first click's
        // normal selection/expansion behavior without immediately undoing it.
        if (event.detail === 1) onRowClick(node.id, expandable)
      }}
      onDoubleClick={onRowDoubleClick && (() => onRowDoubleClick(node))}
      onContextMenu={(event) => onRowContextMenu(node, event)}
    >
      {guideLefts.map((left, i) => (
        <div key={i} className="tree-row__guide" style={{ left }} />
      ))}
      <span className="tree-row__chev-box" style={{ height: rowHeight }}>
        {expandable && (
          <span className={`tree-row__chev${expanded ? ' is-expanded' : ''}`}>
            <ChevronRightIcon />
          </span>
        )}
      </span>
      {showDot && <span className="tree-row__status-dot" style={{ background: dotColor }} />}
      {!isCatHeaderB && <NodeIcon node={node} color={iconColor} />}
      <span className="tree-row__label-wrap">
        <span className={labelClass}>{node.label}</span>
        {showSub && <span className="tree-row__sub">{node.subtitle}</span>}
      </span>
      {node.kind === 'connection' && node.environment && (
        <span className={`env-badge env-badge--${node.environment}`}>
          {ENV_BADGE_LABELS[node.environment]}
        </span>
      )}
      {hasKnowledge && (
        <span
          title={node.kind === 'schema' ? 'Has linked knowledge bases' : 'Has local knowledge'}
          className="tree-row__knowledge-dot"
        />
      )}
      {node.kind === 'column' && node.badge === 'pk' && (
        <span className="tree-row__pk" title="Primary key">
          <KeyIcon />
        </span>
      )}
      {node.kind === 'column' && node.badge === 'fk' && (
        <span
          className="tree-row__fk"
          title={node.fkRef ? `Foreign key → ${node.fkRef}` : 'Foreign key'}
        >
          FK
        </span>
      )}
      {node.kind === 'column' && node.badge === 'lfk' && (
        <span
          className="tree-row__fk tree-row__fk--inferred"
          title={
            node.fkRef
              ? `Logical foreign key (inferred) → ${node.fkRef}`
              : 'Logical foreign key (inferred)'
          }
        >
          LFK
        </span>
      )}
      {rightText && rightClass && <span className={rightClass}>{rightText}</span>}
    </div>
  )
})
