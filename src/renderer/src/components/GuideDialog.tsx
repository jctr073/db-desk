import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

import { useEscapeKey } from '../useEscapeKey'
import { parseMarkdownPreview } from './FilePreview'
import { Markdown } from './MarkdownText'

// electron-builder.yml excludes docs/** from the packaged app, so the guide
// text is inlined at build time via Vite's `?raw` loader rather than read
// from disk at runtime.
import guideMd from '../../../../docs/user-guide.md?raw'

/** Parsed once: the guide text is a static build-time import, not user data. */
const GUIDE_SECTIONS = parseMarkdownPreview(guideMd)

/**
 * Full-text viewer for `docs/user-guide.md`, reusing the same markdown
 * renderer and section splitter as FilePreview. `anchor` (a heading slug from
 * `slugifyHeading`) scrolls straight to that heading on open; omitted, the
 * dialog opens scrolled to the top.
 */
export function GuideDialog({
  open,
  anchor,
  onClose
}: {
  open: boolean
  anchor?: string | null
  onClose: () => void
}): ReactElement | null {
  const bodyRef = useRef<HTMLDivElement>(null)
  useEscapeKey(open, onClose)

  useEffect(() => {
    if (!open) return
    // requestAnimationFrame: wait a frame so the section/heading DOM exists
    // before we go looking for the anchor to scroll to.
    const raf = requestAnimationFrame(() => {
      const body = bodyRef.current
      if (!body) return
      const target = anchor ? body.querySelector('#' + CSS.escape(anchor)) : null
      if (target) {
        target.scrollIntoView({ block: 'start' })
      } else {
        body.scrollTop = 0
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [open, anchor])

  if (!open) return null

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-label="User guide"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="guide__header">
          <span>User guide</span>
          <button className="guide__close" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="guide__body file-preview--markdown" ref={bodyRef}>
          {GUIDE_SECTIONS.map((section, i) =>
            section.type === 'code' ? (
              <pre className="guide__code" key={i}>
                {section.content}
              </pre>
            ) : (
              <Markdown key={i} text={section.content} headingIds />
            )
          )}
        </div>
      </div>
    </div>
  )
}
