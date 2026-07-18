import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync
} from 'node:fs'
import { join, resolve } from 'node:path'

import { assertSafeId } from './safeId'
import { writeJsonAtomic } from './atomicJson'
import { defaultExtension, fileKindFromName, FILE_KINDS, supportedExtension } from '../shared/files'
import type { FileKind } from '../shared/files'
import { setSqlFilesDir, sqlFilesDir } from './settings'

export interface QueryFile {
  id: string
  name: string
  connId: string | null
  database: string | null
  createdAt: number
  updatedAt: number
}

interface StoredQueryMetadata {
  id: string
  name: string
  connId: string | null
  database: string | null
  createdAt: number
  updatedAt: number
}

let metadataCache: QueryFile[] | null = null

function queriesDir(): string {
  return sqlFilesDir()
}

function metadataPath(): string {
  return join(queriesDir(), 'metadata.json')
}

function queryPath(id: string): string {
  // Ids are renderer-supplied over IPC; without this, files:read could read
  // and files:delete could unlink any `.sql`-suffixed path on disk.
  assertSafeId(id, 'query file')
  return join(queriesDir(), `${id}.sql`)
}

function ensureDir(): void {
  const dir = queriesDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadMetadata(): StoredQueryMetadata[] {
  if (metadataCache) return metadataCache
  ensureDir()
  try {
    if (existsSync(metadataPath())) {
      const content = readFileSync(metadataPath(), 'utf8')
      const parsed: unknown = JSON.parse(content)
      metadataCache = Array.isArray(parsed) ? (parsed as StoredQueryMetadata[]) : []
    } else {
      metadataCache = []
    }
  } catch {
    metadataCache = []
  }
  return metadataCache
}

function persistMetadata(metadata: StoredQueryMetadata[]): void {
  metadataCache = metadata
  ensureDir()
  writeJsonAtomic(metadataPath(), metadata)
}

export function listQueries(): QueryFile[] {
  return loadMetadata()
}

export function createQuery(
  name: string,
  connId: string | null,
  database: string | null
): QueryFile {
  ensureDir()
  const metadata = loadMetadata()
  const id = `query-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const now = Date.now()
  const file: StoredQueryMetadata = {
    id,
    name,
    connId,
    database,
    createdAt: now,
    updatedAt: now
  }
  writeFileSync(queryPath(id), '', 'utf8')
  metadata.push(file)
  persistMetadata(metadata)
  return file
}

export function getNextQueryName(connId: string | null, database: string | null): string {
  return getNextFileName(connId, database, 'sql')
}

export function getNextFileName(
  connId: string | null,
  database: string | null,
  kind: FileKind
): string {
  const metadata = loadMetadata()

  const stem: Record<FileKind, string> = {
    sql: 'query',
    markdown: 'notes',
    json: 'data',
    text: 'text'
  }
  const prefix = stem[kind]
  const extension = defaultExtension(kind)

  let maxNum = 0
  for (const file of metadata) {
    if (file.connId === connId && file.database === database) {
      const match = file.name.match(
        new RegExp(`^${prefix}(\\d+)${extension.replace('.', '\\.')}$`, 'i')
      )
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
  }
  return `${prefix}${maxNum + 1}${extension}`
}

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === 'string' && FILE_KINDS.includes(value as FileKind)
}

export function loadQueryContent(id: string): string {
  ensureDir()
  const path = queryPath(id)
  if (!existsSync(path)) {
    return ''
  }
  return readFileSync(path, 'utf8')
}

export function saveQueryContent(id: string, content: string): void {
  ensureDir()
  const metadata = loadMetadata()
  const file = metadata.find((f) => f.id === id)
  if (!file) {
    throw new Error(`Query file not found: ${id}`)
  }
  file.updatedAt = Date.now()
  persistMetadata(metadata)
  writeFileSync(queryPath(id), content, 'utf8')
}

export function updateQueryMetadata(
  id: string,
  name?: string,
  connId?: string | null,
  database?: string | null
): QueryFile {
  const metadata = loadMetadata()
  const file = metadata.find((f) => f.id === id)
  if (!file) {
    throw new Error(`Query file not found: ${id}`)
  }
  if (name !== undefined) file.name = name
  if (connId !== undefined) file.connId = connId
  if (database !== undefined) file.database = database
  file.updatedAt = Date.now()
  persistMetadata(metadata)
  return file
}

/**
 * Move a file to a (connection, database). Names are only unique per group, so
 * a collision in the destination renames the incoming file rather than failing.
 */
export function reassignQuery(id: string, connId: string, database: string | null): QueryFile {
  const metadata = loadMetadata()
  const file = metadata.find((candidate) => candidate.id === id)
  if (!file) throw new Error(`Query file not found: ${id}`)

  const taken = metadata.some(
    (candidate) =>
      candidate.id !== id &&
      candidate.connId === connId &&
      candidate.database === database &&
      candidate.name.toLocaleLowerCase() === file.name.toLocaleLowerCase()
  )
  const name = taken ? getNextFileName(connId, database, fileKindFromName(file.name)) : file.name
  return updateQueryMetadata(id, name, connId, database)
}

export function renameQuery(id: string, requestedName: string): QueryFile {
  const name = requestedName.trim()
  if (!name) throw new Error('File name cannot be empty')
  const hasControlCharacter = [...name].some((char) => char.charCodeAt(0) < 32)
  if (name === '.' || name === '..' || /[\\/]/.test(name) || hasControlCharacter) {
    throw new Error('File name cannot contain slashes or control characters')
  }

  const metadata = loadMetadata()
  const file = metadata.find((candidate) => candidate.id === id)
  if (!file) throw new Error(`Query file not found: ${id}`)

  const hasExtension = /\.[^.]+$/.test(name)
  const requestedExtension = hasExtension ? supportedExtension(name) : null
  if (hasExtension && !requestedExtension) {
    throw new Error('Supported file types are SQL, Markdown, JSON, and text')
  }
  const normalizedName = requestedExtension
    ? name
    : `${name}${supportedExtension(file.name) ?? '.sql'}`
  if (normalizedName.length > 255) {
    throw new Error('File name must be 255 characters or fewer')
  }

  const duplicate = metadata.some(
    (candidate) =>
      candidate.id !== id &&
      candidate.connId === file.connId &&
      candidate.database === file.database &&
      candidate.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
  )
  if (duplicate) {
    throw new Error(`A file named ${normalizedName} already exists in this tab group`)
  }

  return updateQueryMetadata(id, normalizedName)
}

export function deleteQuery(id: string): void {
  ensureDir()
  const metadata = loadMetadata()
  const index = metadata.findIndex((f) => f.id === id)
  if (index >= 0) {
    metadata.splice(index, 1)
    persistMetadata(metadata)
  }
  const path = queryPath(id)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

/**
 * Repoint query storage at `newDir`, moving every tracked file and the
 * metadata index there. Copies everything first and only then deletes the
 * originals, so a failed copy leaves the old directory authoritative. Files
 * already present in the destination are left alone unless they collide with
 * a tracked id; a stale metadata.json there is overwritten.
 */
export function moveQueryStorage(newDir: string): number {
  const oldDir = queriesDir()
  if (resolve(newDir) === resolve(oldDir)) return 0

  const metadata = loadMetadata()
  mkdirSync(newDir, { recursive: true })

  const moved: string[] = []
  for (const file of metadata) {
    const src = join(oldDir, `${file.id}.sql`)
    if (!existsSync(src)) continue
    copyFileSync(src, join(newDir, `${file.id}.sql`))
    moved.push(src)
  }
  writeJsonAtomic(join(newDir, 'metadata.json'), metadata)

  // The new directory is complete; switch over, then clean up the old one.
  setSqlFilesDir(newDir)
  metadataCache = metadata
  for (const src of moved) {
    try {
      unlinkSync(src)
    } catch {
      // A leftover copy in the abandoned directory is harmless.
    }
  }
  try {
    unlinkSync(join(oldDir, 'metadata.json'))
  } catch {
    // Same: stale index in a directory the app no longer reads.
  }
  return moved.length
}

export function deleteQueriesForConnection(connId: string): void {
  const metadata = loadMetadata()
  const toDelete = metadata.filter((f) => f.connId === connId).map((f) => f.id)
  for (const id of toDelete) {
    deleteQuery(id)
  }
}
