/**
 * Classifies SQL text into styled segments for chat transcript rendering.
 * Reuses the editor-intelligence tokenizer so chat highlighting agrees with
 * what the completion engine understands, and mirrors the token classes of
 * the Monaco theme in SqlEditor.tsx (keyword/function/type/string/number/
 * comment/operator) — keep the two palettes in sync via the --sql-* design
 * tokens in styles.css.
 */

import { BUILTIN_FUNCTIONS, BUILTIN_TYPES, KEYWORDS, NO_ARG_FUNCTIONS } from './keywords'
import { tokenize } from './tokens'
import type { Token } from './tokens'

export type HighlightClass = 'kw' | 'fn' | 'type' | 'str' | 'num' | 'comment' | 'op'

export interface HighlightSegment {
  /** null renders in the surrounding text color (identifiers, punctuation). */
  cls: HighlightClass | null
  text: string
}

// Multi-word entries ('GROUP BY', 'IS NOT NULL') highlight per word.
const KEYWORD_WORDS = new Set(KEYWORDS.flatMap((kw) => kw.toLowerCase().split(' ')))
const TYPE_WORDS = new Set(BUILTIN_TYPES.flatMap((t) => t.toLowerCase().split(' ')))
const FUNCTION_WORDS = new Set([...BUILTIN_FUNCTIONS, ...NO_ARG_FUNCTIONS])

// Symbolic operators render like keywords in the editor theme; grouping and
// separator punctuation stays in the default text color.
const OPERATOR = /^(::|[=<>!~+\-*/%^|&?@#]+)$/

function classifyWord(word: string, next: Token | undefined): HighlightClass | null {
  // LEFT/RIGHT are joins as keywords but string functions before "(".
  if (FUNCTION_WORDS.has(word) && next?.type === 'op' && next.value === '(') {
    return 'fn'
  }
  if (KEYWORD_WORDS.has(word)) return 'kw'
  if (TYPE_WORDS.has(word)) return 'type'
  if (FUNCTION_WORDS.has(word)) return 'fn'
  return null
}

/**
 * Drops comments so SQL can be collapsed to one line without a `--` comment
 * swallowing the rest (line comments end at newlines that collapsing removes).
 */
export function stripSqlComments(sql: string): string {
  return highlightSql(sql)
    .filter((seg) => seg.cls !== 'comment')
    .map((seg) => seg.text)
    .join('')
}

/**
 * Splits `sql` into contiguous segments covering the whole input (segments
 * concatenate back to `sql`), each tagged with a highlight class or null.
 * Tolerant of unterminated strings/comments so it can run on streaming text.
 */
export function highlightSql(sql: string): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  const push = (cls: HighlightClass | null, text: string): void => {
    if (text) segments.push({ cls, text })
  }
  // The tokenizer skips whitespace and comments, so a gap between tokens is
  // whitespace interleaved with complete (or stream-truncated) comments.
  const pushGap = (text: string): void => {
    let i = 0
    while (i < text.length) {
      const start = i
      if (/\s/.test(text[i])) {
        while (i < text.length && /\s/.test(text[i])) i++
        push(null, text.slice(start, i))
      } else if (text.startsWith('--', i)) {
        const nl = text.indexOf('\n', i)
        i = nl === -1 ? text.length : nl
        push('comment', text.slice(start, i))
      } else if (text.startsWith('/*', i)) {
        let depth = 1
        i += 2
        while (i < text.length && depth > 0) {
          if (text.startsWith('/*', i)) {
            depth++
            i += 2
          } else if (text.startsWith('*/', i)) {
            depth--
            i += 2
          } else i++
        }
        push('comment', text.slice(start, i))
      } else {
        push(null, text[i])
        i++
      }
    }
  }

  const tokens = tokenize(sql)
  let pos = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    pushGap(sql.slice(pos, token.start))
    const text = sql.slice(token.start, token.end)
    switch (token.type) {
      case 'word':
        push(classifyWord(token.value, tokens[i + 1]), text)
        break
      case 'string':
        push('str', text)
        break
      case 'number':
        push('num', text)
        break
      case 'op':
        push(OPERATOR.test(token.value) ? 'op' : null, text)
        break
      default:
        // Quoted identifiers keep the default text color.
        push(null, text)
    }
    pos = token.end
  }
  pushGap(sql.slice(pos))
  return segments
}
