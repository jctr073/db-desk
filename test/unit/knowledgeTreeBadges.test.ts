/**
 * Unit tests for the tree ↔ knowledge bridge in
 * src/renderer/src/knowledge/treeBadges.ts: which tree nodes get the
 * knowledge dot (knowledgeBadgeIds) and how relation/column nodes map back to
 * structured ColumnRefs (treeNodeRef). Trees are built with the real
 * treeData helpers so node ids match production (label slugs and all).
 */

import { describe, expect, it } from 'vitest'

import { buildUsageIndex } from '../../src/shared/knowledge'
import type { KnowledgeRecord } from '../../src/shared/knowledge'
import {
  knowledgeBadgeIds,
  treeNodeRef
} from '../../src/renderer/src/knowledge/treeBadges'
import { assignIds, databaseChildren, findNode } from '../../src/renderer/src/connections/treeData'
import type { TreeNode } from '../../src/renderer/src/connections/types'
import type { DatabaseIntrospection } from '../../src/shared/db'

const intro: DatabaseIntrospection = {
  name: 'app_db',
  schemas: [
    {
      name: 'public',
      tables: [
        {
          name: 'Users',
          columns: [
            { name: 'id', dataType: 'int', badge: 'pk' },
            { name: 'Email', dataType: 'text', badge: null }
          ]
        },
        { name: 'orders', columns: [{ name: 'user_id', dataType: 'int', badge: 'fk' }] }
      ],
      views: [],
      matviews: [],
      indexes: [],
      functions: [],
      sequences: [],
      types: [],
      aggregates: []
    }
  ]
}

/** A connected tree with one connection ("c-1") and one database. */
function buildTree(): TreeNode[] {
  const conn: TreeNode = {
    id: '',
    kind: 'connection',
    key: 'c-1',
    label: 'Local',
    status: 'online',
    children: [
      {
        id: '',
        kind: 'database',
        key: 'app_db',
        label: 'app_db',
        children: databaseChildren(intro)
      }
    ]
  }
  assignIds(conn, '')
  return [conn]
}

const envelope = { source: 'human' as const, createdAt: 1, updatedAt: 2 }

describe('knowledgeBadgeIds', () => {
  it('marks columns with hits and their enclosing relation', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-a',
        kind: 'annotation',
        target: { schema: 'public', table: 'users', column: 'email' },
        text: 'PII'
      }
    ]
    const tree = buildTree()
    const ids = knowledgeBadgeIds(tree, 'c-1', 'app_db', buildUsageIndex(records))
    // Labels are "Users"/"Email" but keys are normalized, so the lowercase
    // record ref still matches; ids carry the slugged path segments.
    expect(ids.has('c-1/app_db/public/tables/users/email')).toBe(true)
    expect(ids.has('c-1/app_db/public/tables/users')).toBe(true)
    expect(ids.has('c-1/app_db/public/tables/orders')).toBe(false)
  })

  it('marks a relation for a table-level ref without marking its columns', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-t',
        kind: 'annotation',
        target: { schema: 'public', table: 'orders' },
        text: 'append-only'
      }
    ]
    const ids = knowledgeBadgeIds(buildTree(), 'c-1', 'app_db', buildUsageIndex(records))
    expect(ids.has('c-1/app_db/public/tables/orders')).toBe(true)
    expect(ids.has('c-1/app_db/public/tables/orders/user_id')).toBe(false)
  })

  it('returns nothing for a different connection or database', () => {
    const records: KnowledgeRecord[] = [
      {
        ...envelope,
        id: 'kn-a',
        kind: 'annotation',
        target: { schema: 'public', table: 'users', column: 'email' },
        text: 'PII'
      }
    ]
    const index = buildUsageIndex(records)
    expect(knowledgeBadgeIds(buildTree(), 'c-2', 'app_db', index).size).toBe(0)
    expect(knowledgeBadgeIds(buildTree(), 'c-1', 'other_db', index).size).toBe(0)
    expect(knowledgeBadgeIds(buildTree(), 'c-1', 'app_db', new Map()).size).toBe(0)
  })
})

describe('treeNodeRef', () => {
  it('derives a table ref from a relation node using its label', () => {
    const tree = buildTree()
    const node = findNode('c-1/app_db/public/tables/users', tree)!
    expect(treeNodeRef(node, tree)).toEqual({
      connId: 'c-1',
      database: 'app_db',
      ref: { schema: 'public', table: 'Users' }
    })
  })

  it('derives a column ref, taking the table name from the parent label', () => {
    const tree = buildTree()
    const node = findNode('c-1/app_db/public/tables/users/email', tree)!
    expect(treeNodeRef(node, tree)).toEqual({
      connId: 'c-1',
      database: 'app_db',
      ref: { schema: 'public', table: 'Users', column: 'Email' }
    })
  })

  it('returns null for kinds without a table identity', () => {
    const tree = buildTree()
    const schema = findNode('c-1/app_db/public', tree)!
    expect(treeNodeRef(schema, tree)).toBeNull()
  })

  it('reads names from ancestor labels, not slugged id segments', () => {
    // Two tables slug identically ("order_items"), the database name contains a
    // '/', and the schema label differs from its slug — all cases the old
    // id-parsing approach resolved wrongly.
    const conn: TreeNode = {
      id: '',
      kind: 'connection',
      key: 'c-1',
      label: 'Local',
      status: 'online',
      children: [
        {
          id: '',
          kind: 'database',
          key: 'app_db',
          label: 'App/DB',
          children: [
            {
              id: '',
              kind: 'schema',
              label: 'Sales Data',
              children: [
                {
                  id: '',
                  kind: 'category',
                  key: 'tables',
                  label: 'Tables',
                  children: [
                    {
                      id: '',
                      kind: 'table',
                      label: 'Order Items',
                      children: [{ id: '', kind: 'column', label: 'sku' }]
                    },
                    {
                      id: '',
                      kind: 'table',
                      label: 'Order/Items',
                      children: [{ id: '', kind: 'column', label: 'qty' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    assignIds(conn, '')
    const tree = [conn]
    const category = conn.children![0].children![0].children![0]
    const second = category.children![1] // "Order/Items" — id collides with the first
    expect(treeNodeRef(second, tree)).toEqual({
      connId: 'c-1',
      database: 'App/DB',
      ref: { schema: 'Sales Data', table: 'Order/Items' }
    })
    // The column must attribute to its actual parent, not the slug-collided first table.
    const qty = second.children![0]
    expect(treeNodeRef(qty, tree)).toEqual({
      connId: 'c-1',
      database: 'App/DB',
      ref: { schema: 'Sales Data', table: 'Order/Items', column: 'qty' }
    })
  })
})
