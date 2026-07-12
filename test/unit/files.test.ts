import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
