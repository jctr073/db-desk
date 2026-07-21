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
const COLGRANT = 'dbdesk_priv_colgrant'
const SEQGRANT = 'dbdesk_priv_seqgrant'
// SELECT-only role for the legacy public-schema carve-out: CREATE on schema
// "public" reachable only through the PUBLIC pseudo-role (the pre-15 default
// ACL that pg_upgrade carries forward) must not clamp it.
const PUBCREATE = 'dbdesk_priv_pubcreate'
// Same grant, but held directly — the carve-out must not excuse it.
const DIRECTCREATE = 'dbdesk_priv_directcreate'
// A three-link membership chain (leaf -> mid -> writer), NOINHERIT throughout
// so the writable grant is two SET ROLEs away and only the recursive closure
// can reach it.
const CHAIN_LEAF = 'dbdesk_priv_chain_leaf'
const CHAIN_MID = 'dbdesk_priv_chain_mid'

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

const ALL_ROLES = [WRITER, NOINHERIT, COLGRANT, SEQGRANT, CHAIN_LEAF, CHAIN_MID, PUBCREATE, DIRECTCREATE]

beforeAll(async () => {
  const admin = await startAdmin()
  const ensureRole = (name: string, extra = '') =>
    `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
       CREATE ROLE ${name} LOGIN ${extra} PASSWORD '${name}';
     END IF;`
  await admin.query(`
    DO $$
    BEGIN
      ${ensureRole(WRITER)}
      ${ensureRole(NOINHERIT, 'NOINHERIT')}
      ${ensureRole(COLGRANT)}
      ${ensureRole(SEQGRANT)}
      ${ensureRole(CHAIN_LEAF, 'NOINHERIT')}
      ${ensureRole(CHAIN_MID, 'NOINHERIT')}
      ${ensureRole(PUBCREATE)}
      ${ensureRole(DIRECTCREATE)}
    END
    $$;
    GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${ALL_ROLES.join(', ')};
    GRANT USAGE ON SCHEMA public TO ${ALL_ROLES.join(', ')};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ALL_ROLES.join(', ')};
    GRANT INSERT ON customers TO ${WRITER};
    GRANT ${WRITER} TO ${NOINHERIT};

    -- Column-only UPDATE: invisible to has_table_privilege, seen only by
    -- has_any_column_privilege.
    GRANT UPDATE (status) ON orders TO ${COLGRANT};

    -- Sequence USAGE/UPDATE: lets the role advance a sequence (nextval/setval),
    -- a persistent-state write the table sweep never inspects.
    GRANT USAGE ON SEQUENCE customers_id_seq TO ${SEQGRANT};

    -- Two-hop writable chain: only the recursive closure reaches ${WRITER}.
    GRANT ${WRITER} TO ${CHAIN_MID};
    GRANT ${CHAIN_MID} TO ${CHAIN_LEAF};

    -- Direct CREATE on public: a real grant the carve-out must not excuse.
    GRANT CREATE ON SCHEMA public TO ${DIRECTCREATE};
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
    // Holds on PG 15+ (no PUBLIC CREATE on "public") and, via the probe's
    // legacy carve-out, also on databases that carried that ACL through
    // pg_upgrade — see the PUBLIC pseudo-role test below.
    expect(await probeAs('dbdesk_ro', 'dbdesk_ro')).toBe('readonly')
  })

  it('calls a role with one INSERT grant writable', async () => {
    expect(await probeAs(WRITER, WRITER)).toBe('writable')
  })

  it('calls a NOINHERIT member of a writer role writable (SET ROLE escalation)', async () => {
    expect(await probeAs(NOINHERIT, NOINHERIT)).toBe('writable')
  })

  it('calls a role with only a column-level UPDATE grant writable', async () => {
    // has_table_privilege(...,'UPDATE') is false here; only
    // has_any_column_privilege sees the grant.
    expect(await probeAs(COLGRANT, COLGRANT)).toBe('writable')
  })

  it('calls a role with only a sequence USAGE grant writable', async () => {
    // Advancing a sequence (nextval/setval) mutates persistent state and is
    // outside the relkind r/p/v/f table sweep.
    expect(await probeAs(SEQGRANT, SEQGRANT)).toBe('writable')
  })

  it('calls a two-hop NOINHERIT chain to a writer role writable', async () => {
    // Guards the recursive closure: a single flat pg_auth_members join would
    // reach CHAIN_MID but not the writable WRITER one hop further.
    expect(await probeAs(CHAIN_LEAF, CHAIN_LEAF)).toBe('writable')
  })

  it('ignores CREATE on public held only via the PUBLIC pseudo-role (legacy pre-15 ACL)', async () => {
    // Recreates what pg_upgrade carries forward from a <= 14 cluster. The
    // grant is scoped to this test: granted, probed, revoked.
    const admin = await startAdmin()
    await admin.query('GRANT CREATE ON SCHEMA public TO PUBLIC')
    try {
      expect(await probeAs(PUBCREATE, PUBCREATE)).toBe('readonly')
    } finally {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    }
  })

  it('still calls a direct CREATE grant on public writable', async () => {
    expect(await probeAs(DIRECTCREATE, DIRECTCREATE)).toBe('writable')
  })

  it('still calls a PUBLIC CREATE grant on a non-public schema writable', async () => {
    // The carve-out is pinned to the schema literally named "public" — a
    // PUBLIC grant anywhere else is a deliberate DBA action, not the legacy
    // default, and must clamp.
    const admin = await startAdmin()
    await admin.query('CREATE SCHEMA IF NOT EXISTS dbdesk_priv_extra')
    await admin.query('GRANT CREATE ON SCHEMA dbdesk_priv_extra TO PUBLIC')
    try {
      expect(await probeAs(PUBCREATE, PUBCREATE)).toBe('writable')
    } finally {
      await admin.query('DROP SCHEMA dbdesk_priv_extra')
    }
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
