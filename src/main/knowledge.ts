/**
 * Main-process knowledge store: persists free-standing knowledge bases (named
 * collections of knowledge records, typically one per code repository) as
 * pretty-printed JSON under `userData/knowledge/bases/`, plus a link table
 * (`knowledge/links.json`) that attaches each base to any number of
 * (connection, database) targets — optionally scoped to one schema of that
 * database. One repo backing prod/staging/dev = one base, three links; two
 * repos writing to one database = two bases linked to the same target.
 *
 * Follows the house pattern of `files.ts`/`store.ts` (module-level cache,
 * ensureDir, load/persist, CRUD). No secrets live here, so — unlike
 * `store.ts`/`mcp.ts` — there is no safeStorage and the files stay 0o644.
 * The codebase attachment (repo root) lives on the base itself; the path is
 * only ever set from a main-process directory picker (see repo.ts).
 *
 * v1 of this store kept one file per (connection, database) under
 * `knowledge/<connId>/<dbSlug>.json` and repo roots in a per-connection
 * `repo-roots.json`; `migrateLegacyKnowledge` converts that layout once at
 * startup, moving the old files to `knowledge/legacy-v1/` as a backup.
 *
 * The renderer talks to it through `knowledge:*` IPC handles and receives a
 * `knowledge:changed` push after each successful save/delete. The agent write
 * path reuses `validateKnowledgeRecord` so UI and agent share one contract.
 */

import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { pickDefaultLink } from '../shared/knowledge'
import type {
  ColumnRef,
  KnowledgeBase,
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeLinkInput,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeTargetGroup
} from '../shared/knowledge'

/** Current on-disk version of a base file (v1 = per-(conn, db) files). */
const BASE_FILE_VERSION = 2
/** Current on-disk version of the link table. */
const LINKS_FILE_VERSION = 1
/** Longest accepted base name / schema scope (UI fields, prompt headers). */
const MAX_NAME_CHARS = 120

/**
 * On-disk shape of one knowledge base: identity + metadata and its records.
 * `records` is preserved verbatim on load, including records of unknown
 * `kind` (forward compatibility — never drop).
 */
interface BaseFile {
  version: number
  base: KnowledgeBase
  records: KnowledgeRecord[]
}

/** On-disk shape of the link table. */
interface LinksFile {
  version: number
  links: KnowledgeLink[]
}

interface LoadedBase {
  base: KnowledgeBase
  records: KnowledgeRecord[]
}

/** kbId -> base + records; lazily loaded, one entry per touched base. */
const baseCache = new Map<string, LoadedBase>()
/** The whole link table, or null before first load. */
let linksCache: KnowledgeLink[] | null = null

function knowledgeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

function basesDir(): string {
  return join(knowledgeDir(), 'bases')
}

function linksPath(): string {
  return join(knowledgeDir(), 'links.json')
}

/**
 * Ids are renderer-supplied over IPC and become path segments, so they must
 * never be able to escape `knowledge/bases/` (`deleteBase('..')` would
 * otherwise rmSync outside the store). House ids are `kb-<ts>-<rand>`;
 * anything outside that alphabet fails closed, same trust model as the
 * renderer-tampering guards in agent.ts.
 */
function assertSafeId(id: string, what: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ${what} id: ${JSON.stringify(id)}`)
  }
}

function basePath(kbId: string): string {
  assertSafeId(kbId, 'knowledge base')
  return join(basesDir(), `${kbId}.json`)
}

function ensureBasesDir(): void {
  const dir = basesDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * A file we cannot read must never be silently treated as empty: the next
 * save would persist over it and destroy every record the user (or a
 * hand-edit gone wrong) had in there. Move it aside instead — the store
 * starts fresh and the original stays recoverable next to it.
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

/** No real name contains control characters; also keeps prompt headers
 * single-line wherever base names / schema scopes are interpolated. */
// eslint-disable-next-line no-control-regex -- filtering control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function validateName(name: unknown, what: string): string {
  if (typeof name !== 'string') throw new Error(`${what} must be a string`)
  const trimmed = name.trim()
  if (trimmed === '') throw new Error(`${what} must not be empty`)
  if (trimmed.length > MAX_NAME_CHARS) {
    throw new Error(`${what} must be at most ${MAX_NAME_CHARS} characters`)
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error(`${what} must not contain control characters`)
  }
  return trimmed
}

function isBaseMeta(value: unknown): value is KnowledgeBase {
  if (!value || typeof value !== 'object') return false
  const b = value as Record<string, unknown>
  return (
    typeof b.id === 'string' &&
    typeof b.name === 'string' &&
    (b.repoRoot === null || typeof b.repoRoot === 'string') &&
    typeof b.createdAt === 'number' &&
    typeof b.updatedAt === 'number'
  )
}

function loadBase(kbId: string): LoadedBase | null {
  assertSafeId(kbId, 'knowledge base')
  const cached = baseCache.get(kbId)
  if (cached) return cached
  const path = basePath(kbId)
  if (!existsSync(path)) return null
  let parsed: unknown
  let readable: boolean
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
    readable =
      !!parsed &&
      typeof parsed === 'object' &&
      isBaseMeta((parsed as BaseFile).base) &&
      Array.isArray((parsed as BaseFile).records)
  } catch {
    readable = false
  }
  if (!readable) {
    console.error(`knowledge: unreadable base file quarantined: ${path}`)
    quarantineCorruptFile(path)
    return null
  }
  const file = parsed as BaseFile
  const loaded: LoadedBase = {
    // The filename is the id the rest of the store resolved; a hand-edited
    // mismatching inner id would otherwise desync links and citations.
    base: { ...file.base, id: kbId },
    // Preserve records verbatim, including unknown kinds.
    records: file.records.filter(isLoadableRecord)
  }
  baseCache.set(kbId, loaded)
  return loaded
}

function persistBase(loaded: LoadedBase): void {
  baseCache.set(loaded.base.id, loaded)
  ensureBasesDir()
  const file: BaseFile = {
    version: BASE_FILE_VERSION,
    base: loaded.base,
    records: loaded.records
  }
  // Temp-file + rename so a crash mid-write cannot truncate the canonical
  // file (which load() would then quarantine, losing nothing but continuity).
  const path = basePath(loaded.base.id)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, path)
}

function isLoadableLink(value: unknown): value is KnowledgeLink {
  if (!value || typeof value !== 'object') return false
  const l = value as Record<string, unknown>
  return (
    typeof l.id === 'string' &&
    typeof l.kbId === 'string' &&
    typeof l.connId === 'string' &&
    typeof l.database === 'string' &&
    (l.schema === undefined || typeof l.schema === 'string') &&
    typeof l.createdAt === 'number'
  )
}

function loadLinks(): KnowledgeLink[] {
  if (linksCache) return linksCache
  let links: KnowledgeLink[] = []
  const path = linksPath()
  if (existsSync(path)) {
    let parsed: unknown
    let readable: boolean
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
      readable =
        !!parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as LinksFile).links)
    } catch {
      readable = false
    }
    if (readable) {
      links = (parsed as LinksFile).links.filter(isLoadableLink)
    } else {
      console.error(`knowledge: unreadable links file quarantined: ${path}`)
      quarantineCorruptFile(path)
    }
  }
  linksCache = links
  return links
}

function persistLinks(links: KnowledgeLink[]): void {
  linksCache = links
  const dir = knowledgeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file: LinksFile = { version: LINKS_FILE_VERSION, links }
  const path = linksPath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, path)
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// --- Validation ------------------------------------------------------------

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

// --- Bases -------------------------------------------------------------------

export function listBases(): KnowledgeBaseSummary[] {
  const dir = basesDir()
  if (!existsSync(dir)) return []
  const links = loadLinks()
  const summaries: KnowledgeBaseSummary[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const kbId = entry.slice(0, -'.json'.length)
    if (!/^[A-Za-z0-9_-]+$/.test(kbId)) continue
    const loaded = loadBase(kbId)
    if (!loaded) continue
    summaries.push({
      ...loaded.base,
      recordCount: loaded.records.length,
      linkCount: links.filter((l) => l.kbId === kbId).length
    })
  }
  summaries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return summaries
}

export function getBase(kbId: string): KnowledgeBase | null {
  return loadBase(kbId)?.base ?? null
}

export function createBase(name: string): KnowledgeBase {
  const validName = validateName(name, 'Knowledge base name')
  const now = Date.now()
  const base: KnowledgeBase = {
    id: generateId('kb'),
    name: validName,
    repoRoot: null,
    createdAt: now,
    updatedAt: now
  }
  persistBase({ base, records: [] })
  return base
}

export function renameBase(kbId: string, name: string): KnowledgeBase {
  const validName = validateName(name, 'Knowledge base name')
  const loaded = loadBase(kbId)
  if (!loaded) throw new Error(`Unknown knowledge base: ${kbId}`)
  const base: KnowledgeBase = {
    ...loaded.base,
    name: validName,
    updatedAt: Date.now()
  }
  persistBase({ base, records: loaded.records })
  return base
}

/** Delete a base and every link that points at it. */
export function deleteBase(kbId: string): void {
  const path = basePath(kbId)
  if (existsSync(path)) rmSync(path, { force: true })
  baseCache.delete(kbId)
  const links = loadLinks()
  if (links.some((l) => l.kbId === kbId)) {
    persistLinks(links.filter((l) => l.kbId !== kbId))
  }
}

/**
 * Set or clear the base's codebase attachment. Only ever called with a path
 * from the main-process directory picker (repo.ts) or the v1 migration —
 * never with a renderer-supplied path.
 */
export function setBaseRepoRoot(kbId: string, root: string | null): KnowledgeBase {
  const loaded = loadBase(kbId)
  if (!loaded) throw new Error(`Unknown knowledge base: ${kbId}`)
  const base: KnowledgeBase = {
    ...loaded.base,
    repoRoot: root,
    updatedAt: Date.now()
  }
  persistBase({ base, records: loaded.records })
  return base
}

/** The base's repo root, or null. A root that vanished (unmounted volume,
 * deleted checkout) reads as detached rather than surfacing ENOENT tool
 * errors mid-conversation. */
export function getBaseRepoRoot(kbId: string): string | null {
  const root = loadBase(kbId)?.base.repoRoot ?? null
  return root && existsSync(root) ? root : null
}

// --- Links -------------------------------------------------------------------

export function listLinks(): KnowledgeLink[] {
  return loadLinks()
}

/** Every link attaching a base to this (connection, database), including
 * schema-scoped ones, oldest first. */
export function linksForTarget(connId: string, database: string): KnowledgeLink[] {
  return loadLinks()
    .filter((l) => l.connId === connId && l.database === database)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * Attach a base to a (connection, database) target, optionally scoped to one
 * schema. Adding a link identical to an existing one (same base, target, and
 * scope) returns the existing link instead of duplicating it.
 */
export function addLink(input: KnowledgeLinkInput): KnowledgeLink {
  if (!input || typeof input !== 'object') {
    throw new Error('Knowledge link must be an object')
  }
  assertSafeId(input.kbId, 'knowledge base')
  assertSafeId(input.connId, 'connection')
  if (!getBase(input.kbId)) {
    throw new Error(`Unknown knowledge base: ${input.kbId}`)
  }
  const database = validateName(input.database, 'Link database')
  const schema =
    input.schema === undefined || input.schema === null
      ? undefined
      : validateName(input.schema, 'Link schema')
  const links = loadLinks()
  const existing = links.find(
    (l) =>
      l.kbId === input.kbId &&
      l.connId === input.connId &&
      l.database === database &&
      (l.schema ?? '') === (schema ?? '')
  )
  if (existing) return existing
  const link: KnowledgeLink = {
    id: generateId('kl'),
    kbId: input.kbId,
    connId: input.connId,
    database,
    ...(schema === undefined ? {} : { schema }),
    createdAt: Date.now()
  }
  persistLinks([...links, link])
  return link
}

export function removeLink(linkId: string): void {
  const links = loadLinks()
  if (links.some((l) => l.id === linkId)) {
    persistLinks(links.filter((l) => l.id !== linkId))
  }
}

/**
 * Drop every link a deleted connection held. Deliberately leaves the bases
 * themselves alone: a base may be linked to other connections (prod/staging/
 * dev share one), and even an orphaned base is recoverable knowledge the UI
 * can offer to relink or delete — destroying it here would take a shared
 * knowledge base down with one environment's connection.
 */
export function deleteLinksForConnection(connId: string): void {
  const links = loadLinks()
  if (links.some((l) => l.connId === connId)) {
    persistLinks(links.filter((l) => l.connId !== connId))
  }
}

// --- Records -----------------------------------------------------------------

export function listRecords(kbId: string): KnowledgeRecord[] {
  return loadBase(kbId)?.records ?? []
}

/**
 * Create or update a record in one base. A record whose `id` matches an
 * existing one is updated in place (preserving `createdAt`); otherwise a new
 * record is minted. Validates the payload for its `kind` and stamps
 * timestamps.
 */
export function saveRecord(
  kbId: string,
  record: KnowledgeRecordInput
): KnowledgeRecord {
  validateKnowledgeRecord(record)
  const loaded = loadBase(kbId)
  if (!loaded) throw new Error(`Unknown knowledge base: ${kbId}`)
  const records = [...loaded.records]
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
      id: record.id ?? generateId('kn'),
      createdAt: now,
      updatedAt: now
    } as KnowledgeRecord
    records.push(saved)
  }
  persistBase({
    base: { ...loaded.base, updatedAt: now },
    records
  })
  return saved
}

export function deleteRecord(kbId: string, id: string): void {
  const loaded = loadBase(kbId)
  if (!loaded) return
  if (loaded.records.some((r) => r.id === id)) {
    persistBase({
      base: { ...loaded.base, updatedAt: Date.now() },
      records: loaded.records.filter((r) => r.id !== id)
    })
  }
}

// --- Target aggregation --------------------------------------------------------

/**
 * Everything the agent (and the knowledge panel) should see for one
 * (connection, database): each linked base with its records, oldest link
 * first. A link whose base file has vanished is pruned from the table rather
 * than surfaced as an empty group.
 */
export function groupsForTarget(
  connId: string,
  database: string
): KnowledgeTargetGroup[] {
  const groups: KnowledgeTargetGroup[] = []
  const dangling: string[] = []
  for (const link of linksForTarget(connId, database)) {
    const loaded = loadBase(link.kbId)
    if (!loaded) {
      dangling.push(link.id)
      continue
    }
    groups.push({ base: loaded.base, link, records: loaded.records })
  }
  if (dangling.length > 0) {
    persistLinks(loadLinks().filter((l) => !dangling.includes(l.id)))
  }
  return groups
}

/**
 * The base a turn writes to when the request names none: the oldest
 * database-wide link's base, falling back to the oldest schema-scoped one
 * (rule shared with the renderer via `pickDefaultLink`). Null when the target
 * has no links at all (callers then create-and-link).
 */
export function defaultKbForTarget(
  connId: string,
  database: string
): string | null {
  return pickDefaultLink(linksForTarget(connId, database))?.kbId ?? null
}

/** Unique (connId, database) targets a base is linked to — the set of
 * knowledge views a change to this base invalidates. */
export function targetsForBase(
  kbId: string
): Array<{ connId: string; database: string }> {
  const seen = new Set<string>()
  const targets: Array<{ connId: string; database: string }> = []
  for (const link of loadLinks()) {
    if (link.kbId !== kbId) continue
    const key = `${link.connId}\n${link.database}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ connId: link.connId, database: link.database })
  }
  return targets
}

// --- Wipe ----------------------------------------------------------------------

/**
 * Delete the entire knowledge store (bases, links, legacy backups) and clear
 * the in-memory caches. Takes no arguments and derives its target from
 * `knowledgeDir()` alone, so there is no caller-supplied path segment and it
 * can never be aimed anywhere outside `<userData>/knowledge`. Used by
 * store.ts to wipe knowledge as part of the one-time fresh-start reset when
 * `connections.json` is found in its pre-version-2 shape. A missing directory
 * is not an error: there may be nothing to wipe.
 */
export function wipeAll(): void {
  const dir = knowledgeDir()
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  baseCache.clear()
  linksCache = null
}

// --- v1 migration ----------------------------------------------------------------

/** What the migration needs to know about a saved connection to name and
 * link the bases it creates. */
export interface LegacyConnInfo {
  name: string
  database: string
}

/** v1 file shape: one per (connId, database) under `knowledge/<connId>/`. */
interface LegacyKnowledgeFile {
  version: number
  rawDatabase: string
  records: KnowledgeRecord[]
}

function uniqueBaseName(name: string, used: Set<string>): string {
  let candidate = name
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${name} (${n})`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/**
 * One-time conversion of the v1 layout (`knowledge/<connId>/<dbSlug>.json`
 * plus per-connection `repo-roots.json`) into bases + links:
 *
 * - each v1 (connection, database) file becomes one base, named
 *   "<connection name> / <database>", linked database-wide to that target;
 * - each v1 repo root is attached to every base migrated from its connection
 *   (in practice one — Postgres connections pin a single database);
 * - a repo root whose connection had no knowledge file yet becomes an empty
 *   base linked to the connection's stored database, so the attachment
 *   survives;
 * - originals are moved to `knowledge/legacy-v1/` and
 *   `repo-roots.legacy-v1.json` as backups, never deleted.
 *
 * Idempotent: with nothing legacy on disk it does nothing. `resolveConn` is
 * injected by index.ts (store.ts imports this module, so it cannot be
 * imported back here without a cycle).
 */
export function migrateLegacyKnowledge(
  resolveConn: (connId: string) => LegacyConnInfo | null
): void {
  const dir = knowledgeDir()
  const legacyBackupDir = join(dir, 'legacy-v1')
  const legacyConnDirs: string[] = []
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'bases' || entry.name === 'legacy-v1') continue
      if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
      legacyConnDirs.push(entry.name)
    }
  }
  const repoRootsPath = join(app.getPath('userData'), 'repo-roots.json')
  const hasLegacyRoots = existsSync(repoRootsPath)
  if (legacyConnDirs.length === 0 && !hasLegacyRoots) return

  const usedNames = new Set(listBases().map((b) => b.name.toLowerCase()))
  const now = Date.now()
  /** connId -> ids of bases migrated from it (for repo-root attachment). */
  const migratedByConn = new Map<string, string[]>()

  for (const connId of legacyConnDirs) {
    const connDir = join(dir, connId)
    for (const fileName of readdirSync(connDir)) {
      if (!fileName.endsWith('.json')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(connDir, fileName), 'utf8'))
      } catch {
        console.error(
          `knowledge: unreadable v1 file left in backup: ${connId}/${fileName}`
        )
        continue
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Array.isArray((parsed as LegacyKnowledgeFile).records)
      ) {
        continue
      }
      const legacy = parsed as LegacyKnowledgeFile
      const database =
        typeof legacy.rawDatabase === 'string' && legacy.rawDatabase !== ''
          ? legacy.rawDatabase
          : fileName.slice(0, -'.json'.length)
      const records = legacy.records.filter(isLoadableRecord)
      const conn = resolveConn(connId)
      const name = uniqueBaseName(
        conn ? `${conn.name} / ${database}` : database,
        usedNames
      )
      const createdAt = records.reduce(
        (min, r) => (typeof r.createdAt === 'number' ? Math.min(min, r.createdAt) : min),
        now
      )
      const base: KnowledgeBase = {
        id: generateId('kb'),
        name,
        repoRoot: null,
        createdAt,
        updatedAt: now
      }
      persistBase({ base, records })
      addLink({ kbId: base.id, connId, database })
      const ids = migratedByConn.get(connId) ?? []
      ids.push(base.id)
      migratedByConn.set(connId, ids)
    }
    // Move the whole v1 connection dir (including any corrupt/unparseable
    // files) into the backup dir rather than deleting anything.
    try {
      if (!existsSync(legacyBackupDir)) mkdirSync(legacyBackupDir, { recursive: true })
      renameSync(connDir, join(legacyBackupDir, connId))
    } catch (err) {
      console.error(`knowledge: could not move v1 dir ${connId} to backup:`, err)
    }
  }

  if (hasLegacyRoots) {
    let roots: Array<{ connId: string; root: string }> = []
    try {
      const parsed: unknown = JSON.parse(readFileSync(repoRootsPath, 'utf8'))
      if (Array.isArray(parsed)) {
        roots = (parsed as Array<{ connId: string; root: string }>).filter(
          (r) => !!r && typeof r.connId === 'string' && typeof r.root === 'string'
        )
      }
    } catch {
      roots = []
    }
    for (const { connId, root } of roots) {
      const migrated = migratedByConn.get(connId)
      if (migrated && migrated.length > 0) {
        for (const kbId of migrated) setBaseRepoRoot(kbId, root)
        continue
      }
      // Repo attached but no knowledge saved yet: keep the attachment on a
      // fresh empty base linked to the connection's stored database. A root
      // for a connection that no longer exists has nothing to hang off; the
      // backup file preserves it.
      const conn = resolveConn(connId)
      if (!conn || !/^[A-Za-z0-9_-]+$/.test(connId)) continue
      const base = createBase(
        uniqueBaseName(`${conn.name} / ${conn.database}`, usedNames)
      )
      setBaseRepoRoot(base.id, root)
      addLink({ kbId: base.id, connId, database: conn.database })
    }
    try {
      renameSync(
        repoRootsPath,
        join(app.getPath('userData'), 'repo-roots.legacy-v1.json')
      )
    } catch (err) {
      console.error('knowledge: could not rename legacy repo-roots.json:', err)
    }
  }
}
