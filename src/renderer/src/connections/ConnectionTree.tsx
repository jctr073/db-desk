import type { MouseEvent, ReactElement } from 'react'

import { TreeRow } from './TreeRow'
import type { FlatRow, TreeMode, TreeNode } from './types'

interface ConnectionTreeProps {
  rows: FlatRow[]
  selected: string | null
  mode: TreeMode
  rowHeight: number
  showStatusDots: boolean
  onRowClick: (id: string, expandable: boolean) => void
  onRowContextMenu: (node: TreeNode, event: MouseEvent<HTMLDivElement>) => void
}

export function ConnectionTree({
  rows,
  selected,
  mode,
  rowHeight,
  showStatusDots,
  onRowClick,
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
          onClick={() => onRowClick(row.node.id, row.expandable)}
          onContextMenu={(event) => onRowContextMenu(row.node, event)}
        />
      ))}
    </div>
  )
}
