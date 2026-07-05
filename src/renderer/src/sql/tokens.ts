/**
 * PostgreSQL tokenizer for editor intelligence (completion, hover). Unlike
 * the code-mask lexer in shared/sql.ts, this produces positioned tokens —
 * including quoted identifiers — so statements can be analyzed structurally.
 */

export type TokenType = 'word' | 'quoted' | 'number' | 'string' | 'op'

export interface Token {
  type: TokenType
  /** Normalized value: lowercased for words, unescaped for quoted idents. */
  value: string
  start: number
  /** Exclusive end offset. */
  end: number
}

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/
const NUMBER = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/

function isWordStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uffff]/.test(ch)
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch)
}

/** True for tokens that can act as (part of) an identifier. */
export function isName(token: Token | undefined): token is Token {
  return token !== undefined && (token.type === 'word' || token.type === 'quoted')
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ''

    if (/\s/.test(ch)) {
      i++
      continue
    }
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
    if (ch === "'" || ((ch === 'e' || ch === 'E') && next === "'")) {
      const start = i
      const escaped = ch !== "'"
      i += escaped ? 2 : 1
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
      tokens.push({ type: 'string', value: '', start, end: i })
      continue
    }
    if (ch === '"') {
      const start = i
      let value = ''
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i++
          break
        }
        value += sql[i]
        i++
      }
      tokens.push({ type: 'quoted', value, start, end: i })
      continue
    }
    if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))
      if (tag) {
        const start = i
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
        tokens.push({ type: 'string', value: '', start, end: i })
        continue
      }
    }
    if (isWordStart(ch)) {
      const start = i
      while (i < n && isWordChar(sql[i])) i++
      const text = sql.slice(start, i)
      tokens.push({ type: 'word', value: text.toLowerCase(), start, end: i })
      continue
    }
    if (/[0-9]/.test(ch)) {
      const match = NUMBER.exec(sql.slice(i))!
      tokens.push({ type: 'number', value: match[0], start: i, end: i + match[0].length })
      i += match[0].length
      continue
    }
    if (ch === ':' && next === ':') {
      tokens.push({ type: 'op', value: '::', start: i, end: i + 2 })
      i += 2
      continue
    }
    tokens.push({ type: 'op', value: ch, start: i, end: i + 1 })
    i++
  }
  return tokens
}
