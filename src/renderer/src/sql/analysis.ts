/**
 * Structural analysis of a single SQL statement for editor intelligence:
 * which relations (tables, CTEs, subquery aliases) are in scope, and what
 * kind of completion the cursor position calls for.
 */

import { isName, tokenize } from './tokens'
import type { Token } from './tokens'

export interface TableRef {
  /** Explicit schema qualifier, if written (`public.customers`). */
  schema: string | null
  name: string
  alias: string | null
  source: 'relation' | 'cte' | 'subquery'
  /** Column names declared in a CTE's parenthesized column list. */
  cteColumns: string[]
}

export type Zone = 'table' | 'column' | 'type' | 'start'

export interface CursorContext {
  refs: TableRef[]
  /**
   * Identifier chain the cursor is completing after a dot, innermost last:
   * `c.` → ['c'], `public.customers.` → ['public', 'customers'].
   */
  qualifier: string[] | null
  zone: Zone
}

/** Keywords that terminate a table item and therefore can never be an alias. */
const NOT_ALIAS = new Set([
  'as',
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'on',
  'using',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'set',
  'returning',
  'values',
  'for',
  'fetch',
  'window',
  'into',
  'from',
  'when',
  'then',
  'else',
  'end',
  'and',
  'or',
  'not',
  'tablesample',
  'lateral',
  'only',
  'with',
  'select',
  'case',
  'do',
  'nothing',
  'conflict'
])

/** Clause keywords that put the cursor in table position. */
const TABLE_KEYWORDS = new Set(['from', 'join', 'update', 'into', 'truncate', 'table'])

/** Words skipped (not counted as names) when scanning back for the zone. */
const ZONE_SKIP = new Set([
  'as',
  'only',
  'lateral',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'outer',
  'if',
  'exists',
  'concurrently'
])

/** Clause keywords that put the cursor in expression (column) position. */
const COLUMN_KEYWORDS = new Set([
  'select',
  'where',
  'on',
  'having',
  'group',
  'order',
  'by',
  'set',
  'returning',
  'using',
  'values',
  'when',
  'then',
  'else',
  'case',
  'and',
  'or',
  'not',
  'in',
  'like',
  'ilike',
  'between',
  'distinct',
  'limit',
  'offset',
  'is',
  'all',
  'any',
  'some',
  'end',
  'union',
  'intersect',
  'except'
])

/** Index of the ')' matching the '(' at `open` (or tokens.length if unclosed). */
function matchParen(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].type !== 'op') continue
    if (tokens[i].value === '(') depth++
    else if (tokens[i].value === ')' && --depth === 0) return i
  }
  return tokens.length
}

function isOp(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.type === 'op' && token.value === value
}

/** True when this token can start a table/alias name. */
function nameStart(token: Token | undefined): token is Token {
  if (!isName(token)) return false
  return token.type === 'quoted' || !NOT_ALIAS.has(token.value)
}

interface ParsedName {
  schema: string | null
  name: string
  next: number
}

/** Parse a possibly qualified name (`a`, `a.b`, `a.b.c` — last two parts kept). */
function parseName(tokens: Token[], j: number): ParsedName | null {
  const first = tokens[j]
  if (!nameStart(first)) return null
  let schema: string | null = null
  let name = first.value
  let next = j + 1
  while (isOp(tokens[next], '.') && isName(tokens[next + 1])) {
    schema = name
    name = tokens[next + 1].value
    next += 2
  }
  return { schema, name, next }
}

/** Parse an optional alias (with or without AS) starting at `j`. */
function parseAlias(tokens: Token[], j: number): { alias: string | null; next: number } {
  if (tokens[j]?.type === 'word' && tokens[j].value === 'as' && isName(tokens[j + 1])) {
    return { alias: tokens[j + 1].value, next: j + 2 }
  }
  if (nameStart(tokens[j])) return { alias: tokens[j].value, next: j + 1 }
  return { alias: null, next: j }
}

/**
 * Parse one item of a FROM/JOIN/UPDATE/INTO list starting at `j`, appending
 * any discovered ref. Returns the index just past the item (== j if none).
 * `allowFunction` treats `name(...)` as a set-returning function call, which
 * only FROM/JOIN positions permit — after INSERT INTO the parens are the
 * column list.
 */
function parseTableItem(
  tokens: Token[],
  j: number,
  refs: TableRef[],
  allowFunction = false
): number {
  while (
    tokens[j]?.type === 'word' &&
    (tokens[j].value === 'only' || tokens[j].value === 'lateral')
  ) {
    j++
  }

  // Subquery: FROM ( ... ) [AS] alias — the inner tokens are scanned by the
  // main collectRefs pass, so only the alias needs recording here.
  if (isOp(tokens[j], '(')) {
    const close = matchParen(tokens, j)
    const { alias, next } = parseAlias(tokens, close + 1)
    if (alias) {
      refs.push({ schema: null, name: alias, alias, source: 'subquery', cteColumns: [] })
      return isOp(tokens[next], '(') ? matchParen(tokens, next) + 1 : next
    }
    return close + 1
  }

  const parsed = parseName(tokens, j)
  if (!parsed) return j

  // Set-returning function: FROM generate_series(...) [AS] alias(cols).
  if (allowFunction && isOp(tokens[parsed.next], '(')) {
    const close = matchParen(tokens, parsed.next)
    const { alias, next } = parseAlias(tokens, close + 1)
    if (alias) {
      refs.push({ schema: null, name: alias, alias, source: 'subquery', cteColumns: [] })
      return isOp(tokens[next], '(') ? matchParen(tokens, next) + 1 : next
    }
    return close + 1
  }

  const { alias, next } = parseAlias(tokens, parsed.next)
  refs.push({
    schema: parsed.schema,
    name: parsed.name,
    alias,
    source: 'relation',
    cteColumns: []
  })
  // Column alias list after the alias: FROM t AS x(a, b).
  return isOp(tokens[next], '(') ? matchParen(tokens, next) + 1 : next
}

/** Register CTE names declared by a WITH clause starting at token `i`. */
function parseCtes(tokens: Token[], i: number, refs: TableRef[]): void {
  let j = i + 1
  if (tokens[j]?.type === 'word' && tokens[j].value === 'recursive') j++
  for (;;) {
    if (!nameStart(tokens[j])) return
    const name = tokens[j].value
    j++
    const cteColumns: string[] = []
    if (isOp(tokens[j], '(')) {
      const close = matchParen(tokens, j)
      for (let k = j + 1; k < close; k++) {
        if (isName(tokens[k])) cteColumns.push(tokens[k].value)
      }
      j = close + 1
    }
    if (!(tokens[j]?.type === 'word' && tokens[j].value === 'as')) return
    j++
    if (tokens[j]?.type === 'word' && tokens[j].value === 'not') j++
    if (tokens[j]?.type === 'word' && tokens[j].value === 'materialized') j++
    if (!isOp(tokens[j], '(')) return
    refs.push({ schema: null, name, alias: null, source: 'cte', cteColumns })
    j = matchParen(tokens, j) + 1
    if (!isOp(tokens[j], ',')) return
    j++
  }
}

/**
 * Every relation reference in the statement, at any nesting depth. Being
 * over-inclusive (a subquery's tables leak into the outer scope) is fine
 * for completion; being under-inclusive is not.
 */
export function collectRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'word') continue
    switch (t.value) {
      case 'with':
        parseCtes(tokens, i, refs)
        break
      case 'from':
      case 'truncate': {
        const allowFunction = t.value === 'from'
        let j = parseTableItem(tokens, i + 1, refs, allowFunction)
        while (isOp(tokens[j], ',')) {
          const k = parseTableItem(tokens, j + 1, refs, allowFunction)
          if (k === j + 1) break
          j = k
        }
        break
      }
      case 'join':
        parseTableItem(tokens, i + 1, refs, true)
        break
      case 'into':
        parseTableItem(tokens, i + 1, refs)
        break
      case 'update': {
        // Skip ON CONFLICT DO UPDATE and FOR UPDATE, which name no table.
        const prev = tokens[i - 1]
        if (prev?.type === 'word' && (prev.value === 'do' || prev.value === 'for')) break
        parseTableItem(tokens, i + 1, refs)
        break
      }
    }
  }
  return refs
}

/**
 * Analyze the statement text around `offset` (an offset into `text`) and
 * report what is in scope and what kind of item should be completed.
 */
export function analyzeCursor(text: string, offset: number): CursorContext {
  const tokens = tokenize(text)
  const refs = collectRefs(tokens)

  // Last token fully before the cursor. A name token the cursor touches
  // (inside or at its end) is the word being typed and doesn't count.
  let prevIdx = -1
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].end < offset) prevIdx = k
    else if (tokens[k].start < offset) {
      if (!isName(tokens[k])) prevIdx = k
      break
    } else break
  }

  const prev = prevIdx >= 0 ? tokens[prevIdx] : undefined
  if (prev && isOp(prev, '.')) {
    const qualifier: string[] = []
    let k = prevIdx
    while (k >= 1 && isOp(tokens[k], '.') && isName(tokens[k - 1])) {
      qualifier.unshift(tokens[k - 1].value)
      k -= 2
    }
    if (qualifier.length > 0) return { refs, qualifier, zone: 'column' }
  }
  if (prev && isOp(prev, '::')) return { refs, qualifier: null, zone: 'type' }

  // Scan backward for the clause keyword governing the cursor. `names`
  // counts identifiers between the cursor and that keyword (frozen at the
  // nearest comma, which starts a fresh list item).
  let names = 0
  let frozen = false
  let depth = 0
  for (let k = prevIdx; k >= 0; k--) {
    const t = tokens[k]
    if (t.type === 'op') {
      // A semicolon before the cursor means a fresh statement follows it.
      if (t.value === ';') return { refs, qualifier: null, zone: 'start' }
      if (t.value === ')') depth++
      else if (t.value === '(') {
        if (depth > 0) depth--
      } else if (t.value === ',' && depth === 0) frozen = true
      continue
    }
    if (depth > 0) continue
    if (t.type === 'word') {
      if (TABLE_KEYWORDS.has(t.value)) {
        return { refs, qualifier: null, zone: names === 0 ? 'table' : 'column' }
      }
      if (COLUMN_KEYWORDS.has(t.value)) return { refs, qualifier: null, zone: 'column' }
      if (ZONE_SKIP.has(t.value)) continue
    }
    if (!frozen) names++
  }
  return { refs, qualifier: null, zone: 'start' }
}
