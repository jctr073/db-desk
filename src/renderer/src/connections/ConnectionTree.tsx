import type { MouseEvent, ReactElement } from 'react'

import { TreeRow } from './TreeRow'
import type { FlatRow, TreeMode, TreeNode } from './types'

interface ConnectionTreeProps {
  rows: FlatRow[]
  selected: string | null
  mode: TreeMode
  rowHeight: number
  showStatusDots: boolean
  /** Ids of nodes that have local knowledge attached (dot badge). */
  knowledgeIds?: Set<string>
  onRowClick: (id: string, expandable: boolean) => void
  onRowDoubleClick?: (node: TreeNode) => void
  onRowContextMenu: (node: TreeNode, event: MouseEvent<HTMLDivElement>) => void
}

export function ConnectionTree({
  rows,
  selected,
  mode,
  rowHeight,
  showStatusDots,
  knowledgeIds,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu
}: ConnectionTreeProps): ReactElement {
  return (
    <div role="tree">
      {rows.map((row) => (
        <TreeRow
          key={row.node.id}
          node={row.node}
          depth={row.depth}
          expandable={row.expandable}
          expanded={row.expanded}
          selected={selected === row.node.id}
          mode={mode}
          rowHeight={rowHeight}
          showStatusDots={showStatusDots}
          hasKnowledge={knowledgeIds?.has(row.node.id) ?? false}
          onClick={() => onRowClick(row.node.id, row.expandable)}
          onDoubleClick={() => onRowDoubleClick?.(row.node)}
          onContextMenu={(event) => onRowContextMenu(row.node, event)}
        />
      ))}
    </div>
  )
}
