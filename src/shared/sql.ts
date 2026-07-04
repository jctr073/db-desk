/**
 * Lightweight SQL lexing shared by the renderer (statement-at-cursor
 * extraction) and the main process (auto-LIMIT detection). PostgreSQL
 * dialect: '' / E'\'' strings, "quoted idents", -- and nested block
 * comments, $tag$ dollar quoting.
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
    if (ch === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
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
  const mask = computeCodeMask(sql)
  let depth = 0
  let word = ''
  let firstWord = ''
  const topWords = new Set<string>()
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
      if (depth === 0) topWords.add(lower)
    }
    if (!isCode) continue
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && sql.slice(i + 1).trim()) multi = true
  }

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
