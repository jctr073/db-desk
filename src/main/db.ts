/**
 * Database layer facade: routes every call to the driver matching the
 * connection's type. Callers (IPC handlers, the agent) stay engine-agnostic;
 * everything engine-specific lives in ./drivers.
 */

import { dialectFor } from '../shared/dialect'
import type { ConnectionType } from '../shared/dialect'
import { CONNECTION_ENVIRONMENTS } from '../shared/db'
import type {
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryResult,
  SchemaRefreshEvent,
  TestResult
} from '../shared/db'
import { LARGE_CATALOG_SCHEMA_THRESHOLD } from '../shared/schemaSelection'
import { guardAgentStatement } from '../shared/sql'
import { databricksDriver } from './drivers/databricks'
import { postgresDriver, PG_READ_ONLY_VIOLATION_CODES } from './drivers/postgres'
import type { Driver, RunQueryOptions } from './drivers/types'
import { WRITE_REQUIRED_CODE } from './drivers/types'
import {
  cacheIdentityFor,
  cachedIntrospection,
  dropIntrospection,
  loadCacheFile,
  sameSelection,
  saveDatabases,
  saveIntrospection
} from './schemaCache'
import { catalogSelectionFor, schemaSelectionFor } from './store'
import { log } from './log'

export type { RunQueryOptions } from './drivers/types'

const DRIVERS: Record<ConnectionType, Driver> = {
  postgres: postgresDriver,
  databricks: databricksDriver
}

/** Live connId → engine type, recorded at connect time. */
const connTypes = new Map<string, ConnectionType>()

/** Live connId → schema-cache identity fingerprint, recorded at connect time. */
const connIdentities = new Map<string, string>()

/** connId + database pairs with a background revalidation in flight. */
const revalidating = new Set<string>()

type SchemaEventSink = (evt: SchemaRefreshEvent) => void

/** Where background revalidation progress goes (index.ts wires the window). */
let schemaEventSink: SchemaEventSink = () => {}

export function setSchemaEventSink(sink: SchemaEventSink): void {
  schemaEventSink = sink
}

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
function guardDatabase(connId: string, database: string): { ok: false; error: string } | null {
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
    code !== undefined && (code === WRITE_REQUIRED_CODE || PG_READ_ONLY_VIOLATION_CODES.has(code))
  )
}

/** `DbResult.code` for a connect() rejected over a missing/invalid environment. */
export const ENV_REQUIRED_CODE = 'ENV_REQUIRED'

/**
 * Testing a connection (the dialog's Test button) is allowed with no
 * environment picked yet — the form requires one before Connect, but trying
 * credentials first is fine and shouldn't need it.
 */
export function testConnection(params: ConnectParams): Promise<DbResult<TestResult>> {
  return DRIVERS[params.type ?? 'postgres'].test(params)
}

export async function connect(
  connId: string,
  params: ConnectParams
): Promise<DbResult<ConnectResult>> {
  if (connTypes.has(connId)) {
    return { ok: false, error: `Connection "${connId}" already exists` }
  }
  // Belt for the renderer's legacy-connection prompt (useConnectionState.
  // connectSaved): a caller that skips it — or a saved record that somehow
  // still lacks one — cannot connect.
  if (!params.environment || !CONNECTION_ENVIRONMENTS.includes(params.environment)) {
    return {
      ok: false,
      error: 'This connection needs an environment (dev / stage / prod) before it can connect.',
      code: ENV_REQUIRED_CODE
    }
  }
  const type: ConnectionType = params.type ?? 'postgres'
  const identity = cacheIdentityFor(params)
  // A usable cache flips connect into cache-first mode: the driver skips its
  // eager introspection, the cached metadata is served instead, and a
  // background revalidation is queued. First-ever connects (no cache) block
  // on the full introspection exactly as before.
  const cached = loadCacheFile(connId, identity)
  const res = await DRIVERS[type].connect(connId, params, {
    ...(type === 'databricks'
      ? {
          schemaSelectionFor: (catalog) => schemaSelectionFor(connId, catalog),
          maxUnpinnedSchemas: LARGE_CATALOG_SCHEMA_THRESHOLD
        }
      : {}),
    skipIntrospection: !!cached
  })
  if (res.ok) {
    connTypes.set(connId, type)
    connDatabases.set(connId, res.data.connectedDatabase.name)
    connIdentities.set(connId, identity)
    const connectedName = res.data.connectedDatabase.name
    if (cached) {
      const selection = type === 'databricks' ? schemaSelectionFor(connId, connectedName) : null
      const entry = cachedIntrospection(connId, identity, connectedName, selection)
      if (cached.databases.length > 0 && dialectFor(type).multiDatabase) {
        res.data.databases = cached.databases
      }
      if (entry) {
        res.data.connectedDatabase = entry
        queueRevalidate(connId, connectedName)
      } else {
        // Cache exists but has nothing usable for the connected database
        // (name changed, pinning changed): fall back to a foreground
        // introspection so the result is as complete as a fresh connect.
        const intro = await introspectDatabase(connId, connectedName)
        if (!intro.ok) {
          await disconnect(connId)
          return intro
        }
        res.data.connectedDatabase = intro.data
      }
    } else {
      // Fresh full introspection: seed the cache for the next connect.
      saveDatabases(connId, identity, res.data.databases)
      if (!res.data.connectedDatabase.needsSchemaSelection) {
        saveIntrospection(
          connId,
          identity,
          connectedName,
          type === 'databricks' ? schemaSelectionFor(connId, connectedName) : null,
          res.data.connectedDatabase
        )
      }
    }
    if (type === 'databricks') {
      const pinnedCatalogs = catalogSelectionFor(connId)
      if (pinnedCatalogs) {
        const keep = new Set(pinnedCatalogs)
        res.data.databases = res.data.databases.filter((name) => keep.has(name))
      }
    }
  }
  return res
}

export async function disconnect(connId: string): Promise<DbResult<null>> {
  const driver = driverFor(connId)
  connTypes.delete(connId)
  connDatabases.delete(connId)
  connIdentities.delete(connId)
  return driver.disconnect(connId)
}

export async function disconnectAll(): Promise<void> {
  connTypes.clear()
  connDatabases.clear()
  connIdentities.clear()
  await Promise.allSettled(Object.values(DRIVERS).map((driver) => driver.disconnectAll()))
}

export function getServerVersion(connId: string): string | null {
  return driverFor(connId).getServerVersion(connId)
}

/** Driver introspection with the connection's pinning applied; no cache. */
function rawIntrospect(connId: string, database: string): Promise<DbResult<DatabaseIntrospection>> {
  if (connTypes.get(connId) === 'databricks') {
    return driverFor(connId).introspectDatabase(connId, database, {
      allowedSchemas: allowedSchemasFor(connId, database),
      maxUnpinnedSchemas: LARGE_CATALOG_SCHEMA_THRESHOLD
    })
  }
  return driverFor(connId).introspectDatabase(connId, database)
}

/**
 * Cache-first introspection: a valid cached entry returns immediately and
 * queues a background revalidation (progress lands on the schema event
 * sink); otherwise the live introspection runs and seeds the cache.
 */
export async function introspectDatabase(
  connId: string,
  database: string
): Promise<DbResult<DatabaseIntrospection>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return blocked
  const target = database.trim() || connDatabases.get(connId) || database
  const identity = connIdentities.get(connId)
  const selection = allowedSchemasFor(connId, target)
  if (identity) {
    const entry = cachedIntrospection(connId, identity, target, selection)
    if (entry) {
      queueRevalidate(connId, target)
      return { ok: true, data: entry }
    }
  }
  const res = await rawIntrospect(connId, target)
  if (res.ok && !res.data.needsSchemaSelection && identity) {
    saveIntrospection(connId, identity, target, selection, res.data)
  }
  return res
}

/**
 * Re-introspect one database in the background and reconcile the cache.
 * Progress goes to the schema event sink: `validating` immediately, then
 * `ok` (carrying the fresh introspection only when it differs from the
 * cache) or `error` (cached metadata stays in use). Deduped per
 * (connection, database); safe to call opportunistically.
 */
export function queueRevalidate(connId: string, database: string): void {
  const key = `${connId}\u0000${database}`
  if (revalidating.has(key)) return
  revalidating.add(key)
  schemaEventSink({ connId, database, state: 'validating' })
  void (async () => {
    try {
      const selectionBefore = allowedSchemasFor(connId, database)
      const res = await rawIntrospect(connId, database)
      // Disconnected mid-flight: results and events would be about a
      // connection that no longer exists.
      if (!connTypes.has(connId)) return
      if (!res.ok) {
        schemaEventSink({ connId, database, state: 'error', error: res.error })
        return
      }
      const identity = connIdentities.get(connId)
      const selection = allowedSchemasFor(connId, database)
      if (res.data.needsSchemaSelection || !sameSelection(selectionBefore, selection)) {
        // The pinning changed under us (or vanished): this result is not
        // trustworthy under the current selection. Drop the stale entry and
        // leave the tree alone — the selection-change flow reloads it.
        if (identity) dropIntrospection(connId, database)
        schemaEventSink({ connId, database, state: 'ok', unchanged: true })
        return
      }
      const previous = identity ? cachedIntrospection(connId, identity, database, selection) : null
      const changed = !previous || JSON.stringify(previous) !== JSON.stringify(res.data)
      if (identity) {
        saveIntrospection(connId, identity, database, selection, res.data)
      }
      // While we're here, refresh the cached catalog list so the next
      // launch's tree shows current siblings (multi-database engines only,
      // and only from the connected catalog's revalidation).
      const type = connTypes.get(connId)
      if (
        identity &&
        type &&
        dialectFor(type).multiDatabase &&
        connDatabases.get(connId) === database
      ) {
        const catalogs = await driverFor(connId).listCatalogs?.(connId)
        if (catalogs?.ok) saveDatabases(connId, identity, catalogs.data)
      }
      schemaEventSink({
        connId,
        database,
        state: 'ok',
        introspection: changed ? res.data : undefined,
        unchanged: !changed
      })
    } catch (err) {
      // Every awaited call returns a DbResult, so a throw here is a driver
      // bug — but without this catch it would be an unhandled rejection and
      // the renderer would sit on 'validating' with no terminal event.
      log.error('db', `revalidation failed for ${connId}/${database}`, err)
      if (connTypes.has(connId)) {
        schemaEventSink({
          connId,
          database,
          state: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      revalidating.delete(key)
    }
  })()
}

/**
 * Schema names of one database, cheaply (no tables/columns), unfiltered by
 * any pinning — this is what populates the schema picker.
 */
export function listSchemas(connId: string, database: string): Promise<DbResult<string[]>> {
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

/**
 * Command tags whose success means the database's structure likely changed
 * (best-effort — matches both Postgres tags like "CREATE TABLE" and the
 * first-keyword tags Databricks statements report).
 */
const DDL_COMMAND = /^(CREATE|ALTER|DROP|RENAME)\b/i

export async function runQuery(
  connId: string,
  database: string,
  sql: string,
  limit: number | null,
  options: RunQueryOptions = {}
): Promise<DbResult<QueryResult>> {
  const blocked = guardDatabase(connId, database)
  if (blocked) return blocked
  const res = await driverFor(connId).runQuery(connId, database, sql, limit, options)
  // Successful DDL invalidates the cached metadata immediately; revalidate
  // now so the tree (and the cache on disk) catch up without a manual
  // refresh.
  if (res.ok && DDL_COMMAND.test(res.data.command)) {
    const target = database.trim() || connDatabases.get(connId) || ''
    if (target) queueRevalidate(connId, target)
  }
  return res
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
