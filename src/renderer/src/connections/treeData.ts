import type { ConnectionForm, TreeNode } from './types'

export function slug(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function column(name: string, dtype: string, badge?: 'pk' | 'fk'): TreeNode {
  return { id: '', kind: 'column', label: name, dtype, badge: badge ?? null }
}

/**
 * A representative `public`-style schema used for every database in the demo
 * tree. Each call returns a fresh object graph so ids can be assigned per path.
 */
function makeSchema(): TreeNode[] {
  return [
    {
      id: '',
      kind: 'category',
      key: 'tables',
      icon: 'table',
      label: 'Tables',
      children: [
        {
          id: '',
          kind: 'table',
          label: 'users',
          children: [
            column('id', 'int8', 'pk'),
            column('org_id', 'int8', 'fk'),
            column('email', 'text'),
            column('full_name', 'text'),
            column('role', 'user_role'),
            column('is_active', 'bool'),
            column('created_at', 'timestamptz'),
            column('updated_at', 'timestamptz')
          ]
        },
        {
          id: '',
          kind: 'table',
          label: 'orders',
          children: [
            column('id', 'int8', 'pk'),
            column('user_id', 'int8', 'fk'),
            column('status', 'order_status'),
            column('total', 'numeric'),
            column('placed_at', 'timestamptz')
          ]
        },
        {
          id: '',
          kind: 'table',
          label: 'order_items',
          children: [
            column('id', 'int8', 'pk'),
            column('order_id', 'int8', 'fk'),
            column('product_id', 'int8', 'fk'),
            column('quantity', 'int4'),
            column('unit_price', 'numeric')
          ]
        },
        {
          id: '',
          kind: 'table',
          label: 'products',
          children: [
            column('id', 'int8', 'pk'),
            column('sku', 'text'),
            column('name', 'text'),
            column('price', 'numeric'),
            column('category_id', 'int8', 'fk')
          ]
        },
        {
          id: '',
          kind: 'table',
          label: 'organizations',
          children: [
            column('id', 'int8', 'pk'),
            column('name', 'text'),
            column('plan', 'text'),
            column('created_at', 'timestamptz')
          ]
        }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'views',
      icon: 'view',
      label: 'Views',
      children: [
        {
          id: '',
          kind: 'view',
          label: 'active_users',
          children: [
            column('user_id', 'int8'),
            column('email', 'text'),
            column('last_seen', 'timestamptz')
          ]
        },
        {
          id: '',
          kind: 'view',
          label: 'pending_orders',
          children: [
            column('order_id', 'int8'),
            column('user_id', 'int8'),
            column('total', 'numeric')
          ]
        },
        {
          id: '',
          kind: 'view',
          label: 'monthly_revenue',
          children: [column('month', 'date'), column('revenue', 'numeric')]
        }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'matviews',
      icon: 'matview',
      label: 'Materialized Views',
      children: [
        {
          id: '',
          kind: 'matview',
          label: 'mv_daily_signups',
          children: [column('day', 'date'), column('signups', 'int8')]
        },
        {
          id: '',
          kind: 'matview',
          label: 'mv_revenue_rollup',
          children: [
            column('month', 'date'),
            column('gross', 'numeric'),
            column('net', 'numeric')
          ]
        }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'indexes',
      icon: 'index',
      label: 'Indexes',
      children: [
        { id: '', kind: 'index', label: 'users_pkey' },
        { id: '', kind: 'index', label: 'users_email_key' },
        { id: '', kind: 'index', label: 'orders_user_id_idx' },
        { id: '', kind: 'index', label: 'orders_status_idx' },
        { id: '', kind: 'index', label: 'products_sku_key' }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'functions',
      icon: 'function',
      label: 'Functions',
      children: [
        { id: '', kind: 'function', label: 'current_org()', returnType: 'int8' },
        {
          id: '',
          kind: 'function',
          label: 'calc_order_total(order_id)',
          returnType: 'numeric'
        },
        {
          id: '',
          kind: 'function',
          label: 'soft_delete_user(uid)',
          returnType: 'void'
        }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'sequences',
      icon: 'sequence',
      label: 'Sequences',
      children: [
        { id: '', kind: 'sequence', label: 'users_id_seq' },
        { id: '', kind: 'sequence', label: 'orders_id_seq' },
        { id: '', kind: 'sequence', label: 'products_id_seq' }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'types',
      icon: 'type',
      label: 'Data Types',
      children: [
        { id: '', kind: 'type', label: 'user_role', meta: 'enum' },
        { id: '', kind: 'type', label: 'order_status', meta: 'enum' },
        { id: '', kind: 'type', label: 'address', meta: 'composite' }
      ]
    },
    {
      id: '',
      kind: 'category',
      key: 'aggregates',
      icon: 'aggregate',
      label: 'Aggregate Functions',
      children: [
        { id: '', kind: 'aggregate', label: 'median(numeric)' },
        { id: '', kind: 'aggregate', label: 'mode(anyelement)' },
        { id: '', kind: 'aggregate', label: 'first(anyelement)' }
      ]
    }
  ]
}

/** A database whose single `public` schema uses the representative schema. */
function schemaDb(key: string): TreeNode {
  return {
    id: '',
    kind: 'database',
    key,
    label: key,
    children: [{ id: '', kind: 'schema', key: 'public', label: 'public', children: makeSchema() }]
  }
}

/** Assign path-based ids to a node and all of its descendants, in place. */
export function assignIds(node: TreeNode, parentId: string): void {
  const key = node.key || slug(node.label)
  node.id = parentId ? `${parentId}/${key}` : key
  node.children?.forEach((child) => assignIds(child, node.id))
}

/** Depth-first search for a node by id. */
export function findNode(id: string | null, nodes: TreeNode[]): TreeNode | null {
  if (!id) return null
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children) {
      const found = findNode(id, node.children)
      if (found) return found
    }
  }
  return null
}

/** The seed set of connections shown when the app opens. */
export function buildInitialTree(): TreeNode[] {
  const local: TreeNode = {
    id: '',
    kind: 'connection',
    key: 'c-local',
    label: 'Local · PostgreSQL 16',
    subtitle: 'postgres@localhost:5432',
    status: 'online',
    children: [
      schemaDb('postgres'),
      {
        id: '',
        kind: 'database',
        key: 'app_production',
        label: 'app_production',
        children: [
          { id: '', kind: 'schema', key: 'public', label: 'public', children: makeSchema() },
          { id: '', kind: 'schema', key: 'analytics', label: 'analytics', children: makeSchema() },
          { id: '', kind: 'schema', key: 'audit', label: 'audit', children: makeSchema() }
        ]
      },
      schemaDb('app_staging')
    ]
  }
  const staging: TreeNode = {
    id: '',
    kind: 'connection',
    key: 'c-staging',
    label: 'Staging Cluster',
    subtitle: 'deploy@db.staging.internal:5432',
    status: 'idle',
    children: [schemaDb('app_staging'), schemaDb('postgres')]
  }
  const warehouse: TreeNode = {
    id: '',
    kind: 'connection',
    key: 'c-warehouse',
    label: 'Analytics Warehouse',
    subtitle: 'ro_user@10.0.2.14:5432',
    status: 'error',
    children: [schemaDb('warehouse')]
  }
  const tree = [local, staging, warehouse]
  tree.forEach((node) => assignIds(node, ''))
  return tree
}

/** The ids expanded by default so the demo opens on a populated table. */
export function initialExpanded(): Record<string, boolean> {
  return {
    'c-local': true,
    'c-local/app_production': true,
    'c-local/app_production/public': true,
    'c-local/app_production/public/tables': true,
    'c-local/app_production/public/tables/users': true
  }
}

export const initialSelected = 'c-local/app_production/public/tables/users'

export function defaultForm(): ConnectionForm {
  return {
    name: 'New PostgreSQL Connection',
    host: 'localhost',
    port: '5432',
    database: 'postgres',
    user: 'postgres',
    password: '',
    savePwd: true,
    url: 'postgresql://postgres@localhost:5432/postgres'
  }
}

/** Build a connection node from a completed New Connection form. */
export function connectionFromForm(form: ConnectionForm, id: string): TreeNode {
  const database = form.database || 'postgres'
  const conn: TreeNode = {
    id: '',
    kind: 'connection',
    key: id,
    label: (form.name || 'PostgreSQL').trim(),
    subtitle: `${form.user || 'user'}@${form.host || 'localhost'}:${form.port || '5432'}`,
    status: 'online',
    children: [
      {
        id: '',
        kind: 'database',
        key: database,
        label: database,
        children: [{ id: '', kind: 'schema', key: 'public', label: 'public', children: makeSchema() }]
      }
    ]
  }
  assignIds(conn, '')
  return conn
}
