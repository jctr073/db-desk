import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  }
}))

let files: typeof import('../../src/main/files')

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-files-'))
  vi.resetModules()
  files = await import('../../src/main/files')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('renameQuery', () => {
  it('renames the saved query metadata and adds the SQL extension', () => {
    const file = files.createQuery('query1.sql', 'conn-1', 'analytics')

    const renamed = files.renameQuery(file.id, 'customer totals')

    expect(renamed.name).toBe('customer totals.sql')
    expect(files.listQueries()).toContainEqual(renamed)
    const metadata = JSON.parse(
      readFileSync(join(userDataDir, 'queries', 'metadata.json'), 'utf8')
    ) as Array<{ id: string; name: string }>
    expect(metadata.find((candidate) => candidate.id === file.id)?.name).toBe(
      'customer totals.sql'
    )
  })

  it('rejects duplicate names within the same connection and database', () => {
    files.createQuery('customers.sql', 'conn-1', 'analytics')
    const other = files.createQuery('query2.sql', 'conn-1', 'analytics')

    expect(() => files.renameQuery(other.id, 'CUSTOMERS.SQL')).toThrow(
      'already exists in this tab group'
    )
  })

  it.each(['', '   ', '../customers', 'folder/customers'])(
    'rejects invalid name %j',
    (name) => {
      const file = files.createQuery('query1.sql', null, null)
      expect(() => files.renameQuery(file.id, name)).toThrow()
    }
  )
})

describe('moveQueryStorage', () => {
  it('moves files and metadata to the new directory and repoints storage', () => {
    const file = files.createQuery('query1.sql', 'conn-1', 'analytics')
    files.saveQueryContent(file.id, 'SELECT 1')
    const oldDir = join(userDataDir, 'queries')
    const newDir = join(userDataDir, 'custom-sql')

    expect(files.moveQueryStorage(newDir)).toBe(1)

    // Content and index live in the new directory; the old one is emptied.
    expect(readFileSync(join(newDir, `${file.id}.sql`), 'utf8')).toBe('SELECT 1')
    expect(existsSync(join(newDir, 'metadata.json'))).toBe(true)
    expect(existsSync(join(oldDir, `${file.id}.sql`))).toBe(false)
    expect(existsSync(join(oldDir, 'metadata.json'))).toBe(false)

    // Subsequent operations read and write through the new directory.
    expect(files.loadQueryContent(file.id)).toBe('SELECT 1')
    const created = files.createQuery('query2.sql', 'conn-1', 'analytics')
    expect(existsSync(join(newDir, `${created.id}.sql`))).toBe(true)

    // The choice is persisted for the next launch.
    const settings = JSON.parse(
      readFileSync(join(userDataDir, 'settings.json'), 'utf8')
    ) as { sqlFilesDir?: string }
    expect(settings.sqlFilesDir).toBe(newDir)
  })

  it('is a no-op when the target equals the current directory', () => {
    files.createQuery('query1.sql', 'conn-1', 'analytics')
    const oldDir = join(userDataDir, 'queries')

    expect(files.moveQueryStorage(oldDir)).toBe(0)

    expect(existsSync(join(oldDir, 'metadata.json'))).toBe(true)
  })

  it('survives an untracked metadata-only store (no stranded files)', () => {
    // A metadata entry whose .sql file is missing must not abort the move.
    const kept = files.createQuery('query1.sql', 'conn-1', 'analytics')
    const ghost = files.createQuery('query2.sql', 'conn-1', 'analytics')
    rmSync(join(userDataDir, 'queries', `${ghost.id}.sql`))
    const newDir = join(userDataDir, 'elsewhere')

    expect(files.moveQueryStorage(newDir)).toBe(1)

    expect(existsSync(join(newDir, `${kept.id}.sql`))).toBe(true)
    expect(files.listQueries().map((entry) => entry.id)).toEqual([
      kept.id,
      ghost.id
    ])
  })
})
