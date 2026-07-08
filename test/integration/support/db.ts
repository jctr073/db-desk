/**
 * Harness around the real postgres driver.
 *
 * State is reset through an independent admin client, never through the code
 * under test -- a bug in runQuery must not be able to hide itself by also
 * breaking the reset.
 *
 * runAsAgent/runAsEditor mirror the two ways src/main calls the driver, so a
 * test exercises the same options the app does rather than an approximation:
 *   agent  -> src/main/agent.ts       readOnly: true, limit 500, 30s timeout
 *   editor -> src/main/index.ts       no readOnly, no limit
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { postgresDriver } from '../../../src/main/drivers/postgres'
import type { DbResult, QueryResult } from '../../../src/shared/db'
import { clientConfig, connectParams, PG_DATABASE } from './config'

/** TOOL_RUN_LIMIT / AGENT_STATEMENT_TIMEOUT_MS in src/main/agent.ts. */
export const AGENT_LIMIT = 500
export const AGENT_TIMEOUT_MS = 30_000

const DATA_SQL = fileURLToPath(new URL('../../seed/02-data.sql', import.meta.url))

let admin: Client | undefined
let connSeq = 0

export async function startAdmin(): Promise<Client> {
  if (!admin) {
    admin = new Client(clientConfig())
    await admin.connect()
  }
  return admin
}

export async function stopAdmin(): Promise<void> {
  await admin?.end()
  admin = undefined
}

/** Restore the seed rows. Safe to call between every test. */
export async function resetData(): Promise<void> {
  const client = await startAdmin()
  await client.query(readFileSync(DATA_SQL, 'utf8'))
}

export interface RowCounts {
  customers: number
  orders: number
  orderItems: number
}

export async function rowCounts(): Promise<RowCounts> {
  const client = await startAdmin()
  const res = await client.query<{ c: string; o: string; i: string }>(
    `SELECT (SELECT count(*) FROM customers)   AS c,
            (SELECT count(*) FROM orders)      AS o,
            (SELECT count(*) FROM order_items) AS i`
  )
  const { c, o, i } = res.rows[0]
  return { customers: Number(c), orders: Number(o), orderItems: Number(i) }
}

/** Drop anything a DDL test may have created, so the schema stays as seeded. */
export async function dropStrayObjects(): Promise<void> {
  const client = await startAdmin()
  await client.query(`
    DROP TABLE IF EXISTS probe_into, probe_created CASCADE;
    ALTER TABLE customers DROP COLUMN IF EXISTS nickname;
  `)
}

/** Connect the real driver; returns the connId to pass back into it. */
export async function connectDriver(readOnlyRole = false): Promise<string> {
  const connId = `test-conn-${++connSeq}-${process.pid}`
  const res = await postgresDriver.connect(connId, connectParams(readOnlyRole))
  if (!res.ok) throw new Error(`driver connect failed: ${res.error}`)
  return connId
}

export async function disconnectDriver(connId: string): Promise<void> {
  await postgresDriver.disconnect(connId)
}

/** Exactly how src/main/agent.ts invokes the driver today. */
export function runAsAgent(
  connId: string,
  sql: string
): Promise<DbResult<QueryResult>> {
  return postgresDriver.runQuery(connId, PG_DATABASE, sql, AGENT_LIMIT, {
    readOnly: true,
    timeoutMs: AGENT_TIMEOUT_MS
  })
}

/** Exactly how the editor's Run button invokes the driver today. */
export function runAsEditor(
  connId: string,
  sql: string
): Promise<DbResult<QueryResult>> {
  return postgresDriver.runQuery(connId, PG_DATABASE, sql, null, {})
}
