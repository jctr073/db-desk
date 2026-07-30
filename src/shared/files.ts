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

/**
 * Single source of truth for creatable file kinds. Order here is the order
 * they're offered in the "new file" menu. Everything else in this module
 * (extension lookups, defaults, Monaco language) is derived from this table.
 */
export const FILE_KIND_META = [
  {
    kind: 'sql',
    label: 'SQL file',
    extensions: ['.sql'],
    defaultExtension: '.sql',
    newFileStem: 'query',
    monacoLanguage: 'sql'
  },
  {
    kind: 'markdown',
    label: 'Markdown file',
    extensions: ['.md', '.markdown'],
    defaultExtension: '.md',
    newFileStem: 'notes',
    monacoLanguage: 'markdown'
  },
  {
    kind: 'json',
    label: 'JSON file',
    extensions: ['.json'],
    defaultExtension: '.json',
    newFileStem: 'data',
    monacoLanguage: 'json'
  },
  {
    kind: 'text',
    label: 'Text file',
    extensions: ['.txt', '.text'],
    defaultExtension: '.txt',
    newFileStem: 'text',
    monacoLanguage: 'plaintext'
  },
  {
    kind: 'csv',
    label: 'CSV file',
    extensions: ['.csv'],
    defaultExtension: '.csv',
    newFileStem: 'data',
    monacoLanguage: 'plaintext'
  },
  {
    kind: 'tsv',
    label: 'Tab-delimited file',
    extensions: ['.tsv', '.tab'],
    defaultExtension: '.tsv',
    newFileStem: 'data',
    monacoLanguage: 'plaintext'
  }
] as const

export type FileKind = (typeof FILE_KIND_META)[number]['kind']

export type FileKindMeta = (typeof FILE_KIND_META)[number]

export const FILE_KINDS: readonly FileKind[] = FILE_KIND_META.map((meta) => meta.kind)

const EXTENSIONS: Record<FileKind, readonly string[]> = Object.fromEntries(
  FILE_KIND_META.map((meta) => [meta.kind, meta.extensions])
) as unknown as Record<FileKind, readonly string[]>

const DEFAULT_EXTENSION: Record<FileKind, string> = Object.fromEntries(
  FILE_KIND_META.map((meta) => [meta.kind, meta.defaultExtension])
) as unknown as Record<FileKind, string>

const MONACO_LANGUAGE: Record<FileKind, string> = Object.fromEntries(
  FILE_KIND_META.map((meta) => [meta.kind, meta.monacoLanguage])
) as unknown as Record<FileKind, string>

const NEW_FILE_STEM: Record<FileKind, string> = Object.fromEntries(
  FILE_KIND_META.map((meta) => [meta.kind, meta.newFileStem])
) as unknown as Record<FileKind, string>

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

/** The "new file" stem used by `getNextFileName`, e.g. `query1.sql`, `data1.csv`. */
export function newFileStem(kind: FileKind): string {
  return NEW_FILE_STEM[kind]
}

/** Human-readable rundown of creatable/renameable file types, e.g. for error messages. */
export function supportedFileKindsDescription(): string {
  const names = FILE_KIND_META.map((meta) => meta.label.replace(/ file$/i, ''))
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}
