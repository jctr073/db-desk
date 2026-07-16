/**
 * Unit tests for the main-process connection store (src/main/store.ts).
 *
 * Follows the electron-mocking pattern from knowledge.test.ts: `app.getPath`
 * is pointed at a fresh per-test temp dir, and `vi.resetModules()` + a
 * dynamic re-import gives each test a cold module-level cache. `safeStorage`
 * is also mocked here (store.ts encrypts saved passwords; knowledge.ts does
 * not), as a trivial reversible prefix codec — good enough to exercise
 * save/load round-trips without pulling in the OS keychain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConnectParams } from '../../src/shared/db'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string): Buffer => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer): string => {
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return s.slice('enc:'.length)
    }
  }
}))

let store: typeof import('../../src/main/store')
let knowledge: typeof import('../../src/main/knowledge')

function storePath(): string {
  return join(userDataDir, 'connections.json')
}

function knowledgeDir(): string {
  return join(userDataDir, 'knowledge')
}

const params: ConnectParams = {
  type: 'postgres',
  host: 'localhost',
  port: '5432',
  database: 'app',
  user: 'admin',
  password: 'hunter2',
  httpPath: '',
  url: '',
  useUrl: false
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-store-'))
  vi.resetModules()
  store = await import('../../src/main/store')
  knowledge = await import('../../src/main/knowledge')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('fresh-start reset from a legacy bare-array file', () => {
  it('discards legacy connections, wipes knowledge, and writes an empty v2 file', async () => {
    // Seed a legacy (pre-version-2) bare-array connections.json.
    writeFileSync(
      storePath(),
      JSON.stringify([
        {
          id: 'c-1',
          name: 'old',
          host: 'h',
          port: '5432',
          database: 'd',
          user: 'u',
          url: '',
          useUrl: false
        }
      ]),
      'utf8'
    )
    // Seed a knowledge file that should be wiped alongside it.
    mkdirSync(join(knowledgeDir(), 'c-1'), { recursive: true })
    writeFileSync(
      join(knowledgeDir(), 'c-1', 'analytics.json'),
      JSON.stringify({ version: 1, rawDatabase: 'analytics', records: [] }),
      'utf8'
    )

    expect(store.listSaved()).toEqual([])
    expect(existsSync(knowledgeDir())).toBe(false)

    const onDisk = JSON.parse(readFileSync(storePath(), 'utf8'))
    expect(onDisk).toEqual({ version: 2, connections: [] })
  })

  it('is idempotent: a second load does not re-wipe or error', async () => {
    writeFileSync(
      storePath(),
      JSON.stringify([{ id: 'c-1', name: 'old', host: 'h', port: '5432', database: 'd', user: 'u', url: '', useUrl: false }]),
      'utf8'
    )
    expect(store.listSaved()).toEqual([])

    // Recreate knowledge dir to prove a second load leaves it alone (no re-wipe).
    mkdirSync(join(knowledgeDir(), 'c-2'), { recursive: true })

    vi.resetModules()
    const reloaded = await import('../../src/main/store')
    expect(reloaded.listSaved()).toEqual([])
    // The v2 file from the first load is respected, not re-migrated.
    expect(existsSync(join(knowledgeDir(), 'c-2'))).toBe(true)
  })
})

describe('version-2 file round-trip', () => {
  it('saves a connection and reads it back after a simulated restart', async () => {
    const saved = store.saveConnection('c-1', 'primary', params, true)
    expect(saved.hasPassword).toBe(true)

    const onDisk = JSON.parse(readFileSync(storePath(), 'utf8'))
    expect(onDisk.version).toBe(2)
    expect(onDisk.connections).toHaveLength(1)

    vi.resetModules()
    const reloaded = await import('../../src/main/store')
    expect(reloaded.listSaved()).toEqual([saved])
    expect(reloaded.savedParams('c-1')).toMatchObject({ host: 'localhost', password: 'hunter2' })
  })

  it('updates an existing record in place rather than duplicating it', () => {
    store.saveConnection('c-1', 'primary', params, true)
    store.saveConnection('c-1', 'renamed', params, true)
    expect(store.listSaved()).toHaveLength(1)
    expect(store.listSaved()[0].name).toBe('renamed')
  })

  it('deletes a saved connection', () => {
    store.saveConnection('c-1', 'primary', params, true)
    store.deleteSaved('c-1')
    expect(store.listSaved()).toEqual([])
  })

  it('writes the file 0o600', () => {
    store.saveConnection('c-1', 'primary', params, true)
    const mode = statSync(storePath()).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('schema/catalog selections (Databricks pinning)', () => {
  const dbxParams: ConnectParams = {
    ...params,
    type: 'databricks',
    host: 'wh.cloud.databricks.com',
    port: '443',
    database: 'main',
    httpPath: '/sql/1.0/warehouses/abc'
  }

  it('round-trips selections across a simulated restart, staying version 2', async () => {
    store.saveConnection('c-1', 'warehouse', dbxParams, true)
    store.setSchemaSelection('c-1', 'main', ['sales', 'ops'])
    store.setCatalogSelection('c-1', ['main', 'dev'])

    const onDisk = JSON.parse(readFileSync(storePath(), 'utf8'))
    expect(onDisk.version).toBe(2)

    vi.resetModules()
    const reloaded = await import('../../src/main/store')
    expect(reloaded.getSchemaConfig('c-1')).toEqual({
      catalogs: ['main', 'dev'],
      schemas: { main: ['sales', 'ops'] }
    })
    expect(reloaded.schemaSelectionFor('c-1', 'main')).toEqual(['sales', 'ops'])
    expect(reloaded.schemaSelectionFor('c-1', 'other')).toBeNull()
    expect(reloaded.catalogSelectionFor('c-1')).toEqual(['main', 'dev'])
  })

  it('re-saving the connection preserves selections', () => {
    store.saveConnection('c-1', 'warehouse', dbxParams, true)
    store.setSchemaSelection('c-1', 'main', ['sales'])
    store.setCatalogSelection('c-1', ['main'])
    store.saveConnection('c-1', 'renamed', dbxParams, true)
    expect(store.getSchemaConfig('c-1')).toEqual({
      catalogs: ['main'],
      schemas: { main: ['sales'] }
    })
  })

  it('null clears a selection back to "all"', () => {
    store.saveConnection('c-1', 'warehouse', dbxParams, true)
    store.setSchemaSelection('c-1', 'main', ['sales'])
    store.setSchemaSelection('c-1', 'dev', ['x'])
    store.setCatalogSelection('c-1', ['main'])

    store.setSchemaSelection('c-1', 'main', null)
    store.setCatalogSelection('c-1', null)
    expect(store.getSchemaConfig('c-1')).toEqual({
      catalogs: null,
      schemas: { dev: ['x'] }
    })

    // Clearing the last per-catalog entry removes the field entirely.
    store.setSchemaSelection('c-1', 'dev', null)
    const onDisk = JSON.parse(readFileSync(storePath(), 'utf8'))
    expect(onDisk.connections[0]).not.toHaveProperty('schemaSelections')
    expect(onDisk.connections[0]).not.toHaveProperty('catalogSelection')
  })

  it('replaces the full hierarchy atomically, including an empty catalog selection', () => {
    store.saveConnection('c-1', 'warehouse', dbxParams, true)
    store.setSchemaSelection('c-1', 'old', ['legacy'])

    store.setSchemaConfig('c-1', {
      catalogs: [],
      schemas: { main: ['sales'], dev: ['sandbox'] }
    })

    expect(store.getSchemaConfig('c-1')).toEqual({
      catalogs: [],
      schemas: { main: ['sales'], dev: ['sandbox'] }
    })
    expect(store.schemaSelectionFor('c-1', 'old')).toBeNull()
  })

  it('defaults to no selection for unknown connections', () => {
    expect(store.getSchemaConfig('missing')).toEqual({
      catalogs: null,
      schemas: {}
    })
    expect(store.schemaSelectionFor('missing', 'main')).toBeNull()
    expect(store.catalogSelectionFor('missing')).toBeNull()
  })

  it('setters are a no-op for unknown connection ids', () => {
    store.saveConnection('c-1', 'warehouse', dbxParams, true)
    store.setSchemaSelection('nope', 'main', ['sales'])
    store.setCatalogSelection('nope', ['main'])
    expect(store.getSchemaConfig('nope')).toEqual({ catalogs: null, schemas: {} })
    expect(store.listSaved()).toHaveLength(1)
  })

  it('deleteSaved removes selections along with the record', () => {
    store.saveConnection('c-1', 'warehouse', dbxParams, true)
    store.setSchemaSelection('c-1', 'main', ['sales'])
    store.deleteSaved('c-1')
    expect(store.getSchemaConfig('c-1')).toEqual({ catalogs: null, schemas: {} })
  })
})

describe('missing or corrupt file', () => {
  it('starts empty when connections.json does not exist', () => {
    expect(existsSync(storePath())).toBe(false)
    expect(store.listSaved()).toEqual([])
  })

  it('starts empty on unparseable JSON without touching knowledge', () => {
    mkdirSync(join(knowledgeDir(), 'c-1'), { recursive: true })
    writeFileSync(storePath(), '{ not json', 'utf8')
    expect(store.listSaved()).toEqual([])
    // Corrupt (not legacy-array) files are not a migration trigger.
    expect(existsSync(join(knowledgeDir(), 'c-1'))).toBe(true)
  })

  it('starts empty when the file is valid JSON but neither shape', () => {
    writeFileSync(storePath(), JSON.stringify({ foo: 'bar' }), 'utf8')
    expect(store.listSaved()).toEqual([])
  })
})

describe('knowledge.wipeAll', () => {
  it('removes the knowledge directory', () => {
    const base = knowledge.createBase('B')
    knowledge.saveRecord(base.id, {
      kind: 'note',
      source: 'human',
      title: 't',
      body: 'b',
      references: []
    })
    expect(existsSync(knowledgeDir())).toBe(true)
    knowledge.wipeAll()
    expect(existsSync(knowledgeDir())).toBe(false)
    expect(knowledge.listBases()).toEqual([])
  })

  it('is a no-op when the knowledge directory does not exist', () => {
    expect(existsSync(knowledgeDir())).toBe(false)
    expect(() => knowledge.wipeAll()).not.toThrow()
  })
})
