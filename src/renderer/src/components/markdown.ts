/**
 * Minimal markdown tokenizer for agent prose and knowledge snippets: headings,
 * lists, rules, paragraphs, and inline code/bold/italic. Fenced code blocks are
 * split out upstream (see AssistantText), so this never sees ``` fences. Kept
 * free of React so it is unit-testable from test/unit; Markdown.tsx renders
 * the tokens.
 */

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  /** A `[kb:id]` knowledge citation the agent wrote (see idTag in main/agent.ts). */
  | { type: 'kbref'; id: string }

export type Block =
  | { type: 'heading'; level: number; spans: InlineToken[] }
  | { type: 'list'; ordered: boolean; start: number; items: InlineToken[][] }
  | { type: 'para'; spans: InlineToken[] }
  | { type: 'rule' }
  | { type: 'table'; header: InlineToken[][]; rows: InlineToken[][][] }

/** Flattens inline tokens to plain text (kb citations drop out entirely). */
export function plainText(spans: InlineToken[]): string {
  return spans
    .map((span) => {
      switch (span.type) {
        case 'text':
        case 'code':
          return span.text
        case 'strong':
        case 'em':
          return plainText(span.children)
        default:
          return ''
      }
    })
    .join('')
}

/** Parse one line's worth of text into inline tokens. */
export function parseInline(text: string): InlineToken[] {
  // Leftmost match wins; at equal positions alternation order picks code over
  // strong over em, so `**x**` inside backticks stays literal. Underscores are
  // never emphasis — they are ubiquitous in identifiers (snake_case columns).
  // The kb-citation alternative is ordered before the generic markdown-link
  // one so `[kb:id]` always wins over being read as `[text](url)` — though in
  // practice the two can't match the same span, since a link requires a
  // trailing `(url)` that a bare `[kb:id]` never has.
  // Per call, not module-level: recursion would corrupt a shared lastIndex.
  const inlineRe =
    /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(\*[^\s*][^*\n]*\*)|\[kb:([A-Za-z0-9][A-Za-z0-9_-]*)\]|\[([^\]\n]+)\]\([^)\s]+\)/g
  const out: InlineToken[] = []
  let last = 0
  for (let m = inlineRe.exec(text); m; m = inlineRe.exec(text)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    if (m[1]) {
      out.push({ type: 'code', text: m[1].slice(1, -1) })
    } else if (m[2]) {
      out.push({ type: 'strong', children: parseInline(m[2].slice(2, -2)) })
    } else if (m[3]) {
      out.push({ type: 'em', children: parseInline(m[3].slice(1, -1)) })
    } else if (m[4]) {
      out.push({ type: 'kbref', id: m[4] })
    } else {
      out.push({ type: 'text', text: m[5] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const RULE_RE = /^\s*(?:-{3,}|\*{3,})\s*$/
const UL_ITEM_RE = /^\s*[-*•]\s+(.*)$/
const OL_ITEM_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/

/**
 * Splits one `|`-delimited table row into cells: `\|` is an escaped literal
 * pipe (kept), every other `|` is a separator, and cells are trimmed. The
 * leading/trailing cell is dropped when the row opens/closes with `|`, since
 * that pipe marks the row edge rather than a real column.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  if (cells.length && cells[0].trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim())
}

/** True when `line` is a table header separator, e.g. `| --- | :--: |`. */
function isTableSeparator(line: string): boolean {
  if (!line.trim().startsWith('|')) return false
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

/** Parse markdown text (no code fences) into a flat list of blocks. */
export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: Extract<Block, { type: 'list' }> | null = null

  const flushPara = (): void => {
    if (para.length === 0) return
    blocks.push({ type: 'para', spans: parseInline(para.join('\n')) })
    para = []
  }
  const flushList = (): void => {
    if (list) blocks.push(list)
    list = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      flushPara()
      flushList()
      i++
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushPara()
      flushList()
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        spans: parseInline(heading[2].trim())
      })
      i++
      continue
    }
    if (RULE_RE.test(line)) {
      flushPara()
      flushList()
      blocks.push({ type: 'rule' })
      i++
      continue
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara()
      flushList()
      const header = splitTableRow(line).map((cell) => parseInline(cell))
      i += 2
      const rows: InlineToken[][][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]).map((cell) => parseInline(cell)))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }
    const ul = UL_ITEM_RE.exec(line)
    const ol = ul ? null : OL_ITEM_RE.exec(line)
    if (ul || ol) {
      flushPara()
      const ordered = !!ol
      if (!list || list.ordered !== ordered) {
        flushList()
        list = {
          type: 'list',
          ordered,
          start: ol ? parseInt(ol[1], 10) : 1,
          items: []
        }
      }
      list.items.push(parseInline(ul ? ul[1] : ol![2]))
      i++
      continue
    }
    if (list) {
      // Lazy continuation: a plain line directly after an item wraps into it.
      const item = list.items[list.items.length - 1]
      item.push({ type: 'text', text: ' ' }, ...parseInline(line.trim()))
      i++
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  flushList()
  return blocks
}
