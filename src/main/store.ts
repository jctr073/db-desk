import { app, safeStorage } from 'electron'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalizeConnectionUrl } from '../shared/connectionUrl'
import type { ConnectionType } from '../shared/dialect'
import type { ConnectParams, SavedConnection } from '../shared/db'
import type { SchemaSelectionConfig } from '../shared/schemaSelection'
import { wipeAll as wipeKnowledge } from './knowledge'

/**
 * On-disk shape of a saved connection. `secret` is the password (or access
 * token, for engines that use one) encrypted with Electron's safeStorage
 * (OS keychain-backed), base64-encoded; it is absent when the user chose
 * not to save it or when encryption is unavailable on this system. The
 * `url` field is stored with any password component removed. `type` is
 * absent on records written before connection types existed (PostgreSQL).
 */
interface StoredRecord {
  id: string
  name: string
  type?: ConnectionType
  host: string
  port: string
  database: string
  user: string
  httpPath?: string
  url: string
  useUrl: boolean
  secret?: string
  /**
   * Multi-database engines (Databricks): catalogs to show in the tree;
   * absent = all. Optional additions like this stay within store version 2 —
   * older builds still read the file (they just ignore the fields).
   */
  catalogSelection?: string[]
  /** Catalog name → pinned schema names; absent key = all schemas. */
  schemaSelections?: Record<string, string[]>
}

/**
 * On-disk file format, versioned since the fresh-start reset below (v2).
 * `version` is checked exactly (not `>=`), so a future v3 migration has an
 * unambiguous "this is still v2" signal to key off of.
 */
interface StoredFile {
  version: number
  connections: StoredRecord[]
}

const STORE_VERSION = 2

let cache: StoredRecord[] | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'connections.json')
}

function isStoredFile(value: unknown): value is StoredFile {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as StoredFile).version === STORE_VERSION &&
    Array.isArray((value as StoredFile).connections)
  )
}

function load(): StoredRecord[] {
  if (cache) return cache
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(storePath(), 'utf8'))
  } catch {
    // Missing file (first run) or unparseable JSON: start from an empty,
    // current-version store. Nothing to migrate, so nothing to persist yet —
    // the next save() call will write a proper version-2 file.
    cache = []
    return cache
  }
  if (isStoredFile(parsed)) {
    cache = parsed.connections
    return cache
  }
  if (Array.isArray(parsed)) {
    // Pre-version-2 files were a bare array of StoredRecord, written before
    // PostgreSQL connections became pinned to a single database chosen at
    // connect time. Those records' `database`/`url` fields predate that
    // change, and silently reinterpreting them under the new single-database
    // model risks reconnecting a saved connection to the wrong database. The
    // user has approved a clean break instead (this is a pre-1.0 app): drop
    // every saved connection and its associated knowledge base, then start
    // over on an empty, versioned store. Running this here (rather than in
    // index.ts) makes the reset lazy — it fires exactly once, the first time
    // anything touches the connection store after upgrading — and writing
    // the empty version-2 file immediately below is what makes it a one-time
    // event: the next load() sees a version-2 file and takes the branch
    // above instead of this one.
    wipeKnowledge()
    cache = []
    persist(cache)
    return cache
  }
  // Recognizable JSON but neither shape (e.g. `{}`, a number, `null`):
  // treat like a corrupt file rather than guessing at intent.
  cache = []
  return cache
}

function persist(records: StoredRecord[]): void {
  cache = records
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  const file: StoredFile = { version: STORE_VERSION, connections: records }
  // Owner-only: the file holds connection metadata and encrypted secrets.
  writeFileSync(path, JSON.stringify(file, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
  try {
    // mode above only applies on creation; tighten pre-existing files too.
    chmodSync(path, 0o600)
  } catch {
    // best effort (e.g. filesystems without POSIX permissions)
  }
}

function toPublic(record: StoredRecord): SavedConnection {
  return {
    id: record.id,
    name: record.name,
    type: record.type ?? 'postgres',
    host: record.host,
    port: record.port,
    database: record.database,
    user: record.user,
    httpPath: record.httpPath ?? '',
    url: record.url,
    useUrl: record.useUrl,
    hasPassword: !!record.secret
  }
}

/**
 * Best-effort removal of the password from a URL that new URL() cannot
 * parse. Greedy up to the last "@" before the path, so passwords containing
 * "@" are fully removed.
 */
function redactUrlPassword(url: string): string {
  return url.replace(/^([^:]*:\/\/[^/@]*):[^/]*@/, '$1@')
}

/** Split a connection URL into its password and the URL without it. */
function splitUrlPassword(rawUrl: string): { url: string; password: string } {
  const normalized = normalizeConnectionUrl(rawUrl)
  try {
    const url = new URL(normalized)
    const password = url.password ? decodeURIComponent(url.password) : ''
    url.password = ''
    return { url: url.toString(), password }
  } catch {
    // Unparseable URLs must never be persisted with a credential section.
    return { url: redactUrlPassword(normalized), password: '' }
  }
}

function encrypt(password: string): string | undefined {
  if (!password || !safeStorage.isEncryptionAvailable()) return undefined
  return safeStorage.encryptString(password).toString('base64')
}

function decrypt(secret: string | undefined): string {
  if (!secret) return ''
  try {
    return safeStorage.decryptString(Buffer.from(secret, 'base64'))
  } catch {
    return ''
  }
}

export function listSaved(): SavedConnection[] {
  return load().map(toPublic)
}

export function saveConnection(
  id: string,
  name: string,
  params: ConnectParams,
  savePassword: boolean
): SavedConnection {
  const { url, password: urlPassword } = splitUrlPassword(params.url)
  const password = params.useUrl ? urlPassword : params.password
  const record: StoredRecord = {
    id,
    name,
    type: params.type ?? 'postgres',
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    httpPath: params.httpPath,
    url,
    useUrl: params.useUrl,
    secret: savePassword ? encrypt(password) : undefined
  }
  const records = [...load()]
  const index = records.findIndex((existing) => existing.id === id)
  if (index >= 0) {
    // Re-saving rebuilds the record from the form's fields; carry over the
    // schema/catalog selections, which the form doesn't know about.
    record.catalogSelection = records[index].catalogSelection
    record.schemaSelections = records[index].schemaSelections
    records[index] = record
  } else {
    records.push(record)
  }
  persist(records)
  return toPublic(record)
}

export function deleteSaved(id: string): void {
  persist(load().filter((record) => record.id !== id))
}

/** Catalogs pinned for a connection; null = all (no selection saved). */
export function catalogSelectionFor(id: string): string[] | null {
  return load().find((record) => record.id === id)?.catalogSelection ?? null
}

/** Schemas pinned for one catalog; null = all (no selection saved). */
export function schemaSelectionFor(id: string, catalog: string): string[] | null {
  const record = load().find((candidate) => candidate.id === id)
  return record?.schemaSelections?.[catalog] ?? null
}

/** Full selection config for a connection, for the renderer. */
export function getSchemaConfig(id: string): SchemaSelectionConfig {
  const record = load().find((candidate) => candidate.id === id)
  return {
    catalogs: record?.catalogSelection ?? null,
    schemas: record?.schemaSelections ?? {}
  }
}

/** Replace the complete catalog/schema selection in one persisted update. */
export function setSchemaConfig(
  id: string,
  config: SchemaSelectionConfig
): void {
  const records = [...load()]
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) return
  const record = { ...records[index] }
  if (config.catalogs) record.catalogSelection = [...config.catalogs]
  else delete record.catalogSelection

  const schemaSelections = Object.fromEntries(
    Object.entries(config.schemas).map(([catalog, schemas]) => [
      catalog,
      [...schemas]
    ])
  )
  if (Object.keys(schemaSelections).length > 0) {
    record.schemaSelections = schemaSelections
  } else {
    delete record.schemaSelections
  }
  records[index] = record
  persist(records)
}

/** Pin the catalogs shown for a connection; null clears (back to all). */
export function setCatalogSelection(id: string, catalogs: string[] | null): void {
  const records = [...load()]
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) return
  const record = { ...records[index] }
  if (catalogs) record.catalogSelection = catalogs
  else delete record.catalogSelection
  records[index] = record
  persist(records)
}

/** Pin the schemas of one catalog; null clears (back to all). */
export function setSchemaSelection(
  id: string,
  catalog: string,
  schemas: string[] | null
): void {
  const records = [...load()]
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) return
  const record = { ...records[index] }
  const selections = { ...record.schemaSelections }
  if (schemas) selections[catalog] = schemas
  else delete selections[catalog]
  if (Object.keys(selections).length > 0) record.schemaSelections = selections
  else delete record.schemaSelections
  records[index] = record
  persist(records)
}

/** Full ConnectParams (password decrypted, re-injected into the URL) for a saved connection. */
export function savedParams(id: string): ConnectParams | null {
  const record = load().find((candidate) => candidate.id === id)
  if (!record) return null
  const password = decrypt(record.secret)
  let url = record.url
  if (record.useUrl && password) {
    try {
      const parsed = new URL(url)
      parsed.password = encodeURIComponent(password)
      url = parsed.toString()
    } catch {
      // keep the stored URL as-is; the connection attempt will surface the problem
    }
  }
  return {
    type: record.type ?? 'postgres',
    host: record.host,
    port: record.port,
    database: record.database,
    user: record.user,
    password,
    httpPath: record.httpPath ?? '',
    url,
    useUrl: record.useUrl
  }
}
