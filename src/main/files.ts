import { app } from 'electron'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

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
  return join(app.getPath('userData'), 'queries')
}

function metadataPath(): string {
  return join(queriesDir(), 'metadata.json')
}

function queryPath(id: string): string {
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
  writeFileSync(metadataPath(), JSON.stringify(metadata, null, 2), 'utf8')
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

export function getNextQueryName(
  connId: string | null,
  database: string | null
): string {
  const metadata = loadMetadata()

  let maxNum = 0
  for (const file of metadata) {
    if (file.connId === connId && file.database === database) {
      const match = file.name.match(/query(\d+)/)
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
  }
  return `query${maxNum + 1}.sql`
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

export function deleteQueriesForConnection(connId: string): void {
  const metadata = loadMetadata()
  const toDelete = metadata
    .filter((f) => f.connId === connId)
    .map((f) => f.id)
  for (const id of toDelete) {
    deleteQuery(id)
  }
}
