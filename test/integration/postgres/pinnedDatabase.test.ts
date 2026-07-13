/**
 * A PostgreSQL connection is pinned to exactly one database, chosen at connect
 * time. This suite proves the hard, main-process enforcement against a real
 * server:
 *   - a connect with no database is refused up front;
 *   - ConnectResult.databases is exactly the connected database (no sibling
 *     enumeration);
 *   - introspect/query/describe/search against any other database name is
 *     rejected with the pinning error rather than silently crossing over.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../../src/main/drivers/postgres'
import { connectParams, PG_DATABASE } from '../support/config'

const OTHER_DB = 'postgres' // a real, connectable sibling we must NOT reach

let connId: string

beforeAll(async () => {
  connId = `test-conn-pin-${process.pid}`
  const res = await postgresDriver.connect(connId, connectParams())
  if (!res.ok) throw new Error(`driver connect failed: ${res.error}`)
})

afterAll(async () => {
  await postgresDriver.disconnect(connId)
  await postgresDriver.disconnectAll()
})

describe('PostgreSQL is pinned to a single database', () => {
  it('refuses to connect when no database is named', async () => {
    const res = await postgresDriver.connect(`${connId}-nodb`, {
      ...connectParams(),
      database: ''
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('A database is required for PostgreSQL connections.')
    }
  })

  it('reports exactly the connected database, no sibling enumeration', async () => {
    // A fresh connect so we can read ConnectResult directly.
    const probeId = `${connId}-probe`
    const res = await postgresDriver.connect(probeId, connectParams())
    try {
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.databases).toEqual([PG_DATABASE])
        expect(res.data.connectedDatabase.name).toBe(PG_DATABASE)
      }
    } finally {
      await postgresDriver.disconnect(probeId)
    }
  })

  it('introspects the pinned database when the name matches or is empty', async () => {
    const named = await postgresDriver.introspectDatabase(connId, PG_DATABASE)
    expect(named.ok).toBe(true)
    const empty = await postgresDriver.introspectDatabase(connId, '')
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.data.name).toBe(PG_DATABASE)
  })

  it('rejects introspecting a different database with the pinning error', async () => {
    const res = await postgresDriver.introspectDatabase(connId, OTHER_DB)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe(`This connection is pinned to database "${PG_DATABASE}".`)
    }
  })

  it('rejects running a query against a different database', async () => {
    const res = await postgresDriver.runQuery(connId, OTHER_DB, 'SELECT 1', null, {})
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe(`This connection is pinned to database "${PG_DATABASE}".`)
    }
  })

  it('rejects describe_table and search against a different database', async () => {
    const desc = await postgresDriver.describeTable(connId, OTHER_DB, 'customers')
    expect(desc.ok).toBe(false)
    if (!desc.ok) {
      expect(desc.error).toBe(`This connection is pinned to database "${PG_DATABASE}".`)
    }
    const search = await postgresDriver.searchSchema(connId, OTHER_DB, 'cust')
    expect(search.ok).toBe(false)
    if (!search.ok) {
      expect(search.error).toBe(`This connection is pinned to database "${PG_DATABASE}".`)
    }
  })

  it('still serves the pinned database through query and describe', async () => {
    const q = await postgresDriver.runQuery(connId, PG_DATABASE, 'SELECT 1 AS one', null, {})
    expect(q.ok).toBe(true)
    const d = await postgresDriver.describeTable(connId, '', 'customers')
    expect(d.ok).toBe(true)
  })
})
