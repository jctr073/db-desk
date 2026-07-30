/**
 * Pure, dependency-free RFC-4180-ish parser for CSV/TSV text. No Node APIs —
 * runs in the sandboxed renderer as well as the main process. The serializer
 * half lives in `renderer/src/components/resultExport.ts` (`delimitedCell`);
 * keep quoting rules in sync between the two.
 *
 * Lenient by design: a stray quote mid-field never throws. Only a genuinely
 * unterminated quoted field at end-of-input is reported via `error`, and even
 * then whatever could be parsed is still returned.
 */

export interface ParsedDelimited {
  rows: string[][]
  /** True when parsing stopped early because `opts.maxRows` was reached. */
  truncated: boolean
  /** Human-readable description of a structural problem, or null if none. */
  error: string | null
}

interface RowParseResult {
  fields: string[]
  /** Index to resume scanning from for the next row. */
  nextIndex: number
  /** True when this row ended because a row separator (LF/CRLF) was consumed. */
  terminated: boolean
  /** True when the row ended at EOF while still inside a quoted field. */
  unterminatedQuote: boolean
}

/** Parses a single row starting at `start`; stops at the next row separator or EOF. */
function parseRow(text: string, start: number, delimiter: string): RowParseResult {
  const fields: string[] = []
  let field = ''
  let inQuotes = false
  let i = start
  const n = text.length

  while (i < n) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    // Only a quote at the very start of a field opens quoted mode — a quote
    // appearing mid-field (already has content) is treated as a literal
    // character rather than malformed input.
    if (ch === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }

    if (ch === delimiter) {
      fields.push(field)
      field = ''
      i++
      continue
    }

    if (ch === '\r' && text[i + 1] === '\n') {
      fields.push(field)
      return { fields, nextIndex: i + 2, terminated: true, unterminatedQuote: false }
    }

    if (ch === '\n') {
      fields.push(field)
      return { fields, nextIndex: i + 1, terminated: true, unterminatedQuote: false }
    }

    field += ch
    i++
  }

  fields.push(field)
  return { fields, nextIndex: i, terminated: false, unterminatedQuote: inQuotes }
}

/**
 * Parses delimited text into rows of string cells. Quoted fields may contain
 * the delimiter, double-quote escapes (`""`), and embedded LF/CRLF newlines.
 * A final trailing newline does not produce an extra empty row.
 *
 * When `opts.maxRows` is set, scanning stops as soon as that many rows have
 * been collected — the remainder of `text` is never visited — and `truncated`
 * is set to true.
 */
export function parseDelimited(
  text: string,
  delimiter: ',' | '\t',
  opts?: { maxRows?: number }
): ParsedDelimited {
  const maxRows = opts?.maxRows
  const rows: string[][] = []
  let error: string | null = null
  let truncated = false
  let i = 0
  const n = text.length

  while (i < n) {
    if (maxRows !== undefined && rows.length >= maxRows) {
      truncated = true
      break
    }

    const result = parseRow(text, i, delimiter)
    rows.push(result.fields)
    i = result.nextIndex

    if (result.unterminatedQuote) {
      error = 'Unterminated quoted field at end of input'
    }
  }

  return { rows, truncated, error }
}

/** Maps a file kind to the delimiter character used to parse/serialize it. */
export function delimiterForKind(kind: 'csv' | 'tsv'): ',' | '\t' {
  return kind === 'tsv' ? '\t' : ','
}
