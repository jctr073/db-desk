import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

let schemaCache: typeof import('../../src/main/schemaCache')

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-schema-cache-'))
  vi.resetModules()
  schemaCache = await import('../../src/main/schemaCache')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('connId path safety', () => {
  // connIds arrive over IPC (db:connect, store:delete) and become filenames
  // under userData/schema-cache/; hostile ids must fail closed.
  it('refuses to persist under an id that escapes the cache directory', () => {
    expect(() =>
      schemaCache.saveDatabases('../escape', 'identity', ['db1'])
    ).toThrow(/Invalid connection id/)
  })

  it('loads nothing for an unsafe id instead of reading outside the cache', () => {
    // A valid-looking cache file directly in userData: reachable only by
    // traversal, so a null result proves the read never left the cache dir.
    writeFileSync(
      join(userDataDir, 'outside.json'),
      JSON.stringify({
        version: 1,
        identity: 'identity',
        savedAt: 0,
        databases: ['db1'],
        introspections: {}
      }),
      'utf8'
    )

    expect(schemaCache.loadCacheFile('../outside', 'identity')).toBeNull()
  })

  it('cannot delete a file outside the cache directory', () => {
    const outside = join(userDataDir, 'outside.json')
    writeFileSync(outside, '{}', 'utf8')

    schemaCache.deleteCacheFor('../outside')

    expect(existsSync(outside)).toBe(true)
  })

  it('round-trips a house-format connId', () => {
    schemaCache.saveDatabases('conn-123-abc', 'identity', ['db1', 'db2'])

    expect(readdirSync(join(userDataDir, 'schema-cache'))).toEqual([
      'conn-123-abc.json'
    ])
    expect(
      schemaCache.loadCacheFile('conn-123-abc', 'identity')?.databases
    ).toEqual(['db1', 'db2'])
  })
})
