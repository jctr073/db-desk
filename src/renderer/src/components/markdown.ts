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

/** Parse one line's worth of text into inline tokens. */
export function parseInline(text: string): InlineToken[] {
  // Leftmost match wins; at equal positions alternation order picks code over
  // strong over em, so `**x**` inside backticks stays literal. Underscores are
  // never emphasis — they are ubiquitous in identifiers (snake_case columns).
  // Per call, not module-level: recursion would corrupt a shared lastIndex.
  const inlineRe =
    /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(\*[^\s*][^*\n]*\*)|\[kb:([A-Za-z0-9][A-Za-z0-9_-]*)\]/g
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
    } else {
      out.push({ type: 'kbref', id: m[4] })
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

  for (const line of lines) {
    if (!line.trim()) {
      flushPara()
      flushList()
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
      continue
    }
    if (RULE_RE.test(line)) {
      flushPara()
      flushList()
      blocks.push({ type: 'rule' })
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
      continue
    }
    if (list) {
      // Lazy continuation: a plain line directly after an item wraps into it.
      const item = list.items[list.items.length - 1]
      item.push({ type: 'text', text: ' ' }, ...parseInline(line.trim()))
      continue
    }
    para.push(line)
  }
  flushPara()
  flushList()
  return blocks
}
