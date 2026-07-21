/**
 * Main-process codebase attachment: manages the local repository root attached
 * to a knowledge base and gives the agent read-only, sandboxed access to it
 * (list / grep / read). The root is chosen through a main-process directory
 * dialog and persisted main-side on the knowledge base itself (knowledge.ts) —
 * the renderer never supplies a filesystem path over IPC, so a compromised
 * renderer cannot point the agent at arbitrary directories. The renderer talks
 * to it through `repo:*` IPC handles, keyed by knowledge base id.
 *
 * Sandbox invariants (enforced here, not in the agent loop):
 * - every agent-supplied path is relative and must resolve lexically inside
 *   the root; absolute paths, `..` escapes, `~`, and control characters fail;
 * - symlinks are never followed: the walker skips symlink entries outright,
 *   and direct reads realpath-check the target against the realpathed root;
 * - files that conventionally hold secrets (.env*, keys, certs) are invisible
 *   to all three primitives — their contents would otherwise flow into the
 *   model conversation;
 * - everything is capped (walk visits, results, file sizes, match counts) so
 *   a monorepo cannot wedge the main process or flood a tool result.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import { typedHandle, typedSend } from './ipc'

import { addLink, createBase, getBaseRepoRoot, listBases, setBaseRepoRoot } from './knowledge'
import type {
  MonorepoCreateInput,
  MonorepoCreateResult,
  MonorepoPick,
  RepoStatus
} from '../shared/repo'

const execFileAsync = promisify(execFile)

/** Ceiling on directory entries examined in one walk (list or grep). */
const WALK_MAX_VISITS = 50_000
/** Ceiling on paths one list_repo_files call returns. */
const LIST_MAX_RESULTS = 1_000
/** Ceiling on candidate files one grep call will open. */
const GREP_MAX_FILES = 5_000
/** Ceiling on matches one grep call returns. */
const GREP_MAX_MATCHES = 200
/** Files larger than this are skipped by grep and refused by read. */
const MAX_FILE_BYTES = 2_000_000
/** Per-match line excerpt cap in grep results. */
const GREP_LINE_MAX_CHARS = 300
/** Longest line prefix a grep pattern is tested against (bounds regex cost). */
const GREP_SCAN_MAX_CHARS = 10_000
/** Ceiling on characters one read_repo_file call returns. */
const READ_MAX_CHARS = 30_000
/** Default line count for read_repo_file when no limit is given. */
const READ_DEFAULT_LINES = 500
/** How much of a file is sniffed for NUL bytes to detect binaries. */
const BINARY_SNIFF_BYTES = 8_192
/** Ceiling on `git rev-parse` before giving up on a commit SHA. */
const GIT_TIMEOUT_MS = 3_000

/**
 * Directories never entered by the walker. Dot-directories (.git, .venv,
 * .idea, …) are skipped wholesale by name, so only "plain" vendored/output
 * dirs need listing here.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'tmp',
  '__pycache__',
  'venv'
])

/**
 * Filenames that conventionally hold credentials. Invisible to list/grep and
 * refused by read: the repo root is user-chosen, but its .env would hand the
 * model (and thus the API conversation) live secrets the user never meant to
 * share. Deliberately a short, high-confidence list — this is a guardrail
 * against accidents, not a secret scanner.
 */
export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    /^\.env(\..+)?$/.test(lower) ||
    /\.(pem|key|p12|pfx|keystore|jks)$/.test(lower) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower) ||
    lower === '.netrc' ||
    lower === '.npmrc' ||
    lower === '.pgpass'
  )
}

// --- Persistence -------------------------------------------------------------

/**
 * The attached repo root for a knowledge base, or null. Never
 * renderer-supplied; persistence lives on the base itself (knowledge.ts),
 * which also treats a root that vanished (unmounted volume, deleted checkout)
 * as detached rather than surfacing ENOENT tool errors mid-conversation.
 */
export function getRepoRoot(kbId: string): string | null {
  return getBaseRepoRoot(kbId)
}

export function clearRepoRoot(kbId: string): void {
  setBaseRepoRoot(kbId, null)
}

/** Short SHA of HEAD for provenance strings, or null outside a git checkout. */
export async function getRepoCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      timeout: GIT_TIMEOUT_MS
    })
    const sha = stdout.trim()
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

// --- Path sandbox ------------------------------------------------------------

/** True when `child` is `parent` itself or lexically inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Resolve an agent-supplied relative path against the root, or throw. Purely
 * lexical — symlink containment is checked separately at access time, because
 * it needs the filesystem. Exported for unit tests.
 */
export function resolveRepoPath(root: string, requested: string): string {
  if (typeof requested !== 'string') {
    throw new Error('Path must be a string.')
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/.test(requested)) {
    throw new Error('Path contains control characters.')
  }
  if (isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested) || requested.startsWith('~')) {
    throw new Error('Path must be relative to the repository root.')
  }
  const abs = resolve(root, requested)
  if (!isWithin(root, abs)) {
    throw new Error('Path escapes the repository root.')
  }
  return abs
}

/**
 * Realpath both sides and require containment, closing the symlink escape the
 * lexical check cannot see (e.g. `docs/link -> /etc`). Throws if the target
 * does not exist.
 */
async function assertRealInsideRoot(root: string, abs: string): Promise<string> {
  const [realRoot, real] = await Promise.all([realpath(root), realpath(abs)])
  if (!isWithin(realRoot, real)) {
    throw new Error('Path resolves outside the repository root.')
  }
  return real
}

// --- Glob --------------------------------------------------------------------

/**
 * Minimal glob for the repo tools: `**` crosses directories, `*` and `?` stay
 * within a segment. Matched against the full repo-relative path; callers also
 * try the basename when the glob has no `/`, so `*.rb` finds Ruby files at any
 * depth. Exported for unit tests.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        // `db/**/x` must also match `db/x`: swallow the separator into the
        // optional group.
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(out + '$')
}

function makeMatcher(glob: string | undefined): ((rel: string) => boolean) | null {
  if (!glob || glob.trim() === '') return null
  const re = globToRegExp(glob.trim())
  const onBasename = !glob.includes('/')
  return (rel) => re.test(rel) || (onBasename && re.test(basename(rel)))
}

// --- Walker -------------------------------------------------------------------

interface WalkOutcome {
  /** Repo-relative POSIX paths of matched regular files, sorted per-dir. */
  files: string[]
  /** True when a cap stopped the walk before it saw everything. */
  truncated: boolean
}

/**
 * Depth-first walk from `startRel`, never following symlinks, skipping
 * dot-directories, IGNORED_DIRS, and sensitive filenames. `maxResults` bounds
 * the returned list; WALK_MAX_VISITS bounds total entries examined.
 */
async function walkFiles(
  root: string,
  startRel: string,
  matcher: ((rel: string) => boolean) | null,
  maxResults: number
): Promise<WalkOutcome> {
  const startAbs = resolveRepoPath(root, startRel || '.')
  await assertRealInsideRoot(root, startAbs)
  const startStat = await stat(startAbs)
  if (!startStat.isDirectory()) {
    throw new Error(`Not a directory: ${startRel}`)
  }
  const files: string[] = []
  let visits = 0
  let truncated = false
  // Explicit stack; recursion depth on pathological trees is the walker's
  // problem, not the caller's.
  const stack: string[] = [startAbs]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable dir: skip, never fail the whole walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    // Reverse push so the stack pops in sorted order.
    const dirs: string[] = []
    for (const entry of entries) {
      if (++visits > WALK_MAX_VISITS) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
        dirs.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (isSensitiveName(entry.name)) continue
      const rel = relative(root, join(dir, entry.name)).split(sep).join('/')
      if (matcher && !matcher(rel)) continue
      if (files.length >= maxResults) {
        truncated = true
        break
      }
      files.push(rel)
    }
    // A tripped cap ends the walk outright — re-queueing the subdirectories
    // already collected for this directory would keep it crawling.
    if (truncated) break
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i])
  }
  return { files, truncated }
}

// --- Primitives ---------------------------------------------------------------

export interface RepoListResult {
  files: string[]
  truncated: boolean
}

export async function listRepoFiles(
  root: string,
  dir?: string,
  glob?: string
): Promise<RepoListResult> {
  const outcome = await walkFiles(root, dir ?? '.', makeMatcher(glob), LIST_MAX_RESULTS)
  return { files: outcome.files, truncated: outcome.truncated }
}

export interface RepoGrepMatch {
  path: string
  line: number
  text: string
}

export interface RepoGrepResult {
  matches: RepoGrepMatch[]
  filesScanned: number
  truncated: boolean
}

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export async function grepRepo(
  root: string,
  pattern: string,
  opts?: { dir?: string; glob?: string; caseSensitive?: boolean }
): Promise<RepoGrepResult> {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new Error('Pattern must be a non-empty string.')
  }
  if (pattern.length > 500) {
    throw new Error('Pattern too long (max 500 characters).')
  }
  let re: RegExp
  try {
    re = new RegExp(pattern, opts?.caseSensitive ? '' : 'i')
  } catch (err) {
    throw new Error(
      `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
  const { files, truncated: walkTruncated } = await walkFiles(
    root,
    opts?.dir ?? '.',
    makeMatcher(opts?.glob),
    GREP_MAX_FILES
  )
  const matches: RepoGrepMatch[] = []
  let filesScanned = 0
  let truncated = walkTruncated
  for (const rel of files) {
    if (matches.length >= GREP_MAX_MATCHES) {
      truncated = true
      break
    }
    let buf: Buffer
    try {
      const abs = join(root, ...rel.split('/'))
      const info = await stat(abs)
      if (info.size > MAX_FILE_BYTES) continue
      buf = await readFile(abs)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    filesScanned++
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].slice(0, GREP_SCAN_MAX_CHARS)
      if (!re.test(line)) continue
      matches.push({
        path: rel,
        line: i + 1,
        text: lines[i].slice(0, GREP_LINE_MAX_CHARS).trimEnd()
      })
      if (matches.length >= GREP_MAX_MATCHES) {
        truncated = true
        break
      }
    }
  }
  return { matches, filesScanned, truncated }
}

export interface RepoReadResult {
  path: string
  content: string
  /** 1-based line number of the first returned line. */
  startLine: number
  totalLines: number
  truncated: boolean
}

export async function readRepoFile(
  root: string,
  relPath: string,
  offset?: number,
  limit?: number
): Promise<RepoReadResult> {
  const abs = resolveRepoPath(root, relPath)
  const real = await assertRealInsideRoot(root, abs)
  // Check the requested name AND the resolved name: an in-repo symlink like
  // `notes.txt -> .env` passes containment but must not expose the target.
  if (isSensitiveName(basename(abs)) || isSensitiveName(basename(real))) {
    throw new Error('This file may contain credentials and cannot be read.')
  }
  const info = await stat(real)
  if (info.isDirectory()) {
    throw new Error(`Is a directory (use list_repo_files): ${relPath}`)
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      `File too large (${info.size.toLocaleString()} bytes; max ${MAX_FILE_BYTES.toLocaleString()}).`
    )
  }
  const buf = await readFile(real)
  if (looksBinary(buf)) {
    throw new Error('File appears to be binary.')
  }
  const lines = buf.toString('utf8').split('\n')
  const startLine = Math.max(1, Math.floor(offset ?? 1))
  const lineCap = Math.max(1, Math.floor(limit ?? READ_DEFAULT_LINES))
  let truncated = startLine + lineCap - 1 < lines.length
  const slice = lines.slice(startLine - 1, startLine - 1 + lineCap)
  let content = slice.join('\n')
  if (content.length > READ_MAX_CHARS) {
    content = content.slice(0, READ_MAX_CHARS)
    truncated = true
  }
  return {
    path: relPath,
    content,
    startLine,
    totalLines: lines.length,
    truncated
  }
}

// --- Monorepo setup -----------------------------------------------------------

/**
 * The latest monorepo root pick, held main-side so mapping creation can refer
 * to it by id — the renderer never sends a filesystem path back over IPC
 * (same trust model as `repo:choose`). Single slot: a new pick invalidates
 * the previous one, and the slot dies with the process.
 */
let monorepoPick: MonorepoPick | null = null

/**
 * Immediate child folders of a monorepo root that could be deployable
 * services: plain directories only — symlinks, dot-directories, and
 * vendored/output directories (IGNORED_DIRS) are excluded. One level deep by
 * design; the user picks the folder whose children are the services.
 */
export async function listMonorepoFolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Store a fresh pick and mint its id — the seam between the native dialog
 * (IPC handler) and the mapping-creation state, exported so tests can seed a
 * pick without a dialog.
 */
export function registerMonorepoPick(root: string, folders: string[]): MonorepoPick {
  monorepoPick = {
    pickId: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    root,
    folders
  }
  return monorepoPick
}

/**
 * Create the requested folder → schemas mappings from the current pick: one
 * knowledge base per folder (root + subPath) plus a link per target schema —
 * a service folder can own several schemas. A folder that already has a base
 * for this exact root + subPath reuses it instead of minting a duplicate, and
 * `addLink` dedupes existing links — so a failed batch (e.g. one invalid
 * schema name) is safely re-runnable rather than pre-validated to death here.
 */
export function createMonorepoMappings(input: MonorepoCreateInput): MonorepoCreateResult {
  if (!input || typeof input !== 'object' || !Array.isArray(input.mappings)) {
    throw new Error('Invalid monorepo mapping request.')
  }
  const pick = monorepoPick
  if (!pick || input.pickId !== pick.pickId) {
    throw new Error('The monorepo pick has expired — choose the root again.')
  }
  for (const m of input.mappings) {
    if (!m || typeof m !== 'object' || !pick.folders.includes(m.folder)) {
      throw new Error(`Not a folder of the picked root: ${JSON.stringify(m?.folder)}`)
    }
    if (!Array.isArray(m.schemas) || m.schemas.length === 0) {
      throw new Error(`No schemas given for folder: ${JSON.stringify(m.folder)}`)
    }
  }
  /** folder → kbId for this root, seeded from disk, grown as we create. */
  const baseByFolder = new Map<string, string>()
  for (const b of listBases()) {
    if (b.repoRoot === pick.root && b.subPath) baseByFolder.set(b.subPath, b.id)
  }
  let created = 0
  let reused = 0
  const kbIds: string[] = []
  for (const m of input.mappings) {
    let kbId = baseByFolder.get(m.folder)
    if (kbId) {
      reused++
    } else {
      const base = createBase(m.name)
      setBaseRepoRoot(base.id, pick.root, m.folder)
      baseByFolder.set(m.folder, base.id)
      kbId = base.id
      created++
    }
    for (const schema of m.schemas) {
      addLink({
        kbId,
        connId: input.connId,
        database: input.database,
        schema
      })
    }
    kbIds.push(kbId)
  }
  return { created, reused, kbIds }
}

// --- IPC ----------------------------------------------------------------------

async function statusFor(kbId: string): Promise<RepoStatus> {
  const root = getRepoRoot(kbId)
  return {
    kbId,
    root,
    commit: root ? await getRepoCommit(root) : null
  }
}

export function registerRepoHandlers(getWindow: () => BrowserWindow | null): void {
  typedHandle('repo:get', (_event, kbId) => statusFor(kbId))

  // The path enters the system here and only here: a native directory picker
  // owned by the main process.
  typedHandle('repo:choose', async (_event, kbId) => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Attach codebase',
          buttonLabel: 'Attach',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const picked = result.canceled ? null : result.filePaths[0]
    if (picked) setBaseRepoRoot(kbId, picked)
    return statusFor(kbId)
  })

  typedHandle('repo:clear', (_event, kbId) => {
    clearRepoRoot(kbId)
    return statusFor(kbId)
  })

  // Monorepo setup: the root path enters (and stays in) the main process
  // here; the renderer gets the folder list plus a pickId to refer back to.
  typedHandle('repo:monorepoPick', async (): Promise<MonorepoPick | null> => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose monorepo root',
          buttonLabel: 'Choose',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const picked = result.canceled ? null : result.filePaths[0]
    if (!picked) return null
    return registerMonorepoPick(picked, await listMonorepoFolders(picked))
  })

  typedHandle('repo:monorepoCreate', (_event, input) => {
    const result = createMonorepoMappings(input)
    // Bases and links changed shape outside registerKnowledgeHandlers, so
    // push the same coarse structure signal it would have sent.
    typedSend(getWindow(), 'knowledge:structureChanged')
    return result
  })
}
