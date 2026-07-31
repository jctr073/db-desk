import { useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'

import { delimiterForKind, parseDelimited } from '../../../shared/delimited'
import type { FileKind } from '../../../shared/files'
import { DataGrid } from './grid/DataGrid'
import type { DataGridColumn } from './grid/DataGrid'
import { Markdown } from './MarkdownText'

/** The grid has no virtualization, so large files preview only their head. */
export const DELIMITED_PREVIEW_MAX_ROWS = 5000

export interface DelimitedPreview {
  columns: DataGridColumn[]
  rows: string[][]
  /** True when the file has more data rows than the preview cap. */
  truncated: boolean
  error: string | null
}

/**
 * Parse a CSV/TSV buffer into grid data: the first row becomes the column
 * headers (blank header cells get positional names), and every data row is
 * padded or trimmed to the header width so the grid stays rectangular.
 */
export function buildDelimitedPreview(content: string, kind: 'csv' | 'tsv'): DelimitedPreview {
  const parsed = parseDelimited(content, delimiterForKind(kind), {
    maxRows: DELIMITED_PREVIEW_MAX_ROWS + 1
  })
  const [header, ...dataRows] = parsed.rows
  if (!header) {
    return { columns: [], rows: [], truncated: false, error: parsed.error }
  }
  const columns = header.map((name, i) => ({ name: name.trim() || `Column ${i + 1}` }))
  const rows = dataRows.map((row) =>
    row.length === columns.length ? row : columns.map((_, i) => row[i] ?? '')
  )
  return { columns, rows, truncated: parsed.truncated, error: parsed.error }
}

const noopSelection = (): void => {}

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
  /** CSV/TSV only: report grid row selection up for the AI-context actions. */
  onSelectedRowsChange?: (rows: ReadonlySet<number>) => void
  /** CSV/TSV only: report grid column selection up alongside rows. */
  onSelectedColumnsChange?: (columns: ReadonlySet<number>) => void
  /** CSV/TSV only: present when the parent offers the AI-context menu. */
  onGridContextMenu?: (event: ReactMouseEvent) => void
}

export type MarkdownPreviewSection =
  { type: 'markdown'; content: string } | { type: 'code'; content: string; language: string | null }

export function parseMarkdownPreview(content: string): MarkdownPreviewSection[] {
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

export function FilePreview({
  kind,
  content,
  onSelectedRowsChange,
  onSelectedColumnsChange,
  onGridContextMenu
}: FilePreviewProps): ReactElement {
  const json = useMemo(() => (kind === 'json' ? formatJsonPreview(content) : null), [content, kind])
  const delimited = useMemo(
    () => (kind === 'csv' || kind === 'tsv' ? buildDelimitedPreview(content, kind) : null),
    [content, kind]
  )

  if (delimited) {
    return (
      <div className="file-preview file-preview--grid" aria-label="Data preview">
        {delimited.error && (
          <div className="file-preview__error file-preview__notice" role="alert">
            Malformed {kind === 'csv' ? 'CSV' : 'tab-delimited'} content: {delimited.error}
          </div>
        )}
        {delimited.truncated && (
          <div className="file-preview__notice">
            Showing the first {DELIMITED_PREVIEW_MAX_ROWS.toLocaleString()} rows
          </div>
        )}
        {delimited.columns.length > 0 ? (
          <DataGrid
            columns={delimited.columns}
            rows={delimited.rows}
            onSelectedRowsChange={onSelectedRowsChange ?? noopSelection}
            onSelectedColumnsChange={onSelectedColumnsChange ?? noopSelection}
            onGridContextMenu={onGridContextMenu}
            emptyText="No data rows"
          />
        ) : (
          <div className="file-preview__empty">Nothing to preview</div>
        )}
      </div>
    )
  }

  if (kind === 'markdown') {
    const sections = parseMarkdownPreview(content)
    return (
      <div className="file-preview file-preview--markdown" aria-label="Markdown preview">
        {content.trim() ? (
          sections.map((section, index) =>
            section.type === 'code' ? (
              <div className="file-preview__code" key={index}>
                {section.language && (
                  <div className="file-preview__code-language">{section.language}</div>
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
    <div className="file-preview" aria-label={`${kind === 'json' ? 'JSON' : 'Text'} preview`}>
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
