import { createContext, useContext, useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { parseBlocks, parseInline } from './markdown'
import type { InlineToken } from './markdown'

/**
 * Resolves a `[kb:id]` knowledge citation to rendered content — the chat
 * transcript provides a resolver that renders a chip linking to the record.
 * Without a provider the marker renders as its literal text, so surfaces that
 * never see citations (knowledge panel titles, etc.) need no setup.
 */
export const KbRefContext = createContext<((id: string) => ReactNode) | null>(
  null
)

function KbRef({ id }: { id: string }): ReactElement {
  const resolve = useContext(KbRefContext)
  return <>{resolve ? resolve(id) : `[kb:${id}]`}</>
}

function renderSpans(spans: InlineToken[]): ReactNode[] {
  return spans.map((span, i) => {
    switch (span.type) {
      case 'code':
        return (
          <code key={i} className="md-code">
            {span.text}
          </code>
        )
      case 'strong':
        return <strong key={i}>{renderSpans(span.children)}</strong>
      case 'em':
        return <em key={i}>{renderSpans(span.children)}</em>
      case 'kbref':
        return <KbRef key={i} id={span.id} />
      default:
        return span.text
    }
  })
}

/** Block-level markdown (headings, lists, paragraphs) for chat prose. */
export function Markdown({ text }: { text: string }): ReactElement {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            return (
              <div
                key={i}
                className={`md-h md-h${Math.min(block.level, 4)}`}
                role="heading"
                aria-level={block.level}
              >
                {renderSpans(block.spans)}
              </div>
            )
          case 'rule':
            return <hr key={i} className="md-hr" />
          case 'list': {
            const items = block.items.map((item, j) => (
              <li key={j} className="md-li">
                {renderSpans(item)}
              </li>
            ))
            return block.ordered ? (
              <ol key={i} className="md-list" start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={i} className="md-list">
                {items}
              </ul>
            )
          }
          default:
            return (
              <p key={i} className="md-p">
                {renderSpans(block.spans)}
              </p>
            )
        }
      })}
    </>
  )
}

/** Inline-only markdown (code/bold/italic) for one-line labels and titles. */
export function InlineMarkdown({ text }: { text: string }): ReactElement {
  const spans = useMemo(() => parseInline(text), [text])
  return <>{renderSpans(spans)}</>
}
