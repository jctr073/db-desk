import { describe, expect, it } from 'vitest'

import {
  defaultExtension,
  fileKindFromName,
  FILE_KIND_META,
  isPreviewableFile,
  monacoLanguageForFile,
  newFileStem,
  supportedExtension,
  supportedFileKindsDescription
} from './files'

describe('file types', () => {
  it.each([
    ['query.SQL', 'sql', 'sql'],
    ['notes.md', 'markdown', 'markdown'],
    ['README.markdown', 'markdown', 'markdown'],
    ['data.json', 'json', 'json'],
    ['notes.txt', 'text', 'plaintext'],
    ['license', 'text', 'plaintext'],
    ['sales.csv', 'csv', 'plaintext'],
    ['export.tsv', 'tsv', 'plaintext'],
    ['export.tab', 'tsv', 'plaintext']
  ])('detects %s as %s', (name, kind, language) => {
    expect(fileKindFromName(name)).toBe(kind)
    expect(monacoLanguageForFile(name)).toBe(language)
  })

  it('only marks non-SQL files as previewable', () => {
    expect(isPreviewableFile('query.sql')).toBe(false)
    expect(isPreviewableFile('notes.md')).toBe(true)
    expect(isPreviewableFile('data.json')).toBe(true)
    expect(isPreviewableFile('notes.txt')).toBe(true)
    expect(isPreviewableFile('sales.csv')).toBe(true)
    expect(isPreviewableFile('export.tsv')).toBe(true)
  })

  it('exposes canonical and supported extensions', () => {
    expect(defaultExtension('markdown')).toBe('.md')
    expect(supportedExtension('README.MARKDOWN')).toBe('.markdown')
    expect(supportedExtension('script.ts')).toBeNull()
    expect(defaultExtension('csv')).toBe('.csv')
    expect(defaultExtension('tsv')).toBe('.tsv')
    expect(supportedExtension('report.tab')).toBe('.tab')
  })

  it('derives the new-file stem and menu entries from FILE_KIND_META', () => {
    expect(newFileStem('csv')).toBe('data')
    expect(newFileStem('tsv')).toBe('data')
    expect(newFileStem('sql')).toBe('query')
    expect(FILE_KIND_META.map((meta) => meta.kind)).toEqual([
      'sql',
      'markdown',
      'json',
      'text',
      'csv',
      'tsv'
    ])
  })

  it('describes supported file types for error messages, including the new kinds', () => {
    expect(supportedFileKindsDescription()).toBe(
      'SQL, Markdown, JSON, Text, CSV, and Tab-delimited'
    )
  })
})
