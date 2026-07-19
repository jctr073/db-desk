import type { ConnectionEnvironment } from '../../../shared/db'
import type { ConnectionType } from '../../../shared/dialect'

export type ConnectionStatus = 'online' | 'idle' | 'error' | 'offline'

export type ColumnBadge = 'pk' | 'fk' | 'lfk' | null

export type NodeKind =
  | 'connection'
  | 'database'
  | 'schema'
  | 'category'
  | 'table'
  | 'view'
  | 'matview'
  | 'index'
  | 'function'
  | 'sequence'
  | 'type'
  | 'enumValue'
  | 'aggregate'
  | 'column'

/** Icon lookup key: node kinds that render a glyph or SVG in the tree. */
export type IconKey = Exclude<NodeKind, 'category'>

export interface TreeNode {
  /** Path-based identifier assigned by assignIds (e.g. "c-local/app_production/public"). */
  id: string
  kind: NodeKind
  label: string
  /** Stable segment used to build the id; falls back to a slug of the label. */
  key?: string
  children?: TreeNode[]

  // connection
  subtitle?: string
  status?: ConnectionStatus
  connectionType?: ConnectionType
  /** Database/catalog the connection was opened against (locked in pickers). */
  connectedDatabase?: string

  // database / connection
  /** True when the database's schema has not been introspected yet. */
  lazy?: boolean
  /** True while an introspection or connect request is in flight. */
  loading?: boolean

  // database, when schema pinning filtered the loaded set
  pinnedSchemaCount?: number
  totalSchemaCount?: number

  // category
  icon?: IconKey

  // column
  dtype?: string
  badge?: ColumnBadge
  /** Referenced "schema.table.column" for fk (declared) and lfk (inferred) columns. */
  fkRef?: string | null

  // function
  returnType?: string

  // data type
  meta?: string
}

export type TreeMode = 'A' | 'B'

export type Density = 'compact' | 'comfortable'

/** A single visible row produced by flattening the tree for the current view. */
export interface FlatRow {
  node: TreeNode
  depth: number
  expandable: boolean
  expanded: boolean
}

export interface ConnectionForm {
  type: ConnectionType
  name: string
  host: string
  port: string
  database: string
  user: string
  password: string
  httpPath: string
  savePwd: boolean
  url: string
  /** No default selection — the Connect button stays disabled until picked. */
  environment: ConnectionEnvironment | null
}
