import { Client, Pool } from 'pg'
import type { ClientBase, ClientConfig, PoolClient } from 'pg'

import type {
  CellValue,
  ColumnInfo,
  ConnectParams,
  ConnectResult,
  DatabaseIntrospection,
  DbResult,
  QueryField,
  QueryResult,
  RelationInfo,
  RoutineInfo,
  SchemaIntrospection,
  TestResult,
  TypeInfo
} from '../shared/db'
import { normalizeConnectionUrl } from '../shared/connectionUrl'
import { applyAutoLimit } from '../shared/sql'

const CONNECT_TIMEOUT_MS = 8000

interface ManagedConnection {
  params: ConnectParams
  /** Pool against the database the user originally connected to. */
  pool: Pool
  database: string
  /** Lazily created pools for queries against sibling databases. */
  extraPools: Map<string, Pool>
  /** Cache of type OID → name lookups shared by every result on this server. */
  typeNames: Map<number, string>
}

const connections = new Map<string, ManagedConnection>()

function clientConfig(
  params: ConnectParams,
  databaseOverride?: string
): ClientConfig {
  if (params.useUrl && params.url.trim()) {
    let connectionString = normalizeConnectionUrl(params.url)
    if (databaseOverride) {
      const url = new URL(connectionString)
      url.pathname = `/${encodeURIComponent(databaseOverride)}`
      connectionString = url.toString()
    }
    return { connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS }
  }
  return {
    host: params.host.trim() || 'localhost',
    port: Number(params.port) || 5432,
    database: databaseOverride ?? (params.database.trim() || 'postgres'),
    user: params.user.trim() || undefined,
    password: params.password || undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS
  }
}

function errorMessage(err: unknown): string {
  // Node reports a dual-stack (IPv4 + IPv6) connection failure as an
  // AggregateError whose own message is empty; use the causes instead.
  if (err instanceof AggregateError) {
    const parts = [...new Set(err.errors.map(errorMessage).filter(Boolean))]
    if (parts.length > 0) return parts.join('; ')
  }
  if (err instanceof Error) {
    if (err.message) return err.message
    const code = (err as { code?: string }).code
    return code ? `Connection failed (${code})` : err.name
  }
  return String(err)
}

/** "PostgreSQL 16.2 on aarch64-apple…" → "16.2". */
function parseServerVersion(versionRow: string): string {
  const match = /^PostgreSQL\s+(\S+)/.exec(versionRow)
  return match ? match[1] : versionRow
}

const SYSTEM_SCHEMA_FILTER = `
  n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
`

async function introspectWith(
  client: ClientBase,
  database: string
): Promise<DatabaseIntrospection> {
  const [schemaRes, relRes, colRes, conRes, idxRes, procRes, typeRes] = [
    await client.query<{ nspname: string }>(
      `SELECT n.nspname
         FROM pg_namespace n
        WHERE ${SYSTEM_SCHEMA_FILTER}
        ORDER BY n.nspname`
    ),
    await client.query<{
      oid: string
      schema: string
      name: string
      kind: string
    }>(
      `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S') AND ${SYSTEM_SCHEMA_FILTER}
        ORDER BY n.nspname, c.relname`
    ),
    await client.query<{
      reloid: string
      name: string
      dtype: string
      attnum: number
    }>(
      `SELECT a.attrelid::text AS reloid, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS dtype, a.attnum
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm')
          AND a.attnum > 0 AND NOT a.attisdropped AND ${SYSTEM_SCHEMA_FILTER}
        ORDER BY a.attrelid, a.attnum`
    ),
    await client.query<{ reloid: string; contype: string; conkey: number[] }>(
      `SELECT c.conrelid::text AS reloid, c.contype, c.conkey
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE c.contype IN ('p', 'f') AND ${SYSTEM_SCHEMA_FILTER}`
    ),
    await client.query<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, ci.relname AS name
         FROM pg_index i
         JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = ci.relnamespace
        WHERE ${SYSTEM_SCHEMA_FILTER}
        ORDER BY n.nspname, ci.relname`
    ),
    await client.query<{
      schema: string
      name: string
      args: string
      ret: string
      kind: string
    }>(
      `SELECT n.nspname AS schema, p.proname AS name,
              pg_get_function_arguments(p.oid) AS args,
              pg_get_function_result(p.oid) AS ret,
              p.prokind AS kind
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p', 'w', 'a') AND ${SYSTEM_SCHEMA_FILTER}
        ORDER BY n.nspname, p.proname`
    ),
    await client.query<{ schema: string; name: string; kind: string }>(
      `SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typtype IN ('e', 'c', 'd', 'r', 'm')
          AND (t.typrelid = 0 OR EXISTS (
                SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
          AND NOT EXISTS (
                SELECT 1 FROM pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)
          AND ${SYSTEM_SCHEMA_FILTER}
        ORDER BY n.nspname, t.typname`
    )
  ]

  // Column badges: pk wins over fk when a column participates in both.
  const pkCols = new Map<string, Set<number>>()
  const fkCols = new Map<string, Set<number>>()
  for (const con of conRes.rows) {
    const target = con.contype === 'p' ? pkCols : fkCols
    let set = target.get(con.reloid)
    if (!set) target.set(con.reloid, (set = new Set()))
    for (const attnum of con.conkey ?? []) set.add(attnum)
  }

  const columnsByRel = new Map<string, ColumnInfo[]>()
  for (const col of colRes.rows) {
    let list = columnsByRel.get(col.reloid)
    if (!list) columnsByRel.set(col.reloid, (list = []))
    const badge = pkCols.get(col.reloid)?.has(col.attnum)
      ? 'pk'
      : fkCols.get(col.reloid)?.has(col.attnum)
        ? 'fk'
        : null
    list.push({ name: col.name, dataType: col.dtype, badge })
  }

  const schemas = new Map<string, SchemaIntrospection>()
  const schemaFor = (name: string): SchemaIntrospection => {
    let schema = schemas.get(name)
    if (!schema) {
      schema = {
        name,
        tables: [],
        views: [],
        matviews: [],
        indexes: [],
        functions: [],
        sequences: [],
        types: [],
        aggregates: []
      }
      schemas.set(name, schema)
    }
    return schema
  }

  for (const row of schemaRes.rows) schemaFor(row.nspname)

  for (const rel of relRes.rows) {
    const schema = schemaFor(rel.schema)
    if (rel.kind === 'S') {
      schema.sequences.push(rel.name)
      continue
    }
    const relation: RelationInfo = {
      name: rel.name,
      columns: columnsByRel.get(rel.oid) ?? []
    }
    if (rel.kind === 'v') schema.views.push(relation)
    else if (rel.kind === 'm') schema.matviews.push(relation)
    else schema.tables.push(relation)
  }

  for (const idx of idxRes.rows) schemaFor(idx.schema).indexes.push(idx.name)

  for (const proc of procRes.rows) {
    const routine: RoutineInfo = {
      name: proc.name,
      args: proc.args,
      returnType: proc.ret
    }
    if (proc.kind === 'a') schemaFor(proc.schema).aggregates.push(routine)
    else schemaFor(proc.schema).functions.push(routine)
  }

  const TYPE_KIND: Record<string, string> = {
    e: 'enum',
    c: 'composite',
    d: 'domain',
    r: 'range',
    m: 'multirange'
  }
  for (const type of typeRes.rows) {
    const info: TypeInfo = {
      name: type.name,
      kind: TYPE_KIND[type.kind] ?? type.kind
    }
    schemaFor(type.schema).types.push(info)
  }

  return { name: database, schemas: [...schemas.values()] }
}

export async function testConnection(
  params: ConnectParams
): Promise<DbResult<TestResult>> {
  const client = new Client(clientConfig(params))
  const started = Date.now()
  try {
    await client.connect()
    const res = await client.query<{ version: string }>(
      'SELECT version() AS version'
    )
    return {
      ok: true,
      data: {
        serverVersion: parseServerVersion(res.rows[0].version),
        latencyMs: Date.now() - started
      }
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    void client.end().catch(() => {})
  }
}

export async function connect(
  connId: string,
  params: ConnectParams
): Promise<DbResult<ConnectResult>> {
  if (connections.has(connId)) {
    return { ok: false, error: `Connection "${connId}" already exists` }
  }
  const pool = new Pool({ ...clientConfig(params), max: 4 })
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    const meta = await client.query<{ db: string; version: string }>(
      'SELECT current_database() AS db, version() AS version'
    )
    const database = meta.rows[0].db
    const dbRes = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datallowconn AND NOT datistemplate
        ORDER BY datname`
    )
    const connectedDatabase = await introspectWith(client, database)
    connections.set(connId, {
      params,
      pool,
      database,
      extraPools: new Map(),
      typeNames: new Map()
    })
    return {
      ok: true,
      data: {
        serverVersion: parseServerVersion(meta.rows[0].version),
        connectedDatabase,
        databases: dbRes.rows.map((row) => row.datname)
      }
    }
  } catch (err) {
    void pool.end().catch(() => {})
    return { ok: false, error: errorMessage(err) }
  } finally {
    client?.release()
  }
}

/** Introspect any database on an established connection's server. */
export async function introspectDatabase(
  connId: string,
  database: string
): Promise<DbResult<DatabaseIntrospection>> {
  const managed = connections.get(connId)
  if (!managed) return { ok: false, error: 'Connection no longer exists' }

  if (database === managed.database) {
    let client: PoolClient | undefined
    try {
      client = await managed.pool.connect()
      return { ok: true, data: await introspectWith(client, database) }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    } finally {
      client?.release()
    }
  }

  // Other databases require their own session; use a short-lived client.
  const client = new Client(clientConfig(managed.params, database))
  try {
    await client.connect()
    return { ok: true, data: await introspectWith(client, database) }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    void client.end().catch(() => {})
  }
}

function allPools(managed: ManagedConnection): Pool[] {
  return [managed.pool, ...managed.extraPools.values()]
}

export async function disconnect(connId: string): Promise<DbResult<null>> {
  const managed = connections.get(connId)
  if (managed) {
    connections.delete(connId)
    for (const pool of allPools(managed)) void pool.end().catch(() => {})
  }
  return { ok: true, data: null }
}

export async function disconnectAll(): Promise<void> {
  const pools = [...connections.values()].flatMap(allPools)
  connections.clear()
  await Promise.allSettled(pools.map((pool) => pool.end()))
}

/* ------------------------------------------------------------------ *
 * Query execution                                                     *
 * ------------------------------------------------------------------ */

const MAX_CELL_CHARS = 10_000

/** Common built-in type OIDs, so most results need no catalog lookup. */
const BUILTIN_TYPE_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  199: 'json[]',
  600: 'point',
  700: 'float4',
  701: 'float8',
  790: 'money',
  829: 'macaddr',
  869: 'inet',
  1000: 'bool[]',
  1007: 'int4[]',
  1009: 'text[]',
  1015: 'varchar[]',
  1016: 'int8[]',
  1021: 'float4[]',
  1022: 'float8[]',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1115: 'timestamp[]',
  1182: 'date[]',
  1184: 'timestamptz',
  1185: 'timestamptz[]',
  1186: 'interval',
  1231: 'numeric[]',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  2951: 'uuid[]',
  3802: 'jsonb',
  3807: 'jsonb[]'
}

function truncateCell(value: string): string {
  return value.length > MAX_CELL_CHARS
    ? `${value.slice(0, MAX_CELL_CHARS)}…`
    : value
}

function serializeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return truncateCell(value)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    default:
      if (value instanceof Date) {
        return Number.isNaN(value.getTime())
          ? String(value)
          : value.toISOString()
      }
      if (Buffer.isBuffer(value)) {
        return truncateCell(`\\x${value.toString('hex')}`)
      }
      try {
        return truncateCell(JSON.stringify(value) ?? String(value))
      } catch {
        return String(value)
      }
  }
}

function poolFor(managed: ManagedConnection, database: string): Pool {
  if (database === managed.database) return managed.pool
  let pool = managed.extraPools.get(database)
  if (!pool) {
    pool = new Pool({ ...clientConfig(managed.params, database), max: 2 })
    managed.extraPools.set(database, pool)
  }
  return pool
}

/** Resolve field type names, hitting pg_type only for OIDs not yet cached. */
async function resolveFields(
  client: ClientBase,
  managed: ManagedConnection,
  fields: { name: string; dataTypeID: number }[]
): Promise<QueryField[]> {
  const unknown = [
    ...new Set(
      fields
        .map((f) => f.dataTypeID)
        .filter(
          (oid) => !(oid in BUILTIN_TYPE_NAMES) && !managed.typeNames.has(oid)
        )
    )
  ]
  if (unknown.length > 0) {
    try {
      const res = await client.query<{ oid: string; name: string }>(
        `SELECT oid::text AS oid, format_type(oid, NULL) AS name
           FROM pg_type WHERE oid = ANY($1::oid[])`,
        [unknown]
      )
      for (const row of res.rows)
        managed.typeNames.set(Number(row.oid), row.name)
    } catch {
      // Lookup is cosmetic; fall through to the numeric fallback below.
    }
  }
  return fields.map((f) => ({
    name: f.name,
    dataType:
      BUILTIN_TYPE_NAMES[f.dataTypeID] ??
      managed.typeNames.get(f.dataTypeID) ??
      `oid ${f.dataTypeID}`
  }))
}

export async function runQuery(
  connId: string,
  database: string,
  sql: string,
  limit: number | null
): Promise<DbResult<QueryResult>> {
  const managed = connections.get(connId)
  if (!managed) return { ok: false, error: 'Connection no longer exists' }

  const prepared =
    limit === null ? { text: sql, applied: false } : applyAutoLimit(sql, limit)
  let client: PoolClient | undefined
  try {
    client = await poolFor(managed, database).connect()
    const started = Date.now()
    const res = await client.query({ text: prepared.text, rowMode: 'array' })
    const durationMs = Date.now() - started
    // Multiple statements resolve to an array of results; report the last one.
    const results = (Array.isArray(res) ? res : [res]) as unknown as {
      command: string
      rowCount: number | null
      fields: { name: string; dataTypeID: number }[]
      rows: unknown[][]
    }[]
    const last = results[results.length - 1]
    const fields = await resolveFields(client, managed, last.fields ?? [])
    let rows = (last.rows ?? []).map((row) => row.map(serializeCell))
    let truncated = false
    if (limit !== null && !prepared.applied && rows.length > limit) {
      rows = rows.slice(0, limit)
      truncated = true
    }
    return {
      ok: true,
      data: {
        command: last.command ?? '',
        fields,
        rows,
        rowCount: last.rowCount,
        durationMs,
        limitApplied: prepared.applied ? limit : null,
        truncated
      }
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    client?.release()
  }
}
