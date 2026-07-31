/**
 * Program-wide watched folders: user-chosen macOS directories whose supported
 * files (SQL/Markdown/JSON/Text/CSV/TSV) appear in the Files panel's Folders
 * mode, available to any connection. Unlike the internal query store these
 * are references to real files, read and written in place.
 *
 * Sandbox invariants (mirroring repo.ts):
 * - folder roots are only ever chosen through a main-process directory
 *   dialog and persisted in settings — the renderer never adds a root;
 * - every renderer-supplied path must resolve inside a configured root:
 *   lexical containment first, then a realpath check so a symlinked file or
 *   parent cannot escape it; symlink entries are skipped by the walker;
 * - files that conventionally hold secrets are invisible to enumeration and
 *   refused by read/write (isSensitiveName);
 * - enumeration and reads are capped so a huge folder cannot wedge the main
 *   process or flood the renderer;
 * - one narrow exception: grantExternalPath lets a path outside every root
 *   through, but only for paths main itself just wrote via a native save
 *   dialog (data-export "open after export") — never renderer-originated.
 *
 * Watching uses fs.watch with `recursive: true` (FSEvents-backed on darwin),
 * debounced into a single re-enumeration that pushes the fresh listing over
 * `watched:changed`.
 */

import { realpathSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { shell } from 'electron'
import type { BrowserWindow } from 'electron'

import { typedSend } from './ipc'
import { IGNORED_DIRS, isSensitiveName, isWithin } from './repo'
import { watchedFolders } from './settings'
import { fileKindFromName, supportedExtension } from '../shared/files'
import type { ExternalFile, WatchedFileContent, WatchedWriteResult } from '../shared/files'
import type { WatchedFolder } from '../shared/settings'

/** Ceiling on directory entries examined per folder in one enumeration. */
const WALK_MAX_VISITS = 20_000
/** Ceiling on files one folder contributes to the listing. */
const LIST_MAX_FILES = 2_000
/** Files larger than this are skipped by the walker and refused by read. */
const MAX_FILE_BYTES = 2_000_000
/** Filesystem events within this window collapse into one re-enumeration. */
const CHANGE_DEBOUNCE_MS = 300

// --- Enumeration -------------------------------------------------------------

async function walkFolder(folder: WatchedFolder): Promise<ExternalFile[]> {
  const out: ExternalFile[] = []
  let visits = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable or vanished mid-walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (++visits > WALK_MAX_VISITS || out.length >= LIST_MAX_FILES) return
      const name = entry.name
      if (name.startsWith('.') || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(join(dir, name))
        continue
      }
      if (!entry.isFile()) continue
      if (isSensitiveName(name) || supportedExtension(name) === null) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.size > MAX_FILE_BYTES) continue
        out.push({
          path,
          name,
          kind: fileKindFromName(name),
          mtimeMs: info.mtimeMs,
          size: info.size,
          folderId: folder.id
        })
      } catch {
        // Vanished between readdir and stat: skip.
      }
    }
  }
  await walk(folder.path)
  return out
}

/** Every supported file under every watched folder, in folder order. */
export async function listWatchedFiles(): Promise<ExternalFile[]> {
  const perFolder = await Promise.all(watchedFolders().map(walkFolder))
  return perFolder.flat()
}

// --- Path sandbox ------------------------------------------------------------

/**
 * Paths granted access outside every watched folder, keyed by realpath.
 * Populated only by grantExternalPath, which is only ever called right after
 * main itself wrote a file to a path the user chose in a native save dialog
 * (the data-export "open after export" flow) — the renderer never supplies
 * these paths, so a granted entry never represents an untrusted choice.
 */
const grantedPaths = new Set<string>()

/**
 * Grant read/write access to one path outside every watched folder. The path
 * is realpathed synchronously — the file exists already, having just been
 * written by the caller — so the stored entry matches what
 * resolveWatchedPath compares against.
 */
export function grantExternalPath(path: string): void {
  grantedPaths.add(realpathSync(path))
}

/**
 * Resolve a renderer-supplied absolute path against the configured roots, or
 * throw. Lexical containment picks the root; the realpath check then defeats
 * symlinked parents (the file's directory must still resolve inside the
 * root's real location).
 */
async function resolveWatchedPath(requested: string): Promise<string> {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Error('Path must be a string.')
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/.test(requested)) {
    throw new Error('Path contains control characters.')
  }
  if (!isAbsolute(requested)) {
    throw new Error('Path must be absolute.')
  }
  const root = watchedFolders().find((folder) => isWithin(folder.path, requested))
  if (!root) {
    // Not inside any configured root: still accept it if it was explicitly
    // granted (see grantExternalPath's doc comment for the trust argument).
    // Folder-root containment is skipped for granted paths — there is no
    // root to contain them against — but the symlink lstat checks in
    // readWatchedFile/writeWatchedFile still run on whatever this returns.
    const real = await realpath(requested).catch(() => requested)
    if (grantedPaths.has(real)) return real
    throw new Error('Path is outside every watched folder.')
  }
  const name = basename(requested)
  if (name.startsWith('.') || isSensitiveName(name)) {
    throw new Error('This file cannot be opened from a watched folder.')
  }
  const [realRoot, realDir] = await Promise.all([realpath(root.path), realpath(dirname(requested))])
  const real = join(realDir, name)
  if (!isWithin(realRoot, real)) {
    throw new Error('Path escapes the watched folder.')
  }
  return real
}

// --- Read / write ------------------------------------------------------------

export async function readWatchedFile(path: string): Promise<WatchedFileContent> {
  const real = await resolveWatchedPath(path)
  const info = await lstat(real)
  if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be opened.')
  if (!info.isFile()) throw new Error('Not a file.')
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`File is larger than the ${Math.round(MAX_FILE_BYTES / 1_000_000)} MB limit.`)
  }
  const content = await readFile(real, 'utf8')
  return { content, mtimeMs: info.mtimeMs }
}

/**
 * Write a watched file in place. Refuses with `conflict` when the on-disk
 * mtime is newer than the renderer's read-time snapshot (someone else wrote
 * it); a file deleted since load is recreated rather than conflicting.
 */
export async function writeWatchedFile(
  path: string,
  content: string,
  expectedMtimeMs: number
): Promise<WatchedWriteResult> {
  const real = await resolveWatchedPath(path)
  let existing = null
  try {
    existing = await lstat(real)
  } catch {
    // Deleted since load: fall through and recreate it.
  }
  if (existing?.isSymbolicLink()) throw new Error('Symbolic links cannot be written.')
  if (existing && existing.mtimeMs > expectedMtimeMs) {
    return { status: 'conflict', mtimeMs: existing.mtimeMs }
  }
  await writeFile(real, content, 'utf8')
  const after = await stat(real)
  return { status: 'ok', mtimeMs: after.mtimeMs }
}

/** Reveal a watched file in Finder; same containment rules as read. */
export async function revealWatchedFile(path: string): Promise<void> {
  const real = await resolveWatchedPath(path)
  shell.showItemInFolder(real)
}

// --- Watchers ----------------------------------------------------------------

const watchers = new Map<string, FSWatcher>()
let debounceTimer: NodeJS.Timeout | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null

function scheduleChangePush(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void listWatchedFiles().then((files) => {
      if (getWindowRef) typedSend(getWindowRef(), 'watched:changed', files)
    })
  }, CHANGE_DEBOUNCE_MS)
}

/**
 * Reconcile live watchers with the configured folder list; call at startup
 * and after every add/remove. Also pushes a fresh listing so the renderer
 * never waits for the next filesystem event to see the new shape.
 */
export function syncWatchedFolders(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow
  const wanted = new Map(watchedFolders().map((folder) => [folder.id, folder]))
  for (const [id, watcher] of watchers) {
    if (!wanted.has(id)) {
      watcher.close()
      watchers.delete(id)
    }
  }
  for (const folder of wanted.values()) {
    if (watchers.has(folder.id)) continue
    try {
      const watcher = watch(folder.path, { recursive: true, persistent: false }, () =>
        scheduleChangePush()
      )
      // A root that vanishes (unmounted volume, deleted directory) closes its
      // watcher; enumeration simply returns nothing for it until re-added.
      watcher.on('error', () => {
        watcher.close()
        watchers.delete(folder.id)
      })
      watchers.set(folder.id, watcher)
    } catch {
      // Missing directory: no watcher; the folder lists as empty.
    }
  }
  scheduleChangePush()
}
