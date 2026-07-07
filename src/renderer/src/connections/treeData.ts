import { parseConnectionUrl } from '../../../shared/connectionUrl'
import type {
  ColumnInfo,
  ConnectResult,
  DatabaseIntrospection,
  RelationInfo,
  RoutineInfo,
  SavedConnection,
  SchemaIntrospection
} from '../../../shared/db'
import { dialectFor } from '../../../shared/dialect'
import type { ConnectionType } from '../../../shared/dialect'
import type { ConnectionForm, TreeNode } from './types'

export function slug(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Assign path-based ids to a node and all of its descendants, in place. */
export function assignIds(node: TreeNode, parentId: string): void {
  const key = node.key || slug(node.label)
  node.id = parentId ? `${parentId}/${key}` : key
  node.children?.forEach((child) => assignIds(child, node.id))
}

/** Depth-first search for a node by id. */
export function findNode(
  id: string | null,
  nodes: TreeNode[]
): TreeNode | null {
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

function columnNode(col: ColumnInfo): TreeNode {
  return {
    id: '',
    kind: 'column',
    label: col.name,
    dtype: col.dataType,
    badge: col.badge
  }
}

function relationNode(
  kind: 'table' | 'view' | 'matview',
  rel: RelationInfo
): TreeNode {
  return {
    id: '',
    kind,
    label: rel.name,
    children: rel.columns.map(columnNode)
  }
}

function routineLabel(routine: RoutineInfo): string {
  return `${routine.name}(${routine.args})`
}

function schemaNode(schema: SchemaIntrospection): TreeNode {
  return {
    id: '',
    kind: 'schema',
    key: schema.name,
    label: schema.name,
    children: [
      {
        id: '',
        kind: 'category',
        key: 'tables',
        icon: 'table',
        label: 'Tables',
        children: schema.tables.map((rel) => relationNode('table', rel))
      },
      {
        id: '',
        kind: 'category',
        key: 'views',
        icon: 'view',
        label: 'Views',
        children: schema.views.map((rel) => relationNode('view', rel))
      },
      {
        id: '',
        kind: 'category',
        key: 'matviews',
        icon: 'matview',
        label: 'Materialized Views',
        children: schema.matviews.map((rel) => relationNode('matview', rel))
      },
      {
        id: '',
        kind: 'category',
        key: 'indexes',
        icon: 'index',
        label: 'Indexes',
        children: schema.indexes.map((name) => ({
          id: '',
          kind: 'index' as const,
          label: name
        }))
      },
      {
        id: '',
        kind: 'category',
        key: 'functions',
        icon: 'function',
        label: 'Functions',
        children: schema.functions.map((fn) => ({
          id: '',
          kind: 'function' as const,
          label: routineLabel(fn),
          returnType: fn.returnType
        }))
      },
      {
        id: '',
        kind: 'category',
        key: 'sequences',
        icon: 'sequence',
        label: 'Sequences',
        children: schema.sequences.map((name) => ({
          id: '',
          kind: 'sequence' as const,
          label: name
        }))
      },
      {
        id: '',
        kind: 'category',
        key: 'types',
        icon: 'type',
        label: 'Data Types',
        children: schema.types.map((type) => ({
          id: '',
          kind: 'type' as const,
          label: type.name,
          meta: type.kind
        }))
      },
      {
        id: '',
        kind: 'category',
        key: 'aggregates',
        icon: 'aggregate',
        label: 'Aggregate Functions',
        children: schema.aggregates.map((agg) => ({
          id: '',
          kind: 'aggregate' as const,
          label: routineLabel(agg)
        }))
      }
    ]
  }
}

/** Schema nodes for a fully introspected database (ids assigned by the caller). */
export function databaseChildren(db: DatabaseIntrospection): TreeNode[] {
  return db.schemas.map(schemaNode)
}

interface SubtitleSource {
  type: ConnectionType
  user: string
  host: string
  port: string
  url: string
}

function connectionSubtitle(source: SubtitleSource, useUrl: boolean): string {
  if (source.type === 'databricks') {
    return source.host.trim() || 'Databricks'
  }
  if (useUrl && source.url.trim()) {
    const parsed = parseConnectionUrl(source.url)
    if (parsed) {
      const userPart = parsed.user ? `${parsed.user}@` : ''
      return `${userPart}${parsed.host || 'localhost'}:${parsed.port || '5432'}`
    }
    return source.url.trim()
  }
  return `${source.user || 'user'}@${source.host || 'localhost'}:${source.port || '5432'}`
}

function connectionLabel(saved: SavedConnection): string {
  const fallback = dialectFor(saved.type).label
  return (saved.name || fallback).trim() || fallback
}

/** Tree node for a saved connection that is not currently connected. */
export function savedConnectionNode(saved: SavedConnection): TreeNode {
  const conn: TreeNode = {
    id: '',
    kind: 'connection',
    key: saved.id,
    label: connectionLabel(saved),
    subtitle: connectionSubtitle(saved, saved.useUrl),
    status: 'offline'
  }
  assignIds(conn, '')
  return conn
}

/** Dialog form prefilled from a saved connection (password is never stored renderer-side). */
export function formFromSaved(saved: SavedConnection): ConnectionForm {
  const defaults = defaultForm(saved.type)
  return {
    type: saved.type,
    name: saved.name,
    host: saved.host || defaults.host,
    port: saved.port || defaults.port,
    database: saved.database || defaults.database,
    user: saved.user || defaults.user,
    password: '',
    httpPath: saved.httpPath || defaults.httpPath,
    savePwd: true,
    url: saved.url || defaults.url
  }
}

/**
 * Build the tree node for a freshly established connection. The database we
 * connected to is fully populated; sibling databases are marked lazy and get
 * introspected when first expanded.
 */
export function connectionNodeFromResult(
  saved: SavedConnection,
  result: ConnectResult
): TreeNode {
  const connected = result.connectedDatabase
  const names = result.databases.includes(connected.name)
    ? result.databases
    : [connected.name, ...result.databases]

  const conn: TreeNode = {
    id: '',
    kind: 'connection',
    key: saved.id,
    label: connectionLabel(saved),
    subtitle: connectionSubtitle(saved, saved.useUrl),
    status: 'online',
    children: names.map((name) =>
      name === connected.name
        ? {
            id: '',
            kind: 'database' as const,
            key: name,
            label: name,
            children: databaseChildren(connected)
          }
        : {
            id: '',
            kind: 'database' as const,
            key: name,
            label: name,
            lazy: true
          }
    )
  }
  assignIds(conn, '')
  return conn
}

/** Expand a new connection down to the connected database's tables. */
export function defaultExpansion(
  conn: TreeNode,
  connectedDb: string
): Record<string, boolean> {
  const out: Record<string, boolean> = { [conn.id]: true }
  const db = conn.children?.find((child) => child.key === connectedDb)
  if (!db) return out
  out[db.id] = true
  // Land on the engine's conventional starter schema when present.
  const schema =
    db.children?.find((s) => s.label === 'public' || s.label === 'default') ??
    db.children?.[0]
  if (!schema) return out
  out[schema.id] = true
  const tables = schema.children?.find((cat) => cat.key === 'tables')
  if (tables?.children?.length) out[tables.id] = true
  return out
}

export function defaultForm(type: ConnectionType = 'postgres'): ConnectionForm {
  const { defaults } = dialectFor(type)
  return {
    type,
    name: defaults.name,
    host: defaults.host,
    port: defaults.port,
    database: defaults.database,
    user: defaults.user,
    password: '',
    httpPath: '',
    savePwd: true,
    url: defaults.url
  }
}
