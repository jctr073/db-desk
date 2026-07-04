/**
 * Wire types shared by the main-process database layer, the preload bridge,
 * and the renderer. Everything here must be structured-clone friendly.
 */

export interface ConnectParams {
  host: string
  port: string
  database: string
  user: string
  password: string
  /** Full connection URL; used instead of the discrete fields when useUrl is set. */
  url: string
  useUrl: boolean
}

export interface ColumnInfo {
  name: string
  dataType: string
  badge: 'pk' | 'fk' | null
}

export interface RelationInfo {
  name: string
  columns: ColumnInfo[]
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
}

export interface ConnectResult {
  serverVersion: string
  /** Database the connection was opened against (fully introspected). */
  connectedDatabase: DatabaseIntrospection
  /** Every connectable, non-template database on the server. */
  databases: string[]
}

/** All db IPC calls resolve to this shape; errors travel as values, not throws. */
export type DbResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * A connection profile persisted across app sessions. Passwords never travel
 * to the renderer: `hasPassword` says whether one is stored (encrypted) in the
 * main process, and `url` always has any password component stripped.
 */
export interface SavedConnection {
  id: string
  name: string
  host: string
  port: string
  database: string
  user: string
  url: string
  useUrl: boolean
  hasPassword: boolean
}
