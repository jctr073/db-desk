/**
 * Main-process knowledge store: persists per-(connection, database) knowledge
 * records as pretty-printed JSON under `userData/knowledge/`, following the
 * house pattern of `files.ts`/`store.ts` (module-level cache, ensureDir,
 * load/persist, CRUD, cascade delete). No secrets live here, so — unlike
 * `store.ts`/`mcp.ts` — there is no safeStorage and the files stay 0o644.
 *
 * The renderer talks to it through `knowledge:*` IPC handles and receives a
 * `knowledge:changed` push after each successful save/delete. The agent write
 * path reuses `validateKnowledgeRecord` so UI and agent share one contract.
 */

import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { databaseSlug } from '../shared/knowledge'
import type {
  ColumnRef,
  KnowledgeRecord,
  KnowledgeRecordInput
} from '../shared/knowledge'

/** Current on-disk file format version. */
const FILE_VERSION = 1

/**
 * On-disk shape of one (connection, database) file. `rawDatabase` preserves
 * the un-slugged database name; `records` is preserved verbatim on load,
 * including records of unknown `kind` (forward compatibility — never drop).
 */
interface KnowledgeFile {
  version: number
  rawDatabase: string
  records: KnowledgeRecord[]
}

/** connId:database -> records; lazily loaded, one entry per opened database. */
const cache = new Map<string, KnowledgeRecord[]>()

function cacheKey(connId: string, database: string): string {
  return `${connId}:${database}`
}

function knowledgeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

/**
 * connId is renderer-supplied and becomes a path segment, so it must never be
 * able to escape `knowledge/` (`deleteForConnection('..')` would otherwise
 * rmSync the entire userData dir). House connection ids are `c-<ts>-<seq>`;
 * anything outside that alphabet fails closed, same trust model as the
 * renderer-tampering guards in agent.ts.
 */
function assertSafeConnId(connId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(connId)) {
    throw new Error(`Invalid connection id: ${JSON.stringify(connId)}`)
  }
}

function connDir(connId: string): string {
  assertSafeConnId(connId)
  return join(knowledgeDir(), connId)
}

function databasePath(connId: string, database: string): string {
  return join(connDir(connId), `${databaseSlug(database)}.json`)
}

function ensureConnDir(connId: string): void {
  const dir = connDir(connId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * A file we cannot read as `{ records: [...] }` must never be silently treated
 * as empty: the next save would persist over it and destroy every record the
 * user (or a hand-edit gone wrong) had in there. Move it aside instead — the
 * store starts fresh and the original stays recoverable next to it.
 */
function quarantineCorruptFile(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    // Rename failed (permissions?): leave the file; loading still returns
    // empty, and the non-atomic-overwrite risk is the lesser evil here.
  }
}

/**
 * Keep an on-disk entry only if it is an object with a string `kind` and `id`.
 * Unknown kinds pass (forward compat — preserve, don't render); `null` or
 * shapeless entries from hand edits/bad merges are dropped so they cannot
 * crash prompt building or the renderer's usage index.
 */
function isLoadableRecord(value: unknown): value is KnowledgeRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.kind === 'string' && typeof r.id === 'string'
}

function load(connId: string, database: string): KnowledgeRecord[] {
  const key = cacheKey(connId, database)
  const cached = cache.get(key)
  if (cached) return cached
  let records: KnowledgeRecord[] = []
  const path = databasePath(connId, database)
  if (existsSync(path)) {
    let parsed: unknown
    let readable: boolean
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
      readable =
        !!parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as KnowledgeFile).records)
    } catch {
      readable = false
    }
    if (readable) {
      // Preserve records verbatim, including unknown kinds.
      records = (parsed as KnowledgeFile).records.filter(isLoadableRecord)
    } else {
      console.error(`knowledge: unreadable file quarantined: ${path}`)
      quarantineCorruptFile(path)
    }
  }
  cache.set(key, records)
  return records
}

function persist(
  connId: string,
  database: string,
  records: KnowledgeRecord[]
): void {
  cache.set(cacheKey(connId, database), records)
  ensureConnDir(connId)
  const file: KnowledgeFile = {
    version: FILE_VERSION,
    rawDatabase: database,
    records
  }
  // Temp-file + rename so a crash mid-write cannot truncate the canonical
  // file (which load() would then quarantine, losing nothing but continuity).
  const path = databasePath(connId, database)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, path)
}

function generateId(): string {
  return `kn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// --- Validation ------------------------------------------------------------

/** No real identifier contains control characters; rejecting them here keeps
 * ref names single-line wherever they are interpolated (prompt, describe). */
// eslint-disable-next-line no-control-regex -- filtering control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function isColumnRef(value: unknown): value is ColumnRef {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (typeof r.schema !== 'string' || typeof r.table !== 'string') return false
  if (r.column !== undefined && typeof r.column !== 'string') return false
  return ![r.schema, r.table, r.column ?? ''].some((part) =>
    CONTROL_CHARS.test(part as string)
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isColumnRefArray(value: unknown): value is ColumnRef[] {
  return Array.isArray(value) && value.every(isColumnRef)
}

function isColumnRefMap(value: unknown): value is Record<string, ColumnRef> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isColumnRef)
}

function isMappingArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every((m) => {
    if (!m || typeof m !== 'object') return false
    const mm = m as Record<string, unknown>
    if (!isColumnRef(mm.ref)) return false
    if (mm.caveat !== undefined && typeof mm.caveat !== 'string') return false
    return true
  })
}

/**
 * Throws if `record` is not a well-formed knowledge record for its `kind`.
 * Envelope-managed fields (`id`, `createdAt`, `updatedAt`) are intentionally
 * not required here — `saveRecord` mints them. Exported so the agent
 * `save_knowledge` tool validates identically to `knowledge:save`.
 */
export function validateKnowledgeRecord(record: unknown): void {
  if (!record || typeof record !== 'object') {
    throw new Error('Knowledge record must be an object')
  }
  const r = record as Record<string, unknown>
  if (r.source !== 'human' && r.source !== 'agent') {
    throw new Error(`Invalid knowledge source: ${String(r.source)}`)
  }
  if (
    r.confidence !== undefined &&
    r.confidence !== 'high' &&
    r.confidence !== 'medium' &&
    r.confidence !== 'low'
  ) {
    throw new Error(`Invalid knowledge confidence: ${String(r.confidence)}`)
  }
  if (r.provenance !== undefined && typeof r.provenance !== 'string') {
    throw new Error('Knowledge provenance must be a string')
  }
  // A falsy-but-present id ('') would skip the update lookup yet be stored
  // verbatim, minting colliding empty ids that deleteRecord then mass-deletes.
  if (r.id !== undefined && (typeof r.id !== 'string' || r.id === '')) {
    throw new Error('Knowledge id must be a non-empty string when present')
  }
  switch (r.kind) {
    case 'annotation':
      if (!isColumnRef(r.target)) {
        throw new Error('annotation.target must be a ColumnRef')
      }
      if (typeof r.text !== 'string') {
        throw new Error('annotation.text must be a string')
      }
      break
    case 'relationship':
      if (r.relType !== 'standard' && r.relType !== 'polymorphic') {
        throw new Error(
          'relationship.relType must be "standard" or "polymorphic"'
        )
      }
      if (!isColumnRef(r.from) || r.from.column === undefined) {
        throw new Error('relationship.from must be a ColumnRef with a column')
      }
      if (r.relType === 'standard') {
        if (!isColumnRef(r.to)) {
          throw new Error('standard relationship requires a "to" ColumnRef')
        }
      } else {
        if (!isColumnRef(r.discriminator)) {
          throw new Error(
            'polymorphic relationship requires a "discriminator" ColumnRef'
          )
        }
        if (!isColumnRefMap(r.targets)) {
          throw new Error(
            'polymorphic relationship requires a "targets" map of ColumnRefs'
          )
        }
      }
      if (r.notes !== undefined && typeof r.notes !== 'string') {
        throw new Error('relationship.notes must be a string')
      }
      break
    case 'glossary':
      if (typeof r.term !== 'string' || r.term === '') {
        throw new Error('glossary.term must be a non-empty string')
      }
      if (!isStringArray(r.synonyms)) {
        throw new Error('glossary.synonyms must be a string array')
      }
      if (r.definition !== undefined && typeof r.definition !== 'string') {
        throw new Error('glossary.definition must be a string')
      }
      if (!isMappingArray(r.mappings)) {
        throw new Error(
          'glossary.mappings must be an array of { ref, caveat? }'
        )
      }
      break
    case 'exemplar':
      if (typeof r.question !== 'string') {
        throw new Error('exemplar.question must be a string')
      }
      if (typeof r.sql !== 'string') {
        throw new Error('exemplar.sql must be a string')
      }
      if (!isColumnRefArray(r.references)) {
        throw new Error('exemplar.references must be a ColumnRef array')
      }
      break
    case 'note':
      if (typeof r.title !== 'string') {
        throw new Error('note.title must be a string')
      }
      if (typeof r.body !== 'string') {
        throw new Error('note.body must be a string')
      }
      if (!isColumnRefArray(r.references)) {
        throw new Error('note.references must be a ColumnRef array')
      }
      break
    default:
      throw new Error(`Unknown knowledge kind: ${String(r.kind)}`)
  }
}

// --- Public API ------------------------------------------------------------

export function listRecords(
  connId: string,
  database: string
): KnowledgeRecord[] {
  return load(connId, database)
}

/**
 * Create or update a record. A record whose `id` matches an existing one is
 * updated in place (preserving `createdAt`); otherwise a new record is minted.
 * Validates the payload for its `kind` and stamps timestamps.
 */
export function saveRecord(
  connId: string,
  database: string,
  record: KnowledgeRecordInput
): KnowledgeRecord {
  validateKnowledgeRecord(record)
  const records = [...load(connId, database)]
  const now = Date.now()
  const index = record.id ? records.findIndex((r) => r.id === record.id) : -1
  let saved: KnowledgeRecord
  if (index >= 0) {
    const prev = records[index]
    saved = {
      ...record,
      id: prev.id,
      createdAt: prev.createdAt,
      updatedAt: now
    } as KnowledgeRecord
    records[index] = saved
  } else {
    saved = {
      ...record,
      id: record.id ?? generateId(),
      createdAt: now,
      updatedAt: now
    } as KnowledgeRecord
    records.push(saved)
  }
  persist(connId, database, records)
  return saved
}

export function deleteRecord(
  connId: string,
  database: string,
  id: string
): void {
  const records = load(connId, database)
  if (records.some((r) => r.id === id)) {
    persist(
      connId,
      database,
      records.filter((r) => r.id !== id)
    )
  }
}

/**
 * Remove the knowledge base for one database without touching knowledge for
 * other databases reached through the same connection.
 */
export function deleteForDatabase(connId: string, database: string): void {
  const path = databasePath(connId, database)
  if (existsSync(path)) rmSync(path, { force: true })
  cache.delete(cacheKey(connId, database))
}

/**
 * Remove all knowledge for a connection (mirror of
 * `deleteQueriesForConnection`): delete the whole `knowledge/<connId>/`
 * directory and evict its cache entries.
 */
export function deleteForConnection(connId: string): void {
  const dir = connDir(connId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  const prefix = `${connId}:`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/**
 * Delete the entire knowledge store and clear the in-memory cache. Takes no
 * arguments and derives its target from `knowledgeDir()` alone, so — unlike
 * `deleteForConnection` — there is no caller-supplied path segment and it can
 * never be aimed anywhere outside `<userData>/knowledge`. Used by store.ts to
 * wipe knowledge as part of the one-time fresh-start reset when
 * `connections.json` is found in its pre-version-2 (pre-single-database)
 * shape. A missing directory is not an error: there may be nothing to wipe.
 */
export function wipeAll(): void {
  const dir = knowledgeDir()
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  cache.clear()
}
