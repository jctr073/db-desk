import { useMemo } from 'react'
import type { ReactElement } from 'react'

import type { FileKind } from '../../../shared/files'
import { Markdown } from './MarkdownText'

export function formatJsonPreview(content: string): {
  text: string
  error: string | null
} {
  if (!content.trim()) return { text: '', error: null }
  try {
    return { text: JSON.stringify(JSON.parse(content), null, 2), error: null }
  } catch (error) {
    return {
      text: content,
      error: error instanceof Error ? error.message : 'Invalid JSON'
    }
  }
}

interface FilePreviewProps {
  kind: Exclude<FileKind, 'sql'>
  content: string
}

export type MarkdownPreviewSection =
  | { type: 'markdown'; content: string }
  | { type: 'code'; content: string; language: string | null }

export function parseMarkdownPreview(
  content: string
): MarkdownPreviewSection[] {
  const sections: MarkdownPreviewSection[] = []
  let lines: string[] = []
  let codeLanguage: string | null = null
  let inCode = false

  const flush = (): void => {
    if (lines.length === 0) return
    const sectionContent = lines.join('\n')
    if (inCode) {
      sections.push({
        type: 'code',
        content: sectionContent,
        language: codeLanguage
      })
    } else {
      sections.push({ type: 'markdown', content: sectionContent })
    }
    lines = []
  }

  for (const line of content.split('\n')) {
    const fence = /^```\s*([^\s`]*)\s*$/.exec(line)
    if (!fence) {
      lines.push(line)
      continue
    }
    flush()
    if (inCode) {
      inCode = false
      codeLanguage = null
    } else {
      inCode = true
      codeLanguage = fence[1] || null
    }
  }
  flush()
  return sections
}

export function FilePreview({ kind, content }: FilePreviewProps): ReactElement {
  const json = useMemo(
    () => (kind === 'json' ? formatJsonPreview(content) : null),
    [content, kind]
  )

  if (kind === 'markdown') {
    const sections = parseMarkdownPreview(content)
    return (
      <div
        className="file-preview file-preview--markdown"
        aria-label="Markdown preview"
      >
        {content.trim() ? (
          sections.map((section, index) =>
            section.type === 'code' ? (
              <div className="file-preview__code" key={index}>
                {section.language && (
                  <div className="file-preview__code-language">
                    {section.language}
                  </div>
                )}
                <pre>{section.content}</pre>
              </div>
            ) : (
              <Markdown key={index} text={section.content} />
            )
          )
        ) : (
          <div className="file-preview__empty">Nothing to preview</div>
        )}
      </div>
    )
  }

  return (
    <div
      className="file-preview"
      aria-label={`${kind === 'json' ? 'JSON' : 'Text'} preview`}
    >
      {json?.error && (
        <div className="file-preview__error" role="alert">
          Invalid JSON: {json.error}
        </div>
      )}
      {(json?.text ?? content) ? (
        <pre className="file-preview__pre">{json?.text ?? content}</pre>
      ) : (
        <div className="file-preview__empty">Nothing to preview</div>
      )}
    </div>
  )
}
