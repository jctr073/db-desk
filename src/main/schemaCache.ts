/**
 * Persistent per-connection cache of database introspection results, so a
 * reconnect can paint the object tree instantly while the facade (db.ts)
 * revalidates in the background.
 *
 * One JSON file per saved connection under userData/schema-cache/. Every file
 * is stamped with an identity fingerprint of the connection parameters
 * (credentials excluded) — if the profile is edited to point elsewhere, the
 * stale file is discarded rather than migrated: everything here is
 * rebuildable from the server, so the failure mode of any mismatch (version,
 * identity, schema pinning) is always "drop and re-introspect", never
 * "guess".
 */

import { app } from 'electron'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { normalizeConnectionUrl } from '../shared/connectionUrl'
import type { ConnectParams, DatabaseIntrospection } from '../shared/db'

const CACHE_VERSION = 1

interface CachedIntrospection {
  savedAt: number
  /**
   * Schema pinning in effect when this entry was introspected (Databricks);
   * null = unpinned/all. A lookup under a different pinning is a miss — the
   * cached shape would silently show the wrong schema set.
   */
  schemaSelection: string[] | null
  data: DatabaseIntrospection
}

interface CacheFile {
  version: number
  identity: string
  savedAt: number
  /** Reachable databases/catalogs as of the last validation (unfiltered). */
  databases: string[]
  /** Database (catalog) name → cached introspection. */
  introspections: Record<string, CachedIntrospection>
}

/** connId → parsed file; null = known absent/invalid. */
const memo = new Map<string, CacheFile | null>()

function cacheDir(): string {
  return join(app.getPath('userData'), 'schema-cache')
}

function pathFor(connId: string): string {
  return join(cacheDir(), `${connId}.json`)
}

function stripUrlPassword(raw: string): string {
  const normalized = normalizeConnectionUrl(raw)
  try {
    const url = new URL(normalized)
    url.password = ''
    return url.toString()
  } catch {
    // Same greedy fallback the connection store uses for unparseable URLs.
    return normalized.replace(/^([^:]*:\/\/[^/@]*):[^/]*@/, '$1@')
  }
}

/**
 * Fingerprint of everything that determines *what server and database* a
 * profile points at. Credentials are excluded on purpose: a rotated password
 * doesn't invalidate metadata, and secrets must never land in these files.
 */
export function cacheIdentityFor(params: ConnectParams): string {
  return JSON.stringify({
    type: params.type ?? 'postgres',
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    httpPath: params.httpPath,
    useUrl: params.useUrl,
    url: params.useUrl ? stripUrlPassword(params.url) : ''
  })
}

function isCacheFile(value: unknown): value is CacheFile {
  const file = value as CacheFile
  return (
    !!value &&
    typeof value === 'object' &&
    file.version === CACHE_VERSION &&
    typeof file.identity === 'string' &&
    Array.isArray(file.databases) &&
    !!file.introspections &&
    typeof file.introspections === 'object'
  )
}

/**
 * The cache for a connection, or null when none is usable. A file whose
 * version or identity doesn't match is deleted on sight.
 */
export function loadCacheFile(connId: string, identity: string): CacheFile | null {
  const known = memo.get(connId)
  if (known !== undefined) {
    return known && known.identity === identity ? known : null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(pathFor(connId), 'utf8'))
  } catch {
    memo.set(connId, null)
    return null
  }
  if (!isCacheFile(parsed) || parsed.identity !== identity) {
    deleteCacheFor(connId)
    return null
  }
  memo.set(connId, parsed)
  return parsed
}

function persist(connId: string, file: CacheFile): void {
  memo.set(connId, file)
  mkdirSync(cacheDir(), { recursive: true })
  const path = pathFor(connId)
  // No secrets in here, but schema layouts are still the user's business.
  writeFileSync(path, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // best effort (e.g. filesystems without POSIX permissions)
  }
}

function fileFor(connId: string, identity: string): CacheFile {
  return (
    loadCacheFile(connId, identity) ?? {
      version: CACHE_VERSION,
      identity,
      savedAt: Date.now(),
      databases: [],
      introspections: {}
    }
  )
}

/** Order-insensitive equality of two pinnings; null only matches null. */
export function sameSelection(
  a: string[] | null,
  b: string[] | null
): boolean {
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((name) => bSet.has(name))
}

/** Cached introspection for one database, honoring the pinning stamp. */
export function cachedIntrospection(
  connId: string,
  identity: string,
  database: string,
  selection: string[] | null
): DatabaseIntrospection | null {
  const entry = loadCacheFile(connId, identity)?.introspections[database]
  if (!entry || !sameSelection(entry.schemaSelection, selection)) return null
  return entry.data
}

export function saveIntrospection(
  connId: string,
  identity: string,
  database: string,
  selection: string[] | null,
  data: DatabaseIntrospection
): void {
  const file = fileFor(connId, identity)
  file.savedAt = Date.now()
  file.introspections[database] = {
    savedAt: Date.now(),
    schemaSelection: selection ? [...selection] : null,
    data
  }
  if (!file.databases.includes(database)) file.databases.push(database)
  persist(connId, file)
}

/** Record the reachable database/catalog list (unfiltered by any pinning). */
export function saveDatabases(
  connId: string,
  identity: string,
  databases: string[]
): void {
  const file = fileFor(connId, identity)
  file.savedAt = Date.now()
  file.databases = [...databases]
  persist(connId, file)
}

/**
 * Drop one database's cached introspection (e.g. its pinning changed).
 * Reads the file directly when it hasn't been loaded this session — the
 * identity check doesn't matter for a deletion.
 */
export function dropIntrospection(connId: string, database: string): void {
  let file = memo.get(connId)
  if (file === undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(pathFor(connId), 'utf8'))
    } catch {
      memo.set(connId, null)
      return
    }
    if (!isCacheFile(parsed)) {
      deleteCacheFor(connId)
      return
    }
    file = parsed
    memo.set(connId, file)
  }
  if (!file?.introspections[database]) return
  delete file.introspections[database]
  persist(connId, file)
}

export function deleteCacheFor(connId: string): void {
  memo.set(connId, null)
  try {
    rmSync(pathFor(connId), { force: true })
  } catch {
    // best effort; a leftover file is re-checked (and discarded) on next load
  }
}
