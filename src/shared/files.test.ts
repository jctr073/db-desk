import { describe, expect, it } from 'vitest'

import {
  defaultExtension,
  fileKindFromName,
  isPreviewableFile,
  monacoLanguageForFile,
  supportedExtension
} from './files'

describe('file types', () => {
  it.each([
    ['query.SQL', 'sql', 'sql'],
    ['notes.md', 'markdown', 'markdown'],
    ['README.markdown', 'markdown', 'markdown'],
    ['data.json', 'json', 'json'],
    ['notes.txt', 'text', 'plaintext'],
    ['license', 'text', 'plaintext']
  ])('detects %s as %s', (name, kind, language) => {
    expect(fileKindFromName(name)).toBe(kind)
    expect(monacoLanguageForFile(name)).toBe(language)
  })

  it('only marks non-SQL files as previewable', () => {
    expect(isPreviewableFile('query.sql')).toBe(false)
    expect(isPreviewableFile('notes.md')).toBe(true)
    expect(isPreviewableFile('data.json')).toBe(true)
    expect(isPreviewableFile('notes.txt')).toBe(true)
  })

  it('exposes canonical and supported extensions', () => {
    expect(defaultExtension('markdown')).toBe('.md')
    expect(supportedExtension('README.MARKDOWN')).toBe('.markdown')
    expect(supportedExtension('script.ts')).toBeNull()
  })
})
