/**
 * One saved query file's metadata, as it travels over IPC (`files:*`) and
 * sits in the main process's metadata index. Content is stored separately
 * and fetched via files:read.
 */
export interface QueryFile {
  id: string
  name: string
  connId: string | null
  database: string | null
  createdAt: number
  updatedAt: number
}

export const FILE_KINDS = ['sql', 'markdown', 'json', 'text'] as const

export type FileKind = (typeof FILE_KINDS)[number]

const EXTENSIONS: Record<FileKind, readonly string[]> = {
  sql: ['.sql'],
  markdown: ['.md', '.markdown'],
  json: ['.json'],
  text: ['.txt', '.text']
}

const DEFAULT_EXTENSION: Record<FileKind, string> = {
  sql: '.sql',
  markdown: '.md',
  json: '.json',
  text: '.txt'
}

const MONACO_LANGUAGE: Record<FileKind, string> = {
  sql: 'sql',
  markdown: 'markdown',
  json: 'json',
  text: 'plaintext'
}

export function fileKindFromName(name: string): FileKind {
  const lower = name.toLocaleLowerCase()
  for (const kind of FILE_KINDS) {
    if (EXTENSIONS[kind].some((extension) => lower.endsWith(extension))) {
      return kind
    }
  }
  return 'text'
}

export function supportedExtension(name: string): string | null {
  const lower = name.toLocaleLowerCase()
  for (const kind of FILE_KINDS) {
    const extension = EXTENSIONS[kind].find((candidate) => lower.endsWith(candidate))
    if (extension) return extension
  }
  return null
}

export function defaultExtension(kind: FileKind): string {
  return DEFAULT_EXTENSION[kind]
}

export function monacoLanguageForFile(name: string): string {
  return MONACO_LANGUAGE[fileKindFromName(name)]
}

export function isPreviewableFile(name: string): boolean {
  return fileKindFromName(name) !== 'sql'
}
