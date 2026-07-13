/**
 * Wire types shared by the main-process database layer, the preload bridge,
 * and the renderer. Everything here must be structured-clone friendly.
 */

import type { ConnectionType } from './dialect'

export interface ConnectParams {
  /** Engine the connection targets; selects the main-process driver. */
  type: ConnectionType
  host: string
  port: string
  /** Database to open (catalog for Databricks). */
  database: string
  user: string
  /** Password (personal access token for Databricks). */
  password: string
  /** Warehouse HTTP path (Databricks only). */
  httpPath: string
  /** Full connection URL; used instead of the discrete fields when useUrl is set. */
  url: string
  useUrl: boolean
}

export interface ColumnInfo {
  name: string
  dataType: string
  badge: 'pk' | 'fk' | null
  /** Referenced column when this column is part of a foreign key, e.g. "public.customers.id". */
  fkRef?: string | null
}

export interface RelationInfo {
  name: string
  columns: ColumnInfo[]
  /** Planner row estimate (pg_class.reltuples); -1 or absent when unknown. */
  rowEstimate?: number | null
  /** Compact index descriptions, e.g. "orders_pkey unique btree (id)". */
  indexes?: string[]
}

export interface RoutineInfo {
  name: string
  args: string
  returnType: string
}

export interface TypeInfo {
  name: string
  /** Human-readable type class: enum, composite, domain, range, multirange. */
  kind: string
  /** Labels in sort order when the type is an enum. */
  values?: string[]
}

export interface SchemaIntrospection {
  name: string
  tables: RelationInfo[]
  views: RelationInfo[]
  matviews: RelationInfo[]
  indexes: string[]
  functions: RoutineInfo[]
  sequences: string[]
  types: TypeInfo[]
  aggregates: RoutineInfo[]
}

export interface DatabaseIntrospection {
  name: string
  schemas: SchemaIntrospection[]
}

export interface TestResult {
  serverVersion: string
  latencyMs: number
  /** True when the session was established over TLS. */
  ssl: boolean
}

export interface ConnectResult {
  serverVersion: string
  /** Database the connection was opened against (fully introspected). */
  connectedDatabase: DatabaseIntrospection
  /**
   * Databases this connection can reach. Multi-database engines (Databricks)
   * list every catalog; single-database engines (PostgreSQL) are pinned to
   * the one they connected to, so this is exactly [connectedDatabase.name].
   */
  databases: string[]
}

/** All db IPC calls resolve to this shape; errors travel as values, not throws. */
export type DbResult<T> =
  { ok: true; data: T } | { ok: false; error: string; code?: string }

/** Grid cell payload; every driver value is folded into one of these. */
export type CellValue = string | number | boolean | null

export interface QueryField {
  name: string
  dataType: string
}

export interface QueryResult {
  /** Command tag reported by the server, e.g. "SELECT", "UPDATE". */
  command: string
  fields: QueryField[]
  rows: CellValue[][]
  /** Rows returned or affected as reported by the server (null when unknown). */
  rowCount: number | null
  durationMs: number
  /** LIMIT value that was auto-appended to the statement, if any. */
  limitApplied: number | null
  /** True when rows beyond the requested limit were discarded after execution. */
  truncated: boolean
}

/**
 * A connection profile persisted across app sessions. Passwords never travel
 * to the renderer: `hasPassword` says whether one is stored (encrypted) in the
 * main process, and `url` always has any password component stripped.
 */
export interface SavedConnection {
  id: string
  name: string
  type: ConnectionType
  host: string
  port: string
  database: string
  user: string
  httpPath: string
  url: string
  useUrl: boolean
  hasPassword: boolean
}
