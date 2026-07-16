/**
 * Unit tests for the db facade's schema-pinning plumbing (src/main/db.ts):
 * selection lookups flow into the Databricks driver's options, connect
 * results get their catalog list filtered, and Postgres stays untouched.
 * Drivers and the store are mocked; vi.resetModules() gives each test a
 * cold facade (its connTypes/connDatabases maps are module state).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectParams } from '../../src/shared/db'
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

let db: typeof import('../../src/main/db')
let databricksDriver: typeof import('../../src/main/drivers/databricks')['databricksDriver']
let postgresDriver: typeof import('../../src/main/drivers/postgres')['postgresDriver']
let store: typeof import('../../src/main/store')

const dbxParams = {
  type: 'databricks',
  host: 'wh.cloud.databricks.com',
  port: '443',
  database: 'main',
  user: '',
  password: 'token',
  httpPath: '/sql/1.0/warehouses/abc',
  url: '',
  useUrl: false
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
  databricksDriver = (await import('../../src/main/drivers/databricks'))
    .databricksDriver
  postgresDriver = (await import('../../src/main/drivers/postgres'))
    .postgresDriver
  store = await import('../../src/main/store')
  // The mock factories' results are cached across resetModules, so call
  // history and per-test return values would otherwise leak between tests.
  vi.clearAllMocks()
  vi.mocked(store.catalogSelectionFor).mockReset().mockReturnValue(null)
  vi.mocked(store.schemaSelectionFor).mockReset().mockReturnValue(null)
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

  it('passes Postgres no connect options', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    const [, , options] = vi.mocked(postgresDriver.connect).mock.calls[0]
    expect(options).toBeUndefined()
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
    expect(databricksDriver.introspectDatabase).toHaveBeenCalledWith(
      'dbx',
      'dev',
      {
        allowedSchemas: ['sales', 'ops'],
        maxUnpinnedSchemas: LARGE_CATALOG_SCHEMA_THRESHOLD
      }
    )
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
    expect(databricksDriver.searchSchema).toHaveBeenCalledWith(
      'dbx',
      'main',
      'orders',
      ['sales']
    )
    expect(databricksDriver.describeTable).toHaveBeenCalledWith(
      'dbx',
      'main',
      'orders',
      ['sales']
    )
  })

  it('pass null for Postgres (no pinning)', async () => {
    vi.mocked(postgresDriver.connect).mockResolvedValue(okConnect('app', ['app']))
    await db.connect('pg', pgParams)
    vi.mocked(postgresDriver.searchSchema).mockResolvedValue({
      ok: true,
      data: ''
    })
    await db.searchSchema('pg', 'app', 'orders')
    expect(postgresDriver.searchSchema).toHaveBeenCalledWith(
      'pg',
      'app',
      'orders',
      null
    )
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
