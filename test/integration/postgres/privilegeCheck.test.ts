/**
 * The connect-time write-capability probe against real Postgres 17: the
 * verdicts that decide whether a prod connection's agent gets Read-Only
 * mode. Roles are created here (idempotently, via the admin client) rather
 * than in the seed so the suite also passes against a container whose
 * volume predates them.
 *
 * The interesting case is dbdesk_priv_noinherit: it holds no grants of its
 * own and NOINHERIT membership in a writer role, so nothing it can do
 * directly writes — but one SET ROLE away it can. The closure must call
 * that writable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../../src/main/drivers/postgres'
import { checkPgWriteCapability } from '../../../src/main/pgPrivileges'
import type { PgWriteCapability } from '../../../src/main/pgPrivileges'
import { connectParams, PG_DATABASE } from '../support/config'
import { startAdmin, stopAdmin } from '../support/db'

const WRITER = 'dbdesk_priv_writer'
const NOINHERIT = 'dbdesk_priv_noinherit'

let connSeq = 0
const openConns: string[] = []

async function probeAs(user: string, password: string): Promise<PgWriteCapability> {
  const connId = `priv-conn-${++connSeq}-${process.pid}`
  const res = await postgresDriver.connect(connId, { ...connectParams(), user, password })
  if (!res.ok) throw new Error(`driver connect failed for ${user}: ${res.error}`)
  openConns.push(connId)
  // Exactly how the facade wires the probe: the driver runner, read-only
  // session belt on, bounded by a statement timeout.
  return checkPgWriteCapability((sql) =>
    postgresDriver.runQuery(connId, PG_DATABASE, sql, null, { readOnly: true, timeoutMs: 5000 })
  )
}

beforeAll(async () => {
  const admin = await startAdmin()
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WRITER}') THEN
        CREATE ROLE ${WRITER} LOGIN PASSWORD '${WRITER}';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${NOINHERIT}') THEN
        CREATE ROLE ${NOINHERIT} LOGIN NOINHERIT PASSWORD '${NOINHERIT}';
      END IF;
    END
    $$;
    GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${WRITER}, ${NOINHERIT};
    GRANT USAGE ON SCHEMA public TO ${WRITER}, ${NOINHERIT};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${WRITER}, ${NOINHERIT};
    GRANT INSERT ON customers TO ${WRITER};
    GRANT ${WRITER} TO ${NOINHERIT};
  `)
})

afterAll(async () => {
  for (const connId of openConns) await postgresDriver.disconnect(connId)
  await postgresDriver.disconnectAll()
  await stopAdmin()
})

describe('pg write-capability probe (real server)', () => {
  it('calls the schema owner writable (the worst case the agent faces)', async () => {
    expect(await probeAs('dbdesk', 'dbdesk')).toBe('writable')
  })

  it('calls the SELECT-only role readonly', async () => {
    // Relies on PG 15+ having revoked PUBLIC CREATE on schema "public";
    // on older servers this correctly degrades to writable (fail closed).
    expect(await probeAs('dbdesk_ro', 'dbdesk_ro')).toBe('readonly')
  })

  it('calls a role with one INSERT grant writable', async () => {
    expect(await probeAs(WRITER, WRITER)).toBe('writable')
  })

  it('calls a NOINHERIT member of a writer role writable (SET ROLE escalation)', async () => {
    expect(await probeAs(NOINHERIT, NOINHERIT)).toBe('writable')
  })

  it('is indeterminate when the connection is gone (fail closed)', async () => {
    const verdict = await checkPgWriteCapability((sql) =>
      postgresDriver.runQuery('no-such-conn', PG_DATABASE, sql, null, {
        readOnly: true,
        timeoutMs: 5000
      })
    )
    expect(verdict).toBe('indeterminate')
  })

  it('runs read-only: the probe itself cannot write', async () => {
    const admin = await startAdmin()
    const before = await admin.query('SELECT count(*)::int AS n FROM customers')
    await probeAs('dbdesk', 'dbdesk')
    const after = await admin.query('SELECT count(*)::int AS n FROM customers')
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
