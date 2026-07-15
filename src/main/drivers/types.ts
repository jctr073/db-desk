/**
 * Contract every database driver implements. The dispatcher in ../db.ts
 * routes calls to the driver matching a connection's type; drivers own
 * their connection state internally, keyed by connId.
 */

import type {
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryResult,
  TestResult
} from '../../shared/db'

export interface RunQueryOptions {
  /**
   * Reject statements that modify data or schema. Postgres enforces this
   * server-side (default_transaction_read_only); Databricks classifies the
   * statement client-side before execution. Violations come back as a
   * DbResult error whose code satisfies isReadOnlyViolation, without the
   * statement taking effect. For agent-originated SQL this is a second belt
   * behind runAgentQuery's allowlist guard — the primary wall — and is no
   * longer associated with any approval flow.
   */
  readOnly?: boolean
  /** Statement timeout applied for the duration of this call. */
  timeoutMs?: number
  /** Receives a best-effort cancel function once the statement is running. */
  onCancel?: (cancel: () => void) => void
}

/**
 * Schema pinning, honoured by multi-database drivers (Databricks) and
 * ignored by single-database ones (PostgreSQL never receives it — the
 * facade only builds options for engines with a saved selection).
 */
export interface IntrospectOptions {
  /** Introspect only these schemas; null/absent = all. */
  allowedSchemas?: string[] | null
  /**
   * With no pinning in effect, skip introspection when the database has
   * more schemas than this; the result comes back with
   * needsSchemaSelection set and availableSchemas listing the names.
   */
  maxUnpinnedSchemas?: number
}

export interface ConnectOptions {
  /**
   * Saved schema pinning, looked up by database name. A callback because
   * the driver only learns which catalog it actually connected to after
   * the session resolves (e.g. current_catalog()).
   */
  schemaSelectionFor?: (database: string) => string[] | null
  maxUnpinnedSchemas?: number
}

export interface Driver {
  test(params: ConnectParams): Promise<DbResult<TestResult>>
  connect(
    connId: string,
    params: ConnectParams,
    options?: ConnectOptions
  ): Promise<DbResult<ConnectResult>>
  disconnect(connId: string): Promise<DbResult<null>>
  disconnectAll(): Promise<void>
  /** Server version captured at connect time; null when the connection is gone. */
  getServerVersion(connId: string): string | null
  /**
   * The `database` argument names which database to act against. On
   * multi-database engines (Databricks) it selects the catalog; on
   * single-database engines (PostgreSQL) the connection is pinned to one
   * database, so any name other than that pinned database is rejected. An
   * empty string means the connection's own/pinned database.
   */
  introspectDatabase(
    connId: string,
    database: string,
    options?: IntrospectOptions
  ): Promise<DbResult<DatabaseIntrospection>>
  /** See introspectDatabase for how `database` is interpreted per engine. */
  runQuery(
    connId: string,
    database: string,
    sql: string,
    limit: number | null,
    options?: RunQueryOptions
  ): Promise<DbResult<QueryResult>>
  /**
   * Full detail for one relation, as plain text for the agent. See
   * introspectDatabase for how `database` is interpreted per engine.
   */
  describeTable(
    connId: string,
    database: string,
    relationName: string,
    allowedSchemas?: string[] | null
  ): Promise<DbResult<string>>
  /**
   * Case-insensitive name search over relations/columns/functions, as text.
   * See introspectDatabase for how `database` is interpreted per engine.
   */
  searchSchema(
    connId: string,
    database: string,
    pattern: string,
    allowedSchemas?: string[] | null
  ): Promise<DbResult<string>>
  /**
   * Cheap name-only listings for the schema/catalog pickers. Optional —
   * only multi-database engines implement them.
   */
  listSchemas?(connId: string, database: string): Promise<DbResult<string[]>>
  listCatalogs?(connId: string): Promise<DbResult<string[]>>
}

/** Error code drivers return when readOnly mode blocked a write statement. */
export const WRITE_REQUIRED_CODE = 'WRITE_REQUIRED'
