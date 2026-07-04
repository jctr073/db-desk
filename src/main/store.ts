import { app, safeStorage } from 'electron'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalizeConnectionUrl } from '../shared/connectionUrl'
import type { ConnectParams, SavedConnection } from '../shared/db'

/**
 * On-disk shape of a saved connection. `secret` is the password encrypted
 * with Electron's safeStorage (OS keychain-backed), base64-encoded; it is
 * absent when the user chose not to save the password or when encryption is
 * unavailable on this system. The `url` field is stored with any password
 * component removed.
 */
interface StoredRecord {
  id: string
  name: string
  host: string
  port: string
  database: string
  user: string
  url: string
  useUrl: boolean
  secret?: string
}

let cache: StoredRecord[] | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'connections.json')
}

function load(): StoredRecord[] {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf8'))
    cache = Array.isArray(parsed) ? (parsed as StoredRecord[]) : []
  } catch {
    cache = []
  }
  return cache
}

function persist(records: StoredRecord[]): void {
  cache = records
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  // Owner-only: the file holds connection metadata and encrypted secrets.
  writeFileSync(path, JSON.stringify(records, null, 2), {
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
    host: record.host,
    port: record.port,
    database: record.database,
    user: record.user,
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
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    url,
    useUrl: params.useUrl,
    secret: savePassword ? encrypt(password) : undefined
  }
  const records = [...load()]
  const index = records.findIndex((existing) => existing.id === id)
  if (index >= 0) records[index] = record
  else records.push(record)
  persist(records)
  return toPublic(record)
}

export function deleteSaved(id: string): void {
  persist(load().filter((record) => record.id !== id))
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
    host: record.host,
    port: record.port,
    database: record.database,
    user: record.user,
    password,
    url,
    useUrl: record.useUrl
  }
}
