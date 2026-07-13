/** PostgreSQL driver, built on node-postgres pools. */

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
} from '../../shared/db'
import {
  normalizeConnectionUrl,
  parseConnectionUrl
} from '../../shared/connectionUrl'
import { applyAutoLimit } from '../../shared/sql'
import type { Driver, RunQueryOptions } from './types'

const CONNECT_TIMEOUT_MS = 8000

interface ManagedConnection {
  params: ConnectParams
  /**
   * The single pool for this connection. A PostgreSQL connection is pinned to
   * exactly one database, chosen at connect time — there are no sibling pools
   * and no path to any other database on the server.
   */
  pool: Pool
  /** The one database this connection is pinned to (from current_database()). */
  database: string
  /**
   * TLS override the connection was established with. null defers to the
   * connection URL's own sslmode (verify-ca/verify-full/disable), which pg
   * enforces as written.
   */
  ssl: SslOverride
  /** Cache of type OID → name lookups shared by every result on this server. */
  typeNames: Map<number, string>
  /** Server version string captured at connect time, e.g. "16.2". */
  serverVersion: string
}

const connections = new Map<string, ManagedConnection>()

/**
 * true: force TLS without certificate verification (libpq `require`
 * semantics — managed providers commonly present self-signed chains, which
 * psql also accepts). false: force plaintext. null: defer entirely to the
 * connection URL's own sslmode, which pg enforces as written.
 */
type SslOverride = boolean | null

function clientConfig(
  params: ConnectParams,
  ssl: SslOverride = null
): ClientConfig {
  let config: ClientConfig
  if (params.useUrl && params.url.trim()) {
    let connectionString = normalizeConnectionUrl(params.url)
    if (ssl !== null) {
      try {
        const url = new URL(connectionString)
        // pg lets a parsed sslmode override explicit ssl config, so the
        // param must go for the override below to take effect.
        url.searchParams.delete('sslmode')
        url.searchParams.delete('ssl')
        connectionString = url.toString()
      } catch {
        // not WHATWG-parseable; hand it to pg untouched
      }
    }
    config = { connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS }
  } else {
    config = {
      host: params.host.trim() || 'localhost',
      port: Number(params.port) || 5432,
      // No silent fallback: connect() rejects an empty database up front, so
      // the only caller reaching here without one is the connectivity test,
      // where undefined lets pg apply its own default.
      database: params.database.trim() || undefined,
      user: params.user.trim() || undefined,
      password: params.password || undefined,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS
    }
  }
  if (ssl === true) config.ssl = { rejectUnauthorized: false }
  if (ssl === false) config.ssl = false
  return config
}

/**
 * The database a set of ConnectParams pins to: the form field, or the URL
 * path in URL mode. Empty/whitespace means the user named none — PostgreSQL
 * connections require one (unlike Databricks' multi-catalog model), so
 * connect() rejects that up front. An unparseable URL returns null: the
 * missing-database message would misdiagnose it, so the check steps aside
 * and lets pg report the malformed URL itself.
 */
function resolveDatabase(params: ConnectParams): string | null {
  if (params.useUrl && params.url.trim()) {
    const parsed = parseConnectionUrl(params.url)
    return parsed ? parsed.database.trim() : null
  }
  return params.database.trim()
}

/**
 * A PostgreSQL connection is pinned to the single database chosen at connect
 * time; unlike Databricks it never reaches sibling databases. Every entry
 * point that takes a `database` argument runs it through this guard: an empty
 * arg means "the pinned database", and any other name is a hard error rather
 * than a silent cross-database query.
 */
function pinnedDatabase(
  managed: ManagedConnection,
  database: string
): DbResult<string> {
  if (!database.trim() || database === managed.database) {
    return { ok: true, data: managed.database }
  }
  return {
    ok: false,
    error: `This connection is pinned to database "${managed.database}".`
  }
}

/** sslmode requested explicitly in a connection URL; null when absent. */
function explicitSslMode(params: ConnectParams): string | null {
  if (!params.useUrl || !params.url.trim()) return null
  try {
    const url = new URL(normalizeConnectionUrl(params.url))
    const mode = url.searchParams.get('sslmode')
    if (mode) return mode.toLowerCase()
    const ssl = url.searchParams.get('ssl')
    if (ssl !== null) return /^(1|true|on)$/i.test(ssl) ? 'require' : 'disable'
    return null
  } catch {
    return null
  }
}

/**
 * How to negotiate TLS, following libpq sslmode semantics. 'auto' (no
 * explicit sslmode, or prefer/allow) tries TLS first and falls back to
 * plaintext; 'tls' (require) uses TLS without certificate verification;
 * 'verify' (verify-ca/verify-full) defers to pg's own verifying handling of
 * the URL and must never be downgraded; 'plain' (disable) never uses TLS.
 */
function sslStrategy(
  params: ConnectParams
): 'auto' | 'plain' | 'tls' | 'verify' {
  const mode = explicitSslMode(params)
  if (mode === null || mode === 'prefer' || mode === 'allow') return 'auto'
  if (mode === 'disable') return 'plain'
  if (mode === 'require') return 'tls'
  return 'verify'
}

/**
 * After a failed TLS-first attempt: is plaintext worth trying? Only when the
 * server can't or won't speak TLS — never for auth or network failures, so
 * credentials are not re-sent over an unexpected downgrade.
 */
function plaintextWorthTrying(error: string): boolean {
  return /does not support SSL|SSL (on|encryption)/i.test(error)
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
  const [schemaRes, relRes, colRes, conRes, idxRes, procRes, typeRes, enumRes] =
    [
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
        reltuples: number
      }>(
        `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
              c.reltuples::float8 AS reltuples
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
      await client.query<{
        reloid: string
        contype: string
        conkey: number[]
        refoid: string | null
        confkey: number[] | null
      }>(
        `SELECT c.conrelid::text AS reloid, c.contype, c.conkey,
              NULLIF(c.confrelid, 0)::text AS refoid, c.confkey
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE c.contype IN ('p', 'f') AND ${SYSTEM_SCHEMA_FILTER}`
      ),
      await client.query<{
        schema: string
        name: string
        reloid: string
        def: string
      }>(
        `SELECT n.nspname AS schema, ci.relname AS name,
              i.indrelid::text AS reloid, pg_get_indexdef(i.indexrelid) AS def
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
      ),
      await client.query<{ schema: string; name: string; label: string }>(
        `SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE ${SYSTEM_SCHEMA_FILTER}
        ORDER BY n.nspname, t.typname, e.enumsortorder`
      )
    ]

  // (reloid, attnum) → column name and reloid → qualified name, so foreign
  // keys can be rendered as "schema.table.column" references.
  const attNames = new Map<string, string>()
  for (const col of colRes.rows)
    attNames.set(`${col.reloid}.${col.attnum}`, col.name)
  const relQualified = new Map<string, string>()
  for (const rel of relRes.rows)
    relQualified.set(rel.oid, `${rel.schema}.${rel.name}`)

  // Column badges: pk wins over fk when a column participates in both.
  const pkCols = new Map<string, Set<number>>()
  const fkCols = new Map<string, Set<number>>()
  const fkRefs = new Map<string, string>()
  for (const con of conRes.rows) {
    const target = con.contype === 'p' ? pkCols : fkCols
    let set = target.get(con.reloid)
    if (!set) target.set(con.reloid, (set = new Set()))
    for (const attnum of con.conkey ?? []) set.add(attnum)
    if (con.contype === 'f' && con.refoid && con.confkey) {
      const refRel = relQualified.get(con.refoid)
      con.conkey?.forEach((attnum, i) => {
        const refCol = attNames.get(`${con.refoid}.${con.confkey?.[i]}`)
        if (refRel && refCol)
          fkRefs.set(`${con.reloid}.${attnum}`, `${refRel}.${refCol}`)
      })
    }
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
    const fkRef = fkRefs.get(`${col.reloid}.${col.attnum}`) ?? null
    list.push({ name: col.name, dataType: col.dtype, badge, fkRef })
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

  const relationByOid = new Map<string, RelationInfo>()
  for (const rel of relRes.rows) {
    const schema = schemaFor(rel.schema)
    if (rel.kind === 'S') {
      schema.sequences.push(rel.name)
      continue
    }
    const relation: RelationInfo = {
      name: rel.name,
      columns: columnsByRel.get(rel.oid) ?? [],
      rowEstimate: rel.kind === 'r' || rel.kind === 'p' ? rel.reltuples : null,
      indexes: []
    }
    relationByOid.set(rel.oid, relation)
    if (rel.kind === 'v') schema.views.push(relation)
    else if (rel.kind === 'm') schema.matviews.push(relation)
    else schema.tables.push(relation)
  }

  for (const idx of idxRes.rows) {
    schemaFor(idx.schema).indexes.push(idx.name)
    relationByOid.get(idx.reloid)?.indexes?.push(compactIndexDef(idx.def))
  }

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
  const enumValues = new Map<string, string[]>()
  for (const row of enumRes.rows) {
    const key = `${row.schema}.${row.name}`
    let values = enumValues.get(key)
    if (!values) enumValues.set(key, (values = []))
    values.push(row.label)
  }

  for (const type of typeRes.rows) {
    const info: TypeInfo = {
      name: type.name,
      kind: TYPE_KIND[type.kind] ?? type.kind,
      values: enumValues.get(`${type.schema}.${type.name}`)
    }
    schemaFor(type.schema).types.push(info)
  }

  return { name: database, schemas: [...schemas.values()] }
}

/** "CREATE UNIQUE INDEX foo ON s.t USING btree (a, b)" → "foo unique btree (a, b)". */
function compactIndexDef(def: string): string {
  const match =
    /^CREATE (UNIQUE )?INDEX (\S+) ON \S+(?:\s+\S+)? USING (.+)$/.exec(def)
  if (!match) return def
  return `${match[2]}${match[1] ? ' unique' : ''} ${match[3]}`
}

async function testOnce(
  params: ConnectParams,
  sslOverride: SslOverride,
  sslActive: boolean = sslOverride ?? false
): Promise<DbResult<TestResult>> {
  const client = new Client(clientConfig(params, sslOverride))
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
        latencyMs: Date.now() - started,
        ssl: sslActive
      }
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    void client.end().catch(() => {})
  }
}

export async function testConnection(
  params: ConnectParams
): Promise<DbResult<TestResult>> {
  switch (sslStrategy(params)) {
    case 'plain':
      return testOnce(params, null, false)
    case 'tls':
      return testOnce(params, true)
    case 'verify':
      return testOnce(params, null, true)
    case 'auto': {
      const tls = await testOnce(params, true)
      if (tls.ok || !plaintextWorthTrying(tls.error)) return tls
      return testOnce(params, false)
    }
  }
}

async function connectOnce(
  connId: string,
  params: ConnectParams,
  ssl: SslOverride
): Promise<DbResult<ConnectResult>> {
  const pool = new Pool({ ...clientConfig(params, ssl), max: 4 })
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    const meta = await client.query<{ db: string; version: string }>(
      'SELECT current_database() AS db, version() AS version'
    )
    const database = meta.rows[0].db
    const connectedDatabase = await introspectWith(client, database)
    connections.set(connId, {
      params,
      pool,
      database,
      ssl,
      typeNames: new Map(),
      serverVersion: parseServerVersion(meta.rows[0].version)
    })
    return {
      ok: true,
      data: {
        serverVersion: parseServerVersion(meta.rows[0].version),
        connectedDatabase,
        // Pinned to exactly one database; no sibling enumeration. The field
        // stays plural for the multi-database engines (Databricks) that fill it.
        databases: [database]
      }
    }
  } catch (err) {
    void pool.end().catch(() => {})
    return { ok: false, error: errorMessage(err) }
  } finally {
    client?.release()
  }
}

export async function connect(
  connId: string,
  params: ConnectParams
): Promise<DbResult<ConnectResult>> {
  if (connections.has(connId)) {
    return { ok: false, error: `Connection "${connId}" already exists` }
  }
  if (resolveDatabase(params) === '') {
    return {
      ok: false,
      error: 'A database is required for PostgreSQL connections.'
    }
  }
  switch (sslStrategy(params)) {
    case 'plain':
    case 'verify':
      // pg enforces the URL's sslmode as written; no override, no retry.
      return connectOnce(connId, params, null)
    case 'tls':
      return connectOnce(connId, params, true)
    case 'auto': {
      const tls = await connectOnce(connId, params, true)
      if (tls.ok || !plaintextWorthTrying(tls.error)) return tls
      return connectOnce(connId, params, false)
    }
  }
}

/**
 * Introspect the connection's pinned database. A mismatched `database`
 * argument is rejected — this connection cannot reach any other database on
 * the server.
 */
export async function introspectDatabase(
  connId: string,
  database: string
): Promise<DbResult<DatabaseIntrospection>> {
  const managed = connections.get(connId)
  if (!managed) return { ok: false, error: 'Connection no longer exists' }
  const pinned = pinnedDatabase(managed, database)
  if (!pinned.ok) return pinned

  let client: PoolClient | undefined
  try {
    client = await managed.pool.connect()
    return { ok: true, data: await introspectWith(client, managed.database) }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    client?.release()
  }
}

/** Server version captured at connect time; null when the connection is gone. */
export function getServerVersion(connId: string): string | null {
  return connections.get(connId)?.serverVersion ?? null
}

export async function disconnect(connId: string): Promise<DbResult<null>> {
  const managed = connections.get(connId)
  if (managed) {
    connections.delete(connId)
    void managed.pool.end().catch(() => {})
  }
  return { ok: true, data: null }
}

export async function disconnectAll(): Promise<void> {
  const pools = [...connections.values()].map((managed) => managed.pool)
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

/**
 * SQLSTATE codes meaning "this statement needs write/DDL privileges".
 * readOnly mode runs with default_transaction_read_only=on, so every
 * transaction the statement starts — implicit, explicit, or after an
 * embedded COMMIT — is read-only; violations fail server-side with these
 * codes without taking effect.
 */
export const PG_READ_ONLY_VIOLATION_CODES = new Set(['25006', '25001'])

/** Cancel a running statement on this server from a separate session. */
async function cancelBackend(
  managed: ManagedConnection,
  pid: number
): Promise<void> {
  let client: PoolClient | undefined
  try {
    client = await managed.pool.connect()
    await client.query('SELECT pg_cancel_backend($1)', [pid])
  } catch {
    // Best effort: the query may already have finished.
  } finally {
    client?.release()
  }
}

async function runQuery(
  connId: string,
  database: string,
  sql: string,
  limit: number | null,
  options: RunQueryOptions = {}
): Promise<DbResult<QueryResult>> {
  const managed = connections.get(connId)
  if (!managed) return { ok: false, error: 'Connection no longer exists' }
  const pinned = pinnedDatabase(managed, database)
  if (!pinned.ok) return pinned

  const prepared =
    limit === null ? { text: sql, applied: false } : applyAutoLimit(sql, limit)
  let client: PoolClient | undefined
  const sessionSettings: string[] = []
  if (options.readOnly) sessionSettings.push('default_transaction_read_only')
  if (options.timeoutMs) sessionSettings.push('statement_timeout')
  try {
    client = await managed.pool.connect()
    const pid = (client as unknown as { processID?: number }).processID
    if (pid && options.onCancel) {
      options.onCancel(() => void cancelBackend(managed, pid))
    }
    if (options.readOnly) {
      await client.query('SET default_transaction_read_only = on')
    }
    if (options.timeoutMs) {
      await client.query(
        `SET statement_timeout = ${Math.floor(options.timeoutMs)}`
      )
    }
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
    return {
      ok: false,
      error: errorMessage(err),
      code: (err as { code?: string }).code
    }
  } finally {
    if (client) {
      // Undo session settings so the pooled connection is clean for the
      // editor path; if that fails, destroy the connection instead of
      // returning a poisoned session to the pool.
      let dirty = false
      for (const setting of sessionSettings) {
        await client.query(`RESET ${setting}`).catch(() => {
          dirty = true
        })
      }
      client.release(dirty ? new Error('session reset failed') : undefined)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Agent catalog helpers                                               *
 * ------------------------------------------------------------------ */

async function withClient<T>(
  connId: string,
  database: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<DbResult<T>> {
  const managed = connections.get(connId)
  if (!managed) return { ok: false, error: 'Connection no longer exists' }
  const pinned = pinnedDatabase(managed, database)
  if (!pinned.ok) return pinned
  let client: PoolClient | undefined
  try {
    client = await managed.pool.connect()
    return { ok: true, data: await fn(client) }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    client?.release()
  }
}

/** "schema.table" / "table" / quoted variants → { schema, name }. */
function parseRelationName(input: string): {
  schema: string | null
  name: string
} {
  const unquote = (part: string): string =>
    part.startsWith('"') && part.endsWith('"') && part.length > 1
      ? part.slice(1, -1).replaceAll('""', '"')
      : part.toLowerCase()
  const parts = input.trim().match(/"(?:[^"]|"")*"|[^.]+/g) ?? [input.trim()]
  if (parts.length >= 2) {
    return { schema: unquote(parts[0]), name: unquote(parts[parts.length - 1]) }
  }
  return { schema: null, name: unquote(parts[0]) }
}

/**
 * Full detail for one relation, formatted as plain text for the agent:
 * columns (type, nullability, default, comment), constraints, indexes,
 * inbound foreign keys, row estimate, and table comment.
 */
export async function describeTable(
  connId: string,
  database: string,
  relationName: string
): Promise<DbResult<string>> {
  const { schema, name } = parseRelationName(relationName)
  return withClient(connId, database, async (client) => {
    const relRes = await client.query<{
      oid: string
      schema: string
      name: string
      kind: string
      reltuples: number
      comment: string | null
    }>(
      `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name,
              c.relkind AS kind, c.reltuples::float8 AS reltuples,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1
          AND ($2::text IS NULL OR n.nspname = $2)
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND ${SYSTEM_SCHEMA_FILTER}
        ORDER BY (n.nspname = 'public') DESC, n.nspname
        LIMIT 5`,
      [name, schema]
    )
    if (relRes.rows.length === 0) {
      return `No table, view, or materialized view named "${relationName}" was found.`
    }
    const rel = relRes.rows[0]
    const oid = rel.oid

    const [colRes, conRes, inRes, idxRes] = [
      await client.query<{
        name: string
        dtype: string
        notnull: boolean
        def: string | null
        comment: string | null
      }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS dtype,
                a.attnotnull AS notnull,
                pg_get_expr(ad.adbin, ad.adrelid) AS def,
                col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [oid]
      ),
      await client.query<{ name: string; def: string }>(
        `SELECT conname AS name, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = $1::oid
          ORDER BY contype, conname`,
        [oid]
      ),
      await client.query<{ src: string; def: string }>(
        `SELECT conrelid::regclass::text AS src, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE confrelid = $1::oid AND contype = 'f'
          ORDER BY conrelid::regclass::text
          LIMIT 50`,
        [oid]
      ),
      await client.query<{ def: string }>(
        `SELECT pg_get_indexdef(indexrelid) AS def
           FROM pg_index
          WHERE indrelid = $1::oid
          ORDER BY indexrelid`,
        [oid]
      )
    ]

    const KIND: Record<string, string> = {
      r: 'table',
      p: 'partitioned table',
      v: 'view',
      m: 'materialized view',
      f: 'foreign table'
    }
    const lines: string[] = [
      `${KIND[rel.kind] ?? 'relation'} ${rel.schema}.${rel.name}` +
        (rel.reltuples >= 0 && (rel.kind === 'r' || rel.kind === 'p')
          ? ` (~${Math.round(rel.reltuples)} rows)`
          : '')
    ]
    if (rel.comment) lines.push(`comment: ${rel.comment}`)
    if (relRes.rows.length > 1) {
      lines.push(
        `note: also exists in schema(s) ${relRes.rows
          .slice(1)
          .map((r) => r.schema)
          .join(', ')}; describing ${rel.schema}.${rel.name}`
      )
    }
    lines.push('', 'columns:')
    for (const col of colRes.rows) {
      let line = `  ${col.name} ${col.dtype}${col.notnull ? ' not null' : ''}`
      if (col.def) line += ` default ${col.def}`
      if (col.comment) line += ` -- ${col.comment}`
      lines.push(line)
    }
    if (conRes.rows.length > 0) {
      lines.push('', 'constraints:')
      for (const con of conRes.rows) lines.push(`  ${con.name}: ${con.def}`)
    }
    if (idxRes.rows.length > 0) {
      lines.push('', 'indexes:')
      for (const idx of idxRes.rows) lines.push(`  ${idx.def}`)
    }
    if (inRes.rows.length > 0) {
      lines.push('', 'referenced by:')
      for (const ref of inRes.rows) lines.push(`  ${ref.src}: ${ref.def}`)
    }
    return lines.join('\n')
  })
}

const SEARCH_RESULT_LIMIT = 50

/**
 * Case-insensitive substring search over relation, column, and function
 * names; returns matches as plain text for the agent.
 */
export async function searchSchema(
  connId: string,
  database: string,
  pattern: string
): Promise<DbResult<string>> {
  const like = `%${pattern.replace(/([%_\\])/g, '\\$1')}%`
  return withClient(connId, database, async (client) => {
    const [relRes, colRes, procRes] = [
      await client.query<{ schema: string; name: string; kind: string }>(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND c.relname ILIKE $1 AND ${SYSTEM_SCHEMA_FILTER}
          ORDER BY n.nspname, c.relname
          LIMIT ${SEARCH_RESULT_LIMIT + 1}`,
        [like]
      ),
      await client.query<{
        schema: string
        rel: string
        name: string
        dtype: string
      }>(
        `SELECT n.nspname AS schema, c.relname AS rel, a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS dtype
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname ILIKE $1 AND ${SYSTEM_SCHEMA_FILTER}
          ORDER BY n.nspname, c.relname, a.attnum
          LIMIT ${SEARCH_RESULT_LIMIT + 1}`,
        [like]
      ),
      await client.query<{ schema: string; name: string; args: string }>(
        `SELECT n.nspname AS schema, p.proname AS name,
                pg_get_function_arguments(p.oid) AS args
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname ILIKE $1 AND ${SYSTEM_SCHEMA_FILTER}
          ORDER BY n.nspname, p.proname
          LIMIT ${SEARCH_RESULT_LIMIT + 1}`,
        [like]
      )
    ]

    const KIND: Record<string, string> = {
      r: 'table',
      p: 'partitioned table',
      v: 'view',
      m: 'materialized view',
      f: 'foreign table'
    }
    const section = <T>(
      title: string,
      rows: T[],
      render: (row: T) => string
    ): string[] => {
      if (rows.length === 0) return []
      const shown = rows.slice(0, SEARCH_RESULT_LIMIT)
      const lines = [`${title}:`, ...shown.map((row) => `  ${render(row)}`)]
      if (rows.length > SEARCH_RESULT_LIMIT) {
        lines.push(`  … more matches exist; narrow the pattern`)
      }
      return lines
    }

    const lines = [
      ...section(
        'relations',
        relRes.rows,
        (r) => `${KIND[r.kind] ?? r.kind} ${r.schema}.${r.name}`
      ),
      ...section(
        'columns',
        colRes.rows,
        (c) => `${c.schema}.${c.rel}.${c.name} ${c.dtype}`
      ),
      ...section(
        'functions',
        procRes.rows,
        (p) => `${p.schema}.${p.name}(${p.args})`
      )
    ]
    return lines.length > 0
      ? lines.join('\n')
      : `No relations, columns, or functions match "${pattern}".`
  })
}

export const postgresDriver: Driver = {
  test: testConnection,
  connect,
  disconnect,
  disconnectAll,
  getServerVersion,
  introspectDatabase,
  runQuery,
  describeTable,
  searchSchema
}
