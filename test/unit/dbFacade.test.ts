/**
 * Unit tests for the db facade's schema-pinning plumbing (src/main/db.ts):
 * selection lookups flow into the Databricks driver's options, connect
 * results get their catalog list filtered, and Postgres stays untouched.
 * Drivers and the store are mocked; vi.resetModules() gives each test a
 * cold facade (its connTypes/connDatabases maps are module state).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectParams, QueryResult, SchemaRefreshEvent } from '../../src/shared/db'
import { LARGE_CATALOG_SCHEMA_THRESHOLD } from '../../src/shared/schemaSelection'

vi.mock('../../src/main/drivers/databricks', () => ({
  databricksDriver: {
    test: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getServerVersion: vi.fn(),
    introspectDatabase: vi.fn(),
    runQuery: vi.fn(),
    describeTable: vi.fn(),
    searchSchema: vi.fn(),
    listSchemas: vi.fn(),
    listCatalogs: vi.fn()
  }
}))

vi.mock('../../src/main/drivers/postgres', () => ({
  PG_READ_ONLY_VIOLATION_CODES: new Set<string>(),
  postgresDriver: {
    test: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getServerVersion: vi.fn(),
    introspectDatabase: vi.fn(),
    runQuery: vi.fn(),
    describeTable: vi.fn(),
    searchSchema: vi.fn()
  }
}))

vi.mock('../../src/main/store', () => ({
  catalogSelectionFor: vi.fn(() => null),
  schemaSelectionFor: vi.fn(() => null)
}))

// The persistent schema cache touches Electron's app paths; unit tests run
// the facade against a mock of it (default: empty cache, everything misses).
vi.mock('../../src/main/schemaCache', () => ({
  cacheIdentityFor: vi.fn(() => 'identity'),
  loadCacheFile: vi.fn(() => null),
  cachedIntrospection: vi.fn(() => null),
  saveIntrospection: vi.fn(),
  saveDatabases: vi.fn(),
  dropIntrospection: vi.fn(),
  deleteCacheFor: vi.fn(),
  sameSelection: (a: string[] | null, b: string[] | null): boolean => {
    if (!a || !b) return !a && !b
    return a.length === b.length && a.every((name) => b.includes(name))
  }
}))

let db: typeof import('../../src/main/db')
let databricksDriver: (typeof import('../../src/main/drivers/databricks'))['databricksDriver']
let postgresDriver: (typeof import('../../src/main/drivers/postgres'))['postgresDriver']
let store: typeof import('../../src/main/store')
let schemaCache: typeof import('../../src/main/schemaCache')

const dbxParams = {
  type: 'databricks',
  host: 'wh.cloud.databricks.com',
  port: '443',
  database: 'main',
  user: '',
  password: 'token',
  httpPath: '/sql/1.0/warehouses/abc',
  url: '',
  useUrl: false,
  environment: 'dev'
} as ConnectParams

const pgParams = { ...dbxParams, type: 'postgres' } as ConnectParams

function okConnect(connected: string, databases: string[]) {
  return {
    ok: true as const,
    data: {
      serverVersion: '1',
      connectedDatabase: { name: connected, schemas: [] },
      databases
    }
  }
}

beforeEach(async () => {
  vi.resetModules()
  db = await import('../../src/main/db')
  databricksDriver = (await import('../../src/main/drivers/databricks')).databricksDriver
  postgresDriver = (await import('../../src/main/drivers/postgres')).postgresDriver
  store = await import('../../src/main/store')
  schemaCache = await import('../../src/main/schemaCache')
  // The mock factories' results are cached across resetModules, so call
  // history and per-test return values would otherwise leak between tests.
  vi.clearAllMocks()
  vi.mocked(store.catalogSelectionFor).mockReset().mockReturnValue(null)
  vi.mocked(store.schemaSelectionFor).mockReset().mockReturnValue(null)
  vi.mocked(schemaCache.cacheIdentityFor).mockReset().mockReturnValue('identity')
  vi.mocked(schemaCache.loadCacheFile).mockReset().mockReturnValue(null)
  vi.mocked(schemaCache.cachedIntrospection).mockReset().mockReturnValue(null)
})

async function connectDatabricks(connId = 'dbx'): Promise<void> {
  vi.mocked(databricksDriver.connect).mockResolvedValue(
    okConnect('main', ['main', 'dev', 'legacy'])
  )
  const res = await db.connect(connId, dbxParams)
  expect(res.ok).toBe(true)
}

describe('connect', () => {
  it('hands the Databricks driver a per-catalog selection lookup and the threshold', async () => {
    vi.mocked(store.schemaSelectionFor).mockReturnValue(['sales'])
    await connectDatabricks()
    const [, , options] = vi.mocked(databricksDriver.connect).mock.calls[0]
    expect(options?.maxUnpinnedSchemas).toBe(LARGE_CATALOG_SCHEMA_THRESHOLD)
    expect(options?.schemaSelectionFor?.('main')).toEqual(['sales'])
    expect(store.schemaSelectionFor).toHaveBeenCalledWith('dbx', 'main')
  })

  it('allows the saved selection to hide the initially connected catalog', async () => {
    vi.mocked(store.catalogSelectionFor).mockReturnValue(['dev'])
    vi.mocked(databricksDriver.connect).mockResolvedValue(
      okConnect('main', ['main', 'dev', 'legacy'])
    )
    const res = await db.connect('dbx', dbxParams)
    expect(res.ok && res.data.databases).toEqual(['dev'])
  })

  it('leaves the catalog list alone when no selection is saved', async () => {
    await connectDatabricks()
    const res = vi.mocked(databricksDriver.connect).mock.results[0]
    expect(res).toBeDefined()
    // catalogSelectionFor returned null → nothing filtered.
    expect(store.catalogSelectionFor).toHaveBeenCalledWith('dbx')
  })

  it('passes Postgres only the cache flag, no pinning options', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    const [, , options] = vi.mocked(postgresDriver.connect).mock.calls[0]
    expect(options).toEqual({ skipIntrospection: false })
  })

  it('rejects a missing/invalid environment with ENV_REQUIRED, never touching the driver', async () => {
    const res = await db.connect('pg', { ...pgParams, environment: null })
    expect(res).toEqual({
      ok: false,
      error: 'This connection needs an environment (dev / stage / prod) before it can connect.',
      code: 'ENV_REQUIRED'
    })
    expect(postgresDriver.connect).not.toHaveBeenCalled()
  })

  it('rejects an out-of-enum environment string the same way', async () => {
    const res = await db.connect('pg', {
      ...pgParams,
      environment: 'production' as unknown as ConnectParams['environment']
    })
    expect(res.ok).toBe(false)
    expect(!res.ok && res.code).toBe('ENV_REQUIRED')
    expect(postgresDriver.connect).not.toHaveBeenCalled()
  })
})

describe('introspectDatabase', () => {
  it('threads allowedSchemas and the threshold for Databricks', async () => {
    await connectDatabricks()
    vi.mocked(store.schemaSelectionFor).mockReturnValue(['sales', 'ops'])
    vi.mocked(databricksDriver.introspectDatabase).mockResolvedValue({
      ok: true,
      data: { name: 'dev', schemas: [] }
    })
    await db.introspectDatabase('dbx', 'dev')
    expect(databricksDriver.introspectDatabase).toHaveBeenCalledWith('dbx', 'dev', {
      allowedSchemas: ['sales', 'ops'],
      maxUnpinnedSchemas: LARGE_CATALOG_SCHEMA_THRESHOLD
    })
    expect(store.schemaSelectionFor).toHaveBeenLastCalledWith('dbx', 'dev')
  })

  it('resolves an empty database name to the connected catalog', async () => {
    await connectDatabricks()
    vi.mocked(databricksDriver.introspectDatabase).mockResolvedValue({
      ok: true,
      data: { name: 'main', schemas: [] }
    })
    await db.introspectDatabase('dbx', '')
    expect(store.schemaSelectionFor).toHaveBeenLastCalledWith('dbx', 'main')
  })

  it('passes Postgres no options at all', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    vi.mocked(postgresDriver.introspectDatabase).mockResolvedValue({
      ok: true,
      data: { name: 'app', schemas: [] }
    })
    await db.introspectDatabase('pg', 'app')
    expect(postgresDriver.introspectDatabase).toHaveBeenCalledWith('pg', 'app')
    expect(store.schemaSelectionFor).not.toHaveBeenCalled()
  })
})

describe('searchSchema / describeTable', () => {
  it('pass the saved selection through for Databricks', async () => {
    await connectDatabricks()
    vi.mocked(store.schemaSelectionFor).mockReturnValue(['sales'])
    vi.mocked(databricksDriver.searchSchema).mockResolvedValue({
      ok: true,
      data: ''
    })
    vi.mocked(databricksDriver.describeTable).mockResolvedValue({
      ok: true,
      data: ''
    })
    await db.searchSchema('dbx', 'main', 'orders')
    await db.describeTable('dbx', 'main', 'orders')
    expect(databricksDriver.searchSchema).toHaveBeenCalledWith('dbx', 'main', 'orders', ['sales'])
    expect(databricksDriver.describeTable).toHaveBeenCalledWith('dbx', 'main', 'orders', ['sales'])
  })

  it('pass null for Postgres (no pinning)', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    vi.mocked(postgresDriver.searchSchema).mockResolvedValue({
      ok: true,
      data: ''
    })
    await db.searchSchema('pg', 'app', 'orders')
    expect(postgresDriver.searchSchema).toHaveBeenCalledWith('pg', 'app', 'orders', null)
  })
})

describe('listSchemas / listCatalogs', () => {
  it('delegate to the Databricks driver, unfiltered', async () => {
    await connectDatabricks()
    vi.mocked(databricksDriver.listSchemas!).mockResolvedValue({
      ok: true,
      data: ['a', 'b']
    })
    vi.mocked(databricksDriver.listCatalogs!).mockResolvedValue({
      ok: true,
      data: ['main', 'dev']
    })
    expect(await db.listSchemas('dbx', 'main')).toEqual({
      ok: true,
      data: ['a', 'b']
    })
    expect(await db.listCatalogs('dbx')).toEqual({
      ok: true,
      data: ['main', 'dev']
    })
  })

  it('report "not supported" for engines without the optional methods', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    const schemas = await db.listSchemas('pg', 'app')
    const catalogs = await db.listCatalogs('pg')
    expect(schemas.ok).toBe(false)
    expect(catalogs.ok).toBe(false)
  })
})

function okQuery(command: string): { ok: true; data: QueryResult } {
  return {
    ok: true,
    data: {
      command,
      fields: [],
      rows: [],
      rowCount: null,
      durationMs: 1,
      limitApplied: null,
      truncated: false
    }
  }
}

describe('schema cache', () => {
  it('serves cached metadata on reconnect and revalidates in the background', async () => {
    const cachedDb = {
      name: 'main',
      schemas: [
        {
          name: 'sales',
          tables: [],
          views: [],
          matviews: [],
          indexes: [],
          functions: [],
          sequences: [],
          types: [],
          aggregates: []
        }
      ]
    }
    vi.mocked(schemaCache.loadCacheFile).mockReturnValue({
      version: 1,
      identity: 'identity',
      savedAt: 0,
      databases: ['main', 'dev'],
      introspections: {}
    })
    vi.mocked(schemaCache.cachedIntrospection).mockReturnValue(cachedDb)
    vi.mocked(databricksDriver.connect).mockResolvedValue(okConnect('main', ['main']))
    vi.mocked(databricksDriver.introspectDatabase).mockResolvedValue({
      ok: true,
      data: { name: 'main', schemas: [] }
    })
    vi.mocked(databricksDriver.listCatalogs!).mockResolvedValue({
      ok: true,
      data: ['main', 'dev']
    })
    const events: SchemaRefreshEvent[] = []
    db.setSchemaEventSink((evt) => events.push(evt))

    const res = await db.connect('dbx', dbxParams)
    const [, , options] = vi.mocked(databricksDriver.connect).mock.calls[0]
    expect(options?.skipIntrospection).toBe(true)
    expect(res.ok && res.data.connectedDatabase).toBe(cachedDb)
    expect(res.ok && res.data.databases).toEqual(['main', 'dev'])

    await vi.waitFor(() => {
      expect(events.map((evt) => evt.state)).toEqual(['validating', 'ok'])
    })
    // The fresh introspection differs from the cache, so the ok event
    // carries it and the cache entry gets rewritten.
    expect(events[1].introspection).toEqual({ name: 'main', schemas: [] })
    expect(schemaCache.saveIntrospection).toHaveBeenCalled()
  })

  it('serves db:introspect from the cache and revalidates in the background', async () => {
    await connectDatabricks()
    const cachedDev = { name: 'dev', schemas: [] }
    vi.mocked(schemaCache.cachedIntrospection).mockReturnValue(cachedDev)
    vi.mocked(databricksDriver.introspectDatabase).mockResolvedValue({
      ok: true,
      data: { name: 'dev', schemas: [] }
    })
    const events: SchemaRefreshEvent[] = []
    db.setSchemaEventSink((evt) => events.push(evt))

    const res = await db.introspectDatabase('dbx', 'dev')
    expect(res.ok && res.data).toBe(cachedDev)
    await vi.waitFor(() => {
      expect(events.map((evt) => evt.state)).toEqual(['validating', 'ok'])
    })
    // Fresh result matches the cache: no introspection payload pushed.
    expect(events[1].unchanged).toBe(true)
    expect(events[1].introspection).toBeUndefined()
  })

  it('revalidates after successful DDL, but not after reads', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    vi.mocked(postgresDriver.introspectDatabase).mockResolvedValue({
      ok: true,
      data: { name: 'app', schemas: [] }
    })
    const events: SchemaRefreshEvent[] = []
    db.setSchemaEventSink((evt) => events.push(evt))

    vi.mocked(postgresDriver.runQuery).mockResolvedValue(okQuery('SELECT'))
    await db.runQuery('pg', 'app', 'SELECT 1', null)
    expect(events).toEqual([])

    vi.mocked(postgresDriver.runQuery).mockResolvedValue(okQuery('CREATE TABLE'))
    await db.runQuery('pg', 'app', 'CREATE TABLE t (x int)', null)
    await vi.waitFor(() => {
      expect(events.map((evt) => evt.state)).toEqual(['validating', 'ok'])
    })
    expect(postgresDriver.introspectDatabase).toHaveBeenCalledWith('pg', 'app')
  })
})

function probeRow(overrides: Record<string, boolean> = {}): { ok: true; data: QueryResult } {
  const names = [
    'any_super',
    'any_bypassrls',
    'any_createdb',
    'any_table_write',
    'any_sequence_write',
    'any_schema_create',
    'any_db_create'
  ]
  return {
    ok: true,
    data: {
      command: 'SELECT',
      fields: names.map((name) => ({ name, dataType: 'bool' })),
      rows: [names.map((name) => overrides[name] ?? false)],
      rowCount: 1,
      durationMs: 1,
      limitApplied: null,
      truncated: false
    }
  }
}

describe('agent capability', () => {
  it.each(['dev', 'stage'] as const)(
    'grants %s connections Read-Only without running the probe',
    async (environment) => {
      vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
      const res = await db.connect('pg', { ...pgParams, environment })
      expect(res.ok && res.data.agentCapability).toEqual({
        readOnlyAvailable: true,
        reason: null
      })
      // Byte-identical to pre-feature behavior: no probe, no extra queries.
      expect(postgresDriver.runQuery).not.toHaveBeenCalled()
      expect(db.agentCapabilityFor('pg')).toEqual({ readOnlyAvailable: true, reason: null })
    }
  )

  it('probes prod Postgres read-only and grants when nothing is writable', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    vi.mocked(postgresDriver.runQuery).mockResolvedValue(probeRow())
    const res = await db.connect('pg', { ...pgParams, environment: 'prod' })
    expect(res.ok && res.data.agentCapability.readOnlyAvailable).toBe(true)
    const [, database, , limit, options] = vi.mocked(postgresDriver.runQuery).mock.calls[0]
    expect(database).toBe('app')
    expect(limit).toBeNull()
    expect(options).toEqual({ readOnly: true, timeoutMs: 5000 })
  })

  it('clamps prod Postgres when the role can write', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    vi.mocked(postgresDriver.runQuery).mockResolvedValue(probeRow({ any_table_write: true }))
    const res = await db.connect('pg', { ...pgParams, environment: 'prod' })
    expect(res.ok && res.data.agentCapability.readOnlyAvailable).toBe(false)
    expect(res.ok && res.data.agentCapability.reason).toMatch(/read-only role/)
  })

  it('clamps prod Postgres when the probe fails (fail closed)', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    vi.mocked(postgresDriver.runQuery).mockResolvedValue({ ok: false, error: 'timeout' })
    const res = await db.connect('pg', { ...pgParams, environment: 'prod' })
    expect(res.ok && res.data.agentCapability.readOnlyAvailable).toBe(false)
    expect(res.ok && res.data.agentCapability.reason).toMatch(/Could not verify/)
  })

  it('clamps prod Databricks unconditionally, without probing', async () => {
    vi.mocked(databricksDriver.connect).mockResolvedValue(okConnect('main', ['main']))
    const res = await db.connect('dbx', { ...dbxParams, environment: 'prod' })
    expect(res.ok && res.data.agentCapability.readOnlyAvailable).toBe(false)
    expect(databricksDriver.runQuery).not.toHaveBeenCalled()
  })

  it('forgets the capability on disconnect', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    vi.mocked(postgresDriver.disconnect).mockResolvedValue({ ok: true, data: null })
    await db.connect('pg', pgParams)
    expect(db.agentCapabilityFor('pg')).not.toBeNull()
    await db.disconnect('pg')
    expect(db.agentCapabilityFor('pg')).toBeNull()
  })
})

describe('runAgentQuery capability belt', () => {
  it('refuses every agent statement on a clamped connection', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    vi.mocked(postgresDriver.runQuery).mockResolvedValue(probeRow({ any_super: true }))
    await db.connect('pg', { ...pgParams, environment: 'prod' })
    vi.mocked(postgresDriver.runQuery).mockClear()

    const res = await db.runAgentQuery('pg', 'app', 'SELECT 1', 500)
    expect(res.ok).toBe(false)
    expect(!res.ok && res.code).toBe(db.AGENT_BLOCKED_CODE)
    // The driver is never reached — the belt sits in front of the guard.
    expect(postgresDriver.runQuery).not.toHaveBeenCalled()
  })

  it('lets a provably read-only prod connection run agent statements', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    vi.mocked(postgresDriver.runQuery).mockResolvedValue(probeRow())
    await db.connect('pg', { ...pgParams, environment: 'prod' })
    vi.mocked(postgresDriver.runQuery).mockClear()
    vi.mocked(postgresDriver.runQuery).mockResolvedValue(okQuery('SELECT'))

    const res = await db.runAgentQuery('pg', 'app', 'SELECT 1', 500)
    expect(res.ok).toBe(true)
    const [, , , , options] = vi.mocked(postgresDriver.runQuery).mock.calls[0]
    expect(options?.readOnly).toBe(true)
  })
})
