import type { CSSProperties, ReactElement } from 'react'

import { KeyIcon, ChevronRightIcon } from '../components/icons'
import { NodeIcon } from './NodeIcon'
import type { TreeMode, TreeNode } from './types'

const CONTAINER_KINDS = new Set<TreeNode['kind']>(['connection', 'database', 'schema', 'category'])

const STATUS_COLOR: Record<string, string> = {
  online: 'var(--green)',
  idle: 'var(--amber)',
  error: 'var(--red)'
}

const labelWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  minWidth: 0,
  flex: '1 1 auto',
  overflow: 'hidden'
}

const subStyle: CSSProperties = {
  fontSize: 10.5,
  lineHeight: 1.2,
  color: 'var(--text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginTop: 1
}

const pkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  color: 'var(--amber)',
  marginLeft: 6,
  flex: '0 0 auto'
}

const fkStyle: CSSProperties = {
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: '.04em',
  color: 'var(--text-faint)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  padding: '0 3px',
  marginLeft: 6,
  lineHeight: '13px',
  flex: '0 0 auto'
}

const monoRight: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: 'var(--text-faint)',
  marginLeft: 8,
  flex: '0 0 auto'
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
  onClick: () => void
}

export function TreeRow({
  node,
  depth,
  expandable,
  expanded,
  selected,
  mode,
  rowHeight,
  showStatusDots,
  onClick
}: TreeRowProps): ReactElement {
  const isContainer = CONTAINER_KINDS.has(node.kind)
  const isCatHeaderB = mode === 'B' && node.kind === 'category'
  const indentPx = 8 + depth * 13

  const guides: CSSProperties[] = []
  if (mode === 'A') {
    for (let i = 0; i < depth; i++) {
      guides.push({
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 8 + i * 13 + 6.5,
        width: 1,
        background: 'var(--border-soft)',
        pointerEvents: 'none'
      })
    }
  }

  const iconColor = selected
    ? 'var(--accent-strong)'
    : isContainer
      ? 'var(--text-dim)'
      : 'var(--text-faint)'

  const labelStyle: CSSProperties = isCatHeaderB
    ? {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textTransform: 'uppercase',
        letterSpacing: '.08em',
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--text-faint)'
      }
    : {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        lineHeight: 1.3,
        fontSize: 13,
        fontWeight: node.kind === 'connection' ? 600 : isContainer ? 500 : 400,
        color: selected ? 'var(--accent-strong)' : isContainer ? 'var(--text)' : 'var(--text-dim)'
      }

  const showSub = mode === 'B' && node.kind === 'connection' && !!node.subtitle

  let rightText = ''
  let rightStyle: CSSProperties | undefined
  if (node.kind === 'column') {
    rightText = node.dtype ?? ''
    rightStyle = monoRight
  } else if (node.kind === 'function') {
    rightText = `→ ${node.returnType ?? 'void'}`
    rightStyle = monoRight
  } else if (node.kind === 'type') {
    rightText = node.meta ?? ''
    rightStyle = { fontSize: 10.5, color: 'var(--text-faint)', marginLeft: 8, flex: '0 0 auto' }
  } else if (node.kind === 'category') {
    rightText = String(node.children?.length ?? 0)
    rightStyle =
      mode === 'A'
        ? {
            fontSize: 10,
            color: 'var(--text-faint)',
            background: 'var(--panel-hi)',
            border: '1px solid var(--border-soft)',
            borderRadius: 8,
            padding: '0 6px',
            marginLeft: 8,
            flex: '0 0 auto',
            lineHeight: '15px'
          }
        : { fontSize: 10, color: 'var(--text-faint)', marginLeft: 8, flex: '0 0 auto' }
  }

  const showDot = node.kind === 'connection' && showStatusDots && !!node.status
  const dotColor = node.status ? (STATUS_COLOR[node.status] ?? 'var(--red)') : 'var(--red)'

  let boxShadow = 'none'
  if (selected) {
    boxShadow =
      mode === 'B'
        ? 'inset 2px 0 0 0 var(--accent), inset 0 0 0 2000px var(--accent-soft)'
        : 'inset 0 0 0 2000px var(--accent-soft)'
  }

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    minHeight: rowHeight,
    height: showSub ? 'auto' : rowHeight,
    paddingTop: showSub ? 4 : 0,
    paddingBottom: showSub ? 4 : 0,
    paddingLeft: indentPx,
    paddingRight: 10,
    position: 'relative',
    cursor: 'pointer',
    userSelect: 'none',
    boxShadow,
    whiteSpace: 'nowrap',
    marginTop: isCatHeaderB ? 3 : 0
  }

  const chevBox: CSSProperties = {
    display: 'inline-flex',
    width: 14,
    minWidth: 14,
    height: rowHeight,
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-faint)'
  }

  const chevStyle: CSSProperties = {
    display: 'inline-flex',
    transition: 'transform .12s ease',
    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
    color: 'var(--text-faint)'
  }

  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      className="tree-row"
      style={rowStyle}
      onClick={onClick}
    >
      {guides.map((g, i) => (
        <div key={i} style={g} />
      ))}
      <span style={chevBox}>
        {expandable && (
          <span style={chevStyle}>
            <ChevronRightIcon />
          </span>
        )}
      </span>
      {showDot && (
        <span
          style={{
            width: 7,
            height: 7,
            minWidth: 7,
            borderRadius: '50%',
            background: dotColor,
            marginRight: 7,
            flex: '0 0 auto',
            boxShadow: '0 0 0 2px var(--panel)'
          }}
        />
      )}
      {!isCatHeaderB && <NodeIcon node={node} color={iconColor} />}
      <span style={labelWrap}>
        <span style={labelStyle}>{node.label}</span>
        {showSub && <span style={subStyle}>{node.subtitle}</span>}
      </span>
      {node.kind === 'column' && node.badge === 'pk' && (
        <span style={pkStyle} title="Primary key">
          <KeyIcon />
        </span>
      )}
      {node.kind === 'column' && node.badge === 'fk' && (
        <span style={fkStyle} title="Foreign key">
          FK
        </span>
      )}
      {rightText && rightStyle && <span style={rightStyle}>{rightText}</span>}
    </div>
  )
}
