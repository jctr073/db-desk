/**
 * Chat/knowledge markdown tokenizer: block grouping (headings, lists, rules,
 * paragraphs) and inline code/bold/italic, including the identifier-safety
 * rules (underscores never emphasize; backticks win over asterisks).
 */

import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline, plainText } from '../../src/renderer/src/components/markdown'
import type { Block, InlineToken } from '../../src/renderer/src/components/markdown'

/** Flattens inline tokens back to plain text (delimiters stripped). */
function flat(spans: InlineToken[]): string {
  return spans.map((s) => ('children' in s ? flat(s.children) : 'text' in s ? s.text : '')).join('')
}

describe('parseInline', () => {
  it('splits code, bold, and italic around plain text', () => {
    const spans = parseInline('join `a.b` to **c** or *d*.')
    expect(spans.map((s) => s.type)).toEqual([
      'text',
      'code',
      'text',
      'strong',
      'text',
      'em',
      'text'
    ])
    expect(flat(spans)).toBe('join a.b to c or d.')
  })

  it('keeps asterisks inside code spans literal', () => {
    const spans = parseInline('`select **x**` after')
    expect(spans[0]).toEqual({ type: 'code', text: 'select **x**' })
  })

  it('nests code inside bold', () => {
    const spans = parseInline('**uses `game_type`**')
    expect(spans[0].type).toBe('strong')
    const inner = (spans[0] as Extract<InlineToken, { type: 'strong' }>).children
    expect(inner.map((s) => s.type)).toEqual(['text', 'code'])
  })

  it('never treats underscores as emphasis', () => {
    expect(parseInline('legacy_waiver_uuid and check_in_code')).toEqual([
      { type: 'text', text: 'legacy_waiver_uuid and check_in_code' }
    ])
  })

  it('leaves unmatched delimiters literal', () => {
    expect(flat(parseInline('a ** b ` c'))).toBe('a ** b ` c')
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }])
  })

  it('tokenizes [kb:id] knowledge citations', () => {
    const spans = parseInline('per the join rule [kb:kn-17-ab12], filtered.')
    expect(spans).toEqual([
      { type: 'text', text: 'per the join rule ' },
      { type: 'kbref', id: 'kn-17-ab12' },
      { type: 'text', text: ', filtered.' }
    ])
  })

  it('keeps [kb:...] inside code spans literal', () => {
    expect(parseInline('`select 1 -- [kb:x]`')[0]).toEqual({
      type: 'code',
      text: 'select 1 -- [kb:x]'
    })
  })

  it('leaves malformed kb markers as plain text', () => {
    expect(parseInline('[kb:] and [kb x] and [kb:has space]')).toEqual([
      { type: 'text', text: '[kb:] and [kb x] and [kb:has space]' }
    ])
  })

  it('parses citations inside emphasis', () => {
    const spans = parseInline('**see [kb:kn-1-a]**')
    expect(spans[0].type).toBe('strong')
    const inner = (spans[0] as Extract<InlineToken, { type: 'strong' }>).children
    expect(inner).toContainEqual({ type: 'kbref', id: 'kn-1-a' })
  })

  it('strips markdown links to their plain text', () => {
    const spans = parseInline('see the [main README](../README.md) for setup')
    expect(spans).toContainEqual({ type: 'text', text: 'main README' })
    expect(flat(spans)).toBe('see the main README for setup')
  })

  it('still tokenizes [kb:id] as a citation, not a link', () => {
    expect(parseInline('[kb:kn-1-a]')).toEqual([{ type: 'kbref', id: 'kn-1-a' }])
  })
})

describe('plainText', () => {
  it('flattens text, code, strong, and em, and drops kb citations', () => {
    const spans = parseInline('a `b` **c *d* e** [kb:x]')
    expect(plainText(spans)).toBe('a b c d e ')
  })
})

describe('parseBlocks', () => {
  it('parses a representative agent reply', () => {
    const text = [
      'Recorded 17 facts.',
      '',
      '## What I recorded',
      '',
      '**Glossary (3)**',
      '- **PlayerType** — from `game_type`.',
      '- **player** — headcount.',
      '',
      '1. first',
      '2. second'
    ].join('\n')
    const blocks = parseBlocks(text)
    expect(blocks.map((b) => b.type)).toEqual(['para', 'heading', 'para', 'list', 'list'])
    const heading = blocks[1] as Extract<
      ReturnType<typeof parseBlocks>[number],
      { type: 'heading' }
    >
    expect(heading.level).toBe(2)
    expect(flat(heading.spans)).toBe('What I recorded')
    const ul = blocks[3] as Extract<ReturnType<typeof parseBlocks>[number], { type: 'list' }>
    expect(ul.ordered).toBe(false)
    expect(ul.items).toHaveLength(2)
    const ol = blocks[4] as Extract<ReturnType<typeof parseBlocks>[number], { type: 'list' }>
    expect(ol.ordered).toBe(true)
    expect(ol.start).toBe(1)
  })

  it('wraps lazy continuation lines into the previous list item', () => {
    const blocks = parseBlocks('- a long item\nthat continues\n- next')
    expect(blocks).toHaveLength(1)
    const list = blocks[0] as Extract<ReturnType<typeof parseBlocks>[number], { type: 'list' }>
    expect(list.items).toHaveLength(2)
    expect(flat(list.items[0])).toBe('a long item that continues')
  })

  it('distinguishes rules from list items', () => {
    expect(parseBlocks('---').map((b) => b.type)).toEqual(['rule'])
    expect(parseBlocks('- x').map((b) => b.type)).toEqual(['list'])
  })

  it('keeps single newlines inside a paragraph', () => {
    const blocks = parseBlocks('line one\nline two')
    expect(blocks).toHaveLength(1)
    const para = blocks[0] as Extract<ReturnType<typeof parseBlocks>[number], { type: 'para' }>
    expect(flat(para.spans)).toBe('line one\nline two')
  })

  it('parses a pipe table into header + rows', () => {
    const text = [
      '| Shortcut  | Action        |',
      '| --------- | ------------- |',
      '| `⌘ Enter` | Run the query |',
      '| `⌘ S`     | Save the file |'
    ].join('\n')
    const blocks = parseBlocks(text)
    expect(blocks.map((b) => b.type)).toEqual(['table'])
    const table = blocks[0] as Extract<Block, { type: 'table' }>
    expect(table.header).toHaveLength(2)
    expect(flat(table.header[0])).toBe('Shortcut')
    expect(flat(table.header[1])).toBe('Action')
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]).toHaveLength(2)
    expect(table.rows[0][0]).toEqual([{ type: 'code', text: '⌘ Enter' }])
    expect(flat(table.rows[1][1])).toBe('Save the file')
  })

  it('does not treat a plain line starting with | as a table without a separator', () => {
    const blocks = parseBlocks('| not a table')
    expect(blocks.map((b) => b.type)).toEqual(['para'])
  })
})
