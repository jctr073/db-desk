/**
 * Lightweight SQL lexing shared by the renderer (statement-at-cursor
 * extraction) and the main process (auto-LIMIT detection, read/write
 * classification). Understands the union of the supported dialects'
 * quoting: '' / E'\'' strings, "quoted idents", `backtick idents`
 * (Databricks), -- and nested block comments, $tag$ dollar quoting.
 */

export interface StatementSpan {
  text: string
  start: number
  end: number
}

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch)
}

/** True at `i` (an opening single quote) when prefixed E/e makes it an escape string. */
function isEscapeString(sql: string, i: number): boolean {
  if (i === 0) return false
  const prev = sql[i - 1]
  if (prev !== 'e' && prev !== 'E') return false
  return i < 2 || !isWordChar(sql[i - 2])
}

/** Per-character flags: true when the char is live code (not string/comment). */
function computeCodeMask(sql: string): boolean[] {
  const n = sql.length
  const mask = new Array<boolean>(n).fill(false)
  let i = 0
  while (i < n) {
    const ch = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ''
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    if (ch === "'") {
      const escaped = isEscapeString(sql, i)
      i++
      while (i < n) {
        if (escaped && sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
        continue
      }
    }
    mask[i] = true
    i++
  }
  return mask
}

/** Split a script into statements on top-level semicolons; blank spans are dropped. */
export function splitStatements(sql: string): StatementSpan[] {
  const mask = computeCodeMask(sql)
  const spans: StatementSpan[] = []
  let start = 0
  const push = (end: number): void => {
    const text = sql.slice(start, end)
    if (text.trim()) spans.push({ text, start, end })
  }
  for (let i = 0; i < sql.length; i++) {
    if (mask[i] && sql[i] === ';') {
      push(i)
      start = i + 1
    }
  }
  push(sql.length)
  return spans
}

/** The statement the cursor sits in (or the closest one), for run-at-cursor. */
export function statementAtOffset(
  sql: string,
  offset: number
): StatementSpan | null {
  const spans = splitStatements(sql)
  if (spans.length === 0) return null
  for (const span of spans) {
    if (offset <= span.end) return span
  }
  return spans[spans.length - 1]
}

const STARTERS = new Set(['select', 'table', 'values', 'with'])
const DML = new Set(['insert', 'update', 'delete', 'merge'])

interface TopLevelScan {
  /** First keyword of the statement, lowercased. */
  firstWord: string
  /** Every keyword appearing outside parentheses, lowercased. */
  topWords: Set<string>
  /** Every keyword at any parenthesis depth, lowercased. */
  allWords: Set<string>
  /** True when a top-level semicolon is followed by more code. */
  multi: boolean
}

/** Scan live-code words (outside strings/comments) at parenthesis depth 0. */
function scanTopLevel(sql: string): TopLevelScan {
  const mask = computeCodeMask(sql)
  let depth = 0
  let word = ''
  let firstWord = ''
  const topWords = new Set<string>()
  const allWords = new Set<string>()
  let multi = false
  for (let i = 0; i <= sql.length; i++) {
    const isCode = i < sql.length && mask[i]
    const ch = isCode ? sql[i] : ''
    if (isCode && isWordChar(ch)) {
      word += ch
      continue
    }
    if (word) {
      const lower = word.toLowerCase()
      word = ''
      if (!firstWord) firstWord = lower
      allWords.add(lower)
      if (depth === 0) topWords.add(lower)
    }
    if (!isCode) continue
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && sql.slice(i + 1).trim()) multi = true
  }
  return { firstWord, topWords, allWords, multi }
}

export type StatementClass =
  | 'read' // provably read-only; the ONLY class the agent channel executes
  | 'dml' // INSERT / UPDATE / DELETE / MERGE / TRUNCATE / COPY
  | 'ddl' // CREATE / ALTER / DROP / GRANT / REVOKE / COMMENT / RENAME / ...
  | 'unknown' // everything else: SET, BEGIN, CALL, USE, multi-statement, ...

const DML_STARTERS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'copy'
])

const DDL_STARTERS = new Set([
  'create',
  'alter',
  'drop',
  'grant',
  'revoke',
  'comment',
  'rename',
  'refresh',
  'vacuum',
  'reindex',
  'cluster',
  'optimize',
  'msck',
  'import'
])

/** Bare option keywords that may sit between EXPLAIN and its statement. */
const EXPLAIN_OPTIONS = new Set([
  'analyze',
  'verbose',
  'costs',
  'settings',
  'buffers',
  'wal',
  'timing',
  'summary',
  'formatted',
  'extended',
  'codegen',
  'cost'
])

/**
 * The statement following an EXPLAIN prefix: strips the keyword itself, an
 * optional balanced `( ... )` options group, and any run of bare option
 * keywords. Returns '' when nothing follows.
 */
function stripExplainPrefix(sql: string): string {
  const mask = computeCodeMask(sql)
  const n = sql.length
  let i = 0
  const skipToCode = (): void => {
    while (i < n && (!mask[i] || /\s/.test(sql[i]))) i++
  }
  const readWord = (): string => {
    let w = ''
    while (i < n && mask[i] && isWordChar(sql[i])) w += sql[i++]
    return w
  }
  skipToCode()
  readWord() // the EXPLAIN keyword itself
  skipToCode()
  if (i < n && sql[i] === '(') {
    let depth = 0
    while (i < n) {
      if (mask[i] && sql[i] === '(') depth++
      else if (mask[i] && sql[i] === ')' && --depth === 0) {
        i++
        break
      }
      i++
    }
  }
  for (;;) {
    skipToCode()
    const wordStart = i
    const word = readWord()
    if (!word) return sql.slice(i)
    if (!EXPLAIN_OPTIONS.has(word.toLowerCase())) return sql.slice(wordStart)
  }
}

/**
 * Allowlist classification of a single statement. `read` is the only class
 * the agent execution channel will run; `dml`/`ddl`/`unknown` are all equally
 * blocked and differ only in the error message. Misclassifying a write as
 * `read` is a security bug; the reverse merely makes the agent rephrase.
 */
export function classifyStatement(sql: string): StatementClass {
  const { firstWord, topWords, allWords, multi } = scanTopLevel(sql)
  // Empty or comment-only input executes nothing; let the driver no-op.
  if (!firstWord) return 'read'
  if (multi) return 'unknown'
  if (DML_STARTERS.has(firstWord)) return 'dml'
  if (DDL_STARTERS.has(firstWord)) return 'ddl'
  if (STARTERS.has(firstWord)) {
    // Data-modifying CTEs may sit inside the parenthesized CTE body, so the
    // WITH scan must cover every depth, not just the top level.
    if (firstWord === 'with' && [...DML].some((kw) => allWords.has(kw))) {
      return 'dml'
    }
    if (topWords.has('into')) return 'ddl' // SELECT ... INTO t creates a table
    if (topWords.has('for')) return 'unknown' // FOR UPDATE/SHARE take row locks
    return 'read'
  }
  if (firstWord === 'show' || firstWord === 'describe' || firstWord === 'desc') {
    return 'read'
  }
  if (firstWord === 'explain') return classifyStatement(stripExplainPrefix(sql))
  return 'unknown'
}

export type AgentGuardResult =
  | { ok: true }
  | { ok: false; reason: string; cls: StatementClass | 'multi' | 'empty' }

/** Model-facing refusal copy, keyed by why the statement was blocked. */
const BLOCKED_REASONS: Record<'dml' | 'ddl' | 'unknown' | 'multi', string> = {
  dml: 'Blocked: this statement modifies data. The agent is read-only; write the SQL to the editor for the user to review and run.',
  ddl: 'Blocked: this statement changes database structure. The agent cannot run DDL; write the SQL to the editor for the user to review and run.',
  unknown:
    'Blocked: only read-only statements (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) can be executed. Write other SQL to the editor for the user to run.',
  multi: 'Blocked: send exactly one statement per run_sql call.'
}

/** The wall: exactly one statement, and it must classify as 'read'. */
export function guardAgentStatement(sql: string): AgentGuardResult {
  const statements = splitStatements(sql)
  if (statements.length === 0) {
    return { ok: false, cls: 'empty', reason: 'No statement to execute.' }
  }
  if (statements.length > 1) {
    return { ok: false, cls: 'multi', reason: BLOCKED_REASONS.multi }
  }
  const cls = classifyStatement(statements[0].text)
  if (cls !== 'read') {
    return { ok: false, cls, reason: BLOCKED_REASONS[cls] }
  }
  return { ok: true }
}

/**
 * Append `LIMIT n` to a statement when it is a bare row-returning query:
 * starts with SELECT/TABLE/VALUES/WITH and has no top-level LIMIT, FETCH,
 * or FOR locking clause. WITH statements whose top level is DML are left
 * alone, as is anything containing multiple statements.
 */
export function applyAutoLimit(
  sql: string,
  limit: number
): { text: string; applied: boolean } {
  const { firstWord, topWords, multi } = scanTopLevel(sql)

  if (multi || !STARTERS.has(firstWord)) return { text: sql, applied: false }
  if (topWords.has('limit') || topWords.has('fetch') || topWords.has('for')) {
    return { text: sql, applied: false }
  }
  if (firstWord === 'with' && [...DML].some((kw) => topWords.has(kw))) {
    return { text: sql, applied: false }
  }
  const trimmed = sql.replace(/[\s;]+$/, '')
  return { text: `${trimmed}\nLIMIT ${limit}`, applied: true }
}
