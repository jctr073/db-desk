/**
 * Database layer facade: routes every call to the driver matching the
 * connection's type. Callers (IPC handlers, the agent) stay engine-agnostic;
 * everything engine-specific lives in ./drivers.
 */

import type { ConnectionType } from '../shared/dialect'
import type {
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryResult,
  TestResult
} from '../shared/db'
import { databricksDriver } from './drivers/databricks'
import { postgresDriver, PG_READ_ONLY_VIOLATION_CODES } from './drivers/postgres'
import type { Driver, RunQueryOptions } from './drivers/types'
import { WRITE_REQUIRED_CODE } from './drivers/types'

export type { RunQueryOptions } from './drivers/types'

const DRIVERS: Record<ConnectionType, Driver> = {
  postgres: postgresDriver,
  databricks: databricksDriver
}

/** Live connId → engine type, recorded at connect time. */
const connTypes = new Map<string, ConnectionType>()

function driverFor(connId: string): Driver {
  return DRIVERS[connTypes.get(connId) ?? 'postgres']
}

/** Engine type of a live connection; null when the connection is gone. */
export function getConnectionType(connId: string): ConnectionType | null {
  return connTypes.get(connId) ?? null
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
  const res = await DRIVERS[type].connect(connId, params)
  if (res.ok) connTypes.set(connId, type)
  return res
}

export async function disconnect(connId: string): Promise<DbResult<null>> {
  const driver = driverFor(connId)
  connTypes.delete(connId)
  return driver.disconnect(connId)
}

export async function disconnectAll(): Promise<void> {
  connTypes.clear()
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
  return driverFor(connId).introspectDatabase(connId, database)
}

export function runQuery(
  connId: string,
  database: string,
  sql: string,
  limit: number | null,
  options: RunQueryOptions = {}
): Promise<DbResult<QueryResult>> {
  return driverFor(connId).runQuery(connId, database, sql, limit, options)
}

export function describeTable(
  connId: string,
  database: string,
  relationName: string
): Promise<DbResult<string>> {
  return driverFor(connId).describeTable(connId, database, relationName)
}

export function searchSchema(
  connId: string,
  database: string,
  pattern: string
): Promise<DbResult<string>> {
  return driverFor(connId).searchSchema(connId, database, pattern)
}
