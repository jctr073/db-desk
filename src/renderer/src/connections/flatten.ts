import type { FlatRow, TreeNode } from './types'

export interface FlattenOptions {
  expanded: Record<string, boolean>
  filter: string
}

/**
 * Flatten the tree into the ordered list of currently visible rows.
 *
 * When a filter is active, every node that matches (plus its ancestors) is
 * force-expanded and only matching branches are kept; otherwise visibility is
 * driven by the `expanded` map.
 */
export function flattenTree(tree: TreeNode[], options: FlattenOptions): FlatRow[] {
  const filter = options.filter.trim().toLowerCase()
  const filterActive = filter.length > 0

  let keep: Set<string> | null = null
  if (filterActive) {
    keep = new Set<string>()
    const walk = (nodes: TreeNode[], ancestors: string[]): void => {
      for (const node of nodes) {
        if (node.label.toLowerCase().includes(filter)) {
          keep!.add(node.id)
          for (const ancestor of ancestors) keep!.add(ancestor)
        }
        if (node.children) walk(node.children, ancestors.concat(node.id))
      }
    }
    walk(tree, [])
  }

  const isExpanded = (node: TreeNode): boolean =>
    filterActive ? !!keep && keep.has(node.id) : !!options.expanded[node.id]

  const rows: FlatRow[] = []
  const push = (node: TreeNode, depth: number): void => {
    const expandable = !!(node.children && node.children.length) || !!node.lazy
    const expanded = isExpanded(node)
    rows.push({ node, depth, expandable, expanded })

    if (expandable && expanded && node.children) {
      for (const child of node.children) {
        if (!filterActive || (keep && keep.has(child.id))) push(child, depth + 1)
      }
    }
  }

  for (const node of tree) {
    if (!filterActive || (keep && keep.has(node.id))) push(node, 0)
  }

  return rows
}
