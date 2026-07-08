/**
 * Connection details for the disposable Postgres in test/docker-compose.yml.
 * Everything is overridable by env so CI can point at a server it already has.
 */

import type { ConnectParams } from '../../../src/shared/db'

export const PG_PORT = process.env.DBDESK_TEST_PG_PORT ?? '55432'
export const PG_HOST = process.env.DBDESK_TEST_PG_HOST ?? 'localhost'
export const PG_DATABASE = 'dbdesk_test'

/** Owner of the schema: full privileges, i.e. the worst case the agent faces. */
export const PG_USER = 'dbdesk'
export const PG_PASSWORD = 'dbdesk'

/** Login role with SELECT and nothing else -- the wall the README recommends. */
export const PG_RO_USER = 'dbdesk_ro'
export const PG_RO_PASSWORD = 'dbdesk_ro'

/** Node-pg client config (harness only -- never the code under test). */
export function clientConfig(readOnlyRole = false): {
  host: string
  port: number
  user: string
  password: string
  database: string
} {
  return {
    host: PG_HOST,
    port: Number(PG_PORT),
    user: readOnlyRole ? PG_RO_USER : PG_USER,
    password: readOnlyRole ? PG_RO_PASSWORD : PG_PASSWORD,
    database: PG_DATABASE
  }
}

/** ConnectParams as the app would build them for this server. */
export function connectParams(readOnlyRole = false): ConnectParams {
  return {
    type: 'postgres',
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DATABASE,
    user: readOnlyRole ? PG_RO_USER : PG_USER,
    password: readOnlyRole ? PG_RO_PASSWORD : PG_PASSWORD,
    httpPath: '',
    url: '',
    useUrl: false
  }
}
