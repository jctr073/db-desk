/**
 * Bridges the connections tree and the knowledge usage index: which tree
 * nodes carry knowledge (for the subtle dot badge) and how to turn a tree
 * node into a structured ColumnRef for "Show usages" / "Add annotation…".
 * Pure over the tree + index so both are unit-testable.
 */

import { normalizeColumnKey } from '../../../shared/knowledge'
import type { ColumnRef, UsageIndex } from '../../../shared/knowledge'
import type { TreeNode } from '../connections/types'

const RELATION_KINDS = new Set<TreeNode['kind']>(['table', 'view', 'matview'])

/**
 * Ids of tree nodes (relations and columns) that have knowledge attached,
 * for the active knowledge target only. A relation is marked when either the
 * table itself or any of its columns is referenced, so collapsed tables still
 * hint at what's inside. Each node is an O(1) index lookup.
 */
export function knowledgeBadgeIds(
  tree: TreeNode[],
  connId: string,
  database: string,
  index: UsageIndex
): Set<string> {
  const ids = new Set<string>()
  if (index.size === 0) return ids

  const conn = tree.find((node) => node.id === connId)
  const db = conn?.children?.find(
    (node) => node.kind === 'database' && node.label === database
  )
  for (const schema of db?.children ?? []) {
    if (schema.kind !== 'schema') continue
    for (const category of schema.children ?? []) {
      for (const rel of category.children ?? []) {
        if (!RELATION_KINDS.has(rel.kind)) continue
        const relRef: ColumnRef = { schema: schema.label, table: rel.label }
        let marked = index.has(normalizeColumnKey(relRef))
        for (const col of rel.children ?? []) {
          if (col.kind !== 'column') continue
          if (index.has(normalizeColumnKey({ ...relRef, column: col.label }))) {
            ids.add(col.id)
            marked = true
          }
        }
        if (marked) ids.add(rel.id)
      }
    }
  }
  return ids
}

export interface TreeNodeRef {
  connId: string
  database: string
  ref: ColumnRef
}

/** Root-to-node chain (inclusive), located by node identity, or null. */
function nodePath(target: TreeNode, nodes: TreeNode[]): TreeNode[] | null {
  for (const node of nodes) {
    if (node === target) return [node]
    if (node.children) {
      const sub = nodePath(target, node.children)
      if (sub) return [node, ...sub]
    }
  }
  return null
}

/**
 * Structured ref for a relation or column tree node. The names are read from
 * the ancestor chain's raw labels — never parsed out of the slug-based node id,
 * whose segments collide when labels slug identically or contain '/'. The chain
 * is connection / database / schema / category / relation [/ column].
 */
export function treeNodeRef(node: TreeNode, tree: TreeNode[]): TreeNodeRef | null {
  const path = nodePath(node, tree)
  if (!path) return null
  if (RELATION_KINDS.has(node.kind)) {
    if (path.length < 5) return null
    return {
      connId: path[0].id,
      database: path[1].label,
      ref: { schema: path[2].label, table: node.label }
    }
  }
  if (node.kind === 'column') {
    if (path.length < 6) return null
    return {
      connId: path[0].id,
      database: path[1].label,
      ref: {
        schema: path[2].label,
        table: path[path.length - 2].label,
        column: node.label
      }
    }
  }
  return null
}
