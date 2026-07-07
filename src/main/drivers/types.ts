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
   * statement taking effect.
   */
  readOnly?: boolean
  /** Statement timeout applied for the duration of this call. */
  timeoutMs?: number
  /** Receives a best-effort cancel function once the statement is running. */
  onCancel?: (cancel: () => void) => void
}

export interface Driver {
  test(params: ConnectParams): Promise<DbResult<TestResult>>
  connect(connId: string, params: ConnectParams): Promise<DbResult<ConnectResult>>
  disconnect(connId: string): Promise<DbResult<null>>
  disconnectAll(): Promise<void>
  /** Server version captured at connect time; null when the connection is gone. */
  getServerVersion(connId: string): string | null
  introspectDatabase(
    connId: string,
    database: string
  ): Promise<DbResult<DatabaseIntrospection>>
  runQuery(
    connId: string,
    database: string,
    sql: string,
    limit: number | null,
    options?: RunQueryOptions
  ): Promise<DbResult<QueryResult>>
  /** Full detail for one relation, as plain text for the agent. */
  describeTable(
    connId: string,
    database: string,
    relationName: string
  ): Promise<DbResult<string>>
  /** Case-insensitive name search over relations/columns/functions, as text. */
  searchSchema(
    connId: string,
    database: string,
    pattern: string
  ): Promise<DbResult<string>>
}

/** Error code drivers return when readOnly mode blocked a write statement. */
export const WRITE_REQUIRED_CODE = 'WRITE_REQUIRED'
