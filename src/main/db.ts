/**
 * Database layer facade: routes every call to the driver matching the
 * connection's type. Callers (IPC handlers, the agent) stay engine-agnostic;
 * everything engine-specific lives in ./drivers.
 */

import { dialectFor } from '../shared/dialect'
import type { ConnectionType } from '../shared/dialect'
import type {
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryResult,
  TestResult
} from '../shared/db'
import { LARGE_CATALOG_SCHEMA_THRESHOLD } from '../shared/schemaSelection'
import { guardAgentStatement } from '../shared/sql'
import { databricksDriver } from './drivers/databricks'
import { postgresDriver, PG_READ_ONLY_VIOLATION_CODES } from './drivers/postgres'
import type { Driver, RunQueryOptions } from './drivers/types'
import { WRITE_REQUIRED_CODE } from './drivers/types'
import { catalogSelectionFor, schemaSelectionFor } from './store'

export type { RunQueryOptions } from './drivers/types'

const DRIVERS: Record<ConnectionType, Driver> = {
  postgres: postgresDriver,
  databricks: databricksDriver
}

/** Live connId → engine type, recorded at connect time. */
const connTypes = new Map<string, ConnectionType>()

/**
 * Live connId → the database the connection was opened against. Recorded so
 * this facade can reject cross-database calls to single-database engines
 * without asking the driver.
 */
const connDatabases = new Map<string, string>()

function driverFor(connId: string): Driver {
  return DRIVERS[connTypes.get(connId) ?? 'postgres']
}

/**
 * Defense in depth for single-database engines (dialect multiDatabase ===
 * false, e.g. PostgreSQL): a renderer or agent must never steer a call at a
 * database other than the one the connection is pinned to. The driver enforces
 * this too, but catching it here keeps a mistaken caller from ever reaching
 * the driver. Multi-database engines (Databricks) and an empty/omitted
 * database — meaning "the connected database" — always pass.
 */
function guardDatabase(
  connId: string,
  database: string
): { ok: false; error: string } | null {
  const type = connTypes.get(connId)
  if (!type || dialectFor(type).multiDatabase) return null
  const pinned = connDatabases.get(connId)
  if (pinned && database.trim() && database !== pinned) {
    return {
      ok: false,
      error: `This connection is pinned to database "${pinned}".`
    }
  }
  return null
}

/** Engine type of a live connection; null when the connection is gone. */
export function getConnectionType(connId: string): ConnectionType | null {
  return connTypes.get(connId) ?? null
}

/**
 * The saved schema pinning for a call's target database, or null when none
 * applies (non-Databricks engines, unsaved connections, no selection). The
 * live connId doubles as the saved-connection id (db:connectSaved connects
 * under the profile's own id), which is what makes the store lookup work.
 */
function allowedSchemasFor(connId: string, database: string): string[] | null {
  if (connTypes.get(connId) !== 'databricks') return null
  const target = database.trim() || connDatabases.get(connId) || ''
  return target ? schemaSelectionFor(connId, target) : null
}

/**
 * True when a failed runQuery means "this statement needs write/DDL
 * privileges": Postgres read-only SQLSTATEs or the client-side
 * classification code shared by drivers without a server-side mode.
 */
export function isReadOnlyViolation(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (code === WRITE_REQUIRED_CODE || PG_READ_ONLY_VIOLATION_CODES.has(code))
  )
}

export function testConnection(
  params: ConnectParams
): Promise<DbResult<TestResult>> {
  return DRIVERS[params.type ?? 'postgres'].test(params)
}

export async function connect(
  connId: string,
  params: ConnectParams
): Promise<DbResult<ConnectResult>> {
  if (connTypes.has(connId)) {
    return { ok: false, error: `Connection "${connId}" already exists` }
  }
  const type: ConnectionType = params.type ?? 'postgres'
  const res = await DRIVERS[type].connect(
    connId,
    params,
    type === 'databricks'
      ? {
          schemaSelectionFor: (catalog) => schemaSelectionFor(connId, catalog),
          maxUnpinnedSchemas: LARGE_CATALOG_SCHEMA_THRESHOLD
        }
      : undefined
  )
  if (res.ok) {
    connTypes.set(connId, type)
    connDatabases.set(connId, res.data.connectedDatabase.name)
    if (type === 'databricks') {
      const pinnedCatalogs = catalogSelectionFor(connId)
      if (pinnedCatalogs) {
        const keep = new Set([
          ...pinnedCatalogs,
          res.data.connectedDatabase.name
        ])
        res.data.databases = res.data.databases.filter((name) =>
          keep.has(name)
        )
      }
    }
  }
  return res
}

export async function disconnect(connId: string): Promise<DbResult<null>> {
  const driver = driverFor(connId)
  connTypes.delete(connId)
  connDatabases.delete(connId)
  return driver.disconnect(connId)
}

export async function disconnectAll(): Promise<void> {
  connTypes.clear()
  connDatabases.clear()
  await Promise.allSettled(
    Object.values(DRIVERS).map((driver) => driver.disconnectAll())
  )
}

export function getServerVersion(connId: string): string | null {
  return driverFor(connId).getServerVersion(connId)
}

export function introspectDatabase(
  connId: string,
  database: string
): Promise<DbResult<DatabaseIntrospection>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return Promise.resolve(blocked)
  if (connTypes.get(connId) === 'databricks') {
    return driverFor(connId).introspectDatabase(connId, database, {
      allowedSchemas: allowedSchemasFor(connId, database),
      maxUnpinnedSchemas: LARGE_CATALOG_SCHEMA_THRESHOLD
    })
  }
  return driverFor(connId).introspectDatabase(connId, database)
}

/**
 * Schema names of one database, cheaply (no tables/columns), unfiltered by
 * any pinning — this is what populates the schema picker.
 */
export function listSchemas(
  connId: string,
  database: string
): Promise<DbResult<string[]>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return Promise.resolve(blocked)
  const list = driverFor(connId).listSchemas
  if (!list) {
    return Promise.resolve({
      ok: false,
      error: 'Not supported for this connection type'
    })
  }
  return list(connId, database)
}

/** All catalogs reachable from a connection, unfiltered by any pinning. */
export function listCatalogs(connId: string): Promise<DbResult<string[]>> {
  const list = driverFor(connId).listCatalogs
  if (!list) {
    return Promise.resolve({
      ok: false,
      error: 'Not supported for this connection type'
    })
  }
  return list(connId)
}

export function runQuery(
  connId: string,
  database: string,
  sql: string,
  limit: number | null,
  options: RunQueryOptions = {}
): Promise<DbResult<QueryResult>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return Promise.resolve(blocked)
  return driverFor(connId).runQuery(connId, database, sql, limit, options)
}

/** Options the agent channel accepts — deliberately no readOnly escape. */
export interface AgentRunOptions {
  timeoutMs?: number
  onCancel?: (cancel: () => void) => void
}

export const AGENT_BLOCKED_CODE = 'AGENT_BLOCKED'

/**
 * The ONLY execution entry point for agent-originated SQL. Enforces
 * guardAgentStatement (single, provably-read statement) before the driver
 * runs it, and always runs the driver in readOnly mode as a second belt.
 */
export async function runAgentQuery(
  connId: string,
  database: string,
  sql: string,
  limit: number | null,
  options: AgentRunOptions = {}
): Promise<DbResult<QueryResult>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return blocked
  const guard = guardAgentStatement(sql)
  if (!guard.ok) {
    return { ok: false, error: guard.reason, code: AGENT_BLOCKED_CODE }
  }
  return driverFor(connId).runQuery(connId, database, sql, limit, {
    ...options,
    readOnly: true
  })
}

export function describeTable(
  connId: string,
  database: string,
  relationName: string
): Promise<DbResult<string>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return Promise.resolve(blocked)
  return driverFor(connId).describeTable(
    connId,
    database,
    relationName,
    allowedSchemasFor(connId, database)
  )
}

export function searchSchema(
  connId: string,
  database: string,
  pattern: string
): Promise<DbResult<string>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return Promise.resolve(blocked)
  return driverFor(connId).searchSchema(
    connId,
    database,
    pattern,
    allowedSchemasFor(connId, database)
  )
}
