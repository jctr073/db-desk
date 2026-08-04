/**
 * The connect-time write-capability probe against real Postgres 17: the
 * verdicts that decide whether a prod connection's agent gets Read-Only
 * mode. Roles and schemas are created here (idempotently, via the admin
 * client) rather than in the seed so the suite also passes against a
 * container whose volume predates them.
 *
 * v2 rescoped the probe to clamp only on write access to PROTECTED schemas
 * (>= 3 tables; relkind r/p, partition children excluded, views/matviews/
 * foreign tables/sequences never count toward the threshold). The seeded
 * `public` schema has exactly 3 tables (customers, orders, order_items), so
 * it is itself protected -- the v1 tests that grant into `public` now prove
 * the scoped sweeps still catch column/sequence/view grants *inside* a
 * protected schema, rather than proving "writes anywhere clamp".
 *
 * Fixtures fall into two families:
 *  - The original `dbdesk_priv_*` roles (kept from v1, updated to the new
 *    `{ verdict, writableSchemas }` return shape) exercising the closure/
 *    NOINHERIT/column-grant/sequence-grant/public-carve-out machinery
 *    against the seeded `public` schema.
 *  - New `privx_*` schemas and roles purpose-built for the v2 shape rules:
 *    service-DB (protected + trivial + empty schemas), monorepo (several
 *    protected schemas, clamp names only the offending ones), threshold
 *    edges (2 tables, 5 views, a 5-way-partitioned table), and role
 *    attributes (superuser/BYPASSRLS still clamp; CREATEDB and
 *    database-level CREATE no longer do).
 *
 * The interesting case is dbdesk_priv_noinherit: it holds no grants of its
 * own and NOINHERIT membership in a writer role, so nothing it can do
 * directly writes -- but one SET ROLE away it can. The closure must call
 * that writable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../../src/main/drivers/postgres'
import { checkPgWriteCapability } from '../../../src/main/pgPrivileges'
import type { PgWriteCapabilityResult } from '../../../src/main/pgPrivileges'
import { connectParams, PG_DATABASE } from '../support/config'
import { startAdmin, stopAdmin } from '../support/db'

// -- v1 fixtures: exercised against the now-protected seeded `public` schema --

const WRITER = 'dbdesk_priv_writer'
const NOINHERIT = 'dbdesk_priv_noinherit'
const COLGRANT = 'dbdesk_priv_colgrant'
const SEQGRANT = 'dbdesk_priv_seqgrant'
// SELECT-only role for the legacy public-schema carve-out: CREATE on schema
// "public" reachable only through the PUBLIC pseudo-role (the pre-15 default
// ACL that pg_upgrade carries forward) must not clamp it.
const PUBCREATE = 'dbdesk_priv_pubcreate'
// Same grant, but held directly -- the carve-out must not excuse it.
const DIRECTCREATE = 'dbdesk_priv_directcreate'
// A three-link membership chain (leaf -> mid -> writer), NOINHERIT throughout
// so the writable grant is two SET ROLEs away and only the recursive closure
// can reach it.
const CHAIN_LEAF = 'dbdesk_priv_chain_leaf'
const CHAIN_MID = 'dbdesk_priv_chain_mid'

const V1_ROLES = [
  WRITER,
  NOINHERIT,
  COLGRANT,
  SEQGRANT,
  CHAIN_LEAF,
  CHAIN_MID,
  PUBCREATE,
  DIRECTCREATE
]

// -- v2 fixtures: purpose-built schemas/roles for the shape rules --

const SCHEMA_BILLING = 'privx_billing'
const SCHEMA_TRIVIAL = 'privx_trivial'
const SCHEMA_EMPTY = 'privx_empty'
const SCHEMA_SVC_A = 'privx_svc_a'
const SCHEMA_SVC_B = 'privx_svc_b'
const SCHEMA_SVC_C = 'privx_svc_c'
const SCHEMA_TWO = 'privx_two'
const SCHEMA_VIEWS = 'privx_views'
const SCHEMA_PART = 'privx_part'

const ALL_PRIVX_SCHEMAS = [
  SCHEMA_BILLING,
  SCHEMA_TRIVIAL,
  SCHEMA_EMPTY,
  SCHEMA_SVC_A,
  SCHEMA_SVC_B,
  SCHEMA_SVC_C,
  SCHEMA_TWO,
  SCHEMA_VIEWS,
  SCHEMA_PART
]

// Service-DB shape: one hot schema, one trivial schema, one empty schema.
const ROLE_TRIVIAL_AND_EMPTY_CREATE = 'privx_role_trivial_empty'
const ROLE_BILLING_UPDATE = 'privx_role_billing_update'
const ROLE_BILLING_VIEW = 'privx_role_billing_view'
const ROLE_EMPTY_SEQ = 'privx_role_empty_seq'
const ROLE_BILLING_SEQ = 'privx_role_billing_seq'
const ROLE_BILLING_CREATE = 'privx_role_billing_create'

// Monorepo shape: writes land in two of three protected sibling schemas.
const ROLE_MONOREPO = 'privx_role_monorepo'

// Threshold edges.
const ROLE_TWO = 'privx_role_two'
const ROLE_VIEWS = 'privx_role_views'
const ROLE_PART = 'privx_role_part'

// Role attributes.
const ROLE_SUPER = 'privx_role_super'
const ROLE_BYPASSRLS = 'privx_role_bypassrls'
const ROLE_CREATEDB = 'privx_role_createdb'
const ROLE_DBCREATE = 'privx_role_dbcreate'

const ALL_PRIVX_ROLES = [
  ROLE_TRIVIAL_AND_EMPTY_CREATE,
  ROLE_BILLING_UPDATE,
  ROLE_BILLING_VIEW,
  ROLE_EMPTY_SEQ,
  ROLE_BILLING_SEQ,
  ROLE_BILLING_CREATE,
  ROLE_MONOREPO,
  ROLE_TWO,
  ROLE_VIEWS,
  ROLE_PART,
  ROLE_SUPER,
  ROLE_BYPASSRLS,
  ROLE_CREATEDB,
  ROLE_DBCREATE
]

let connSeq = 0
const openConns: string[] = []

async function probeAs(user: string, password: string): Promise<PgWriteCapabilityResult> {
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

/** Idempotent role creation: `CREATE ROLE ... LOGIN [extra] PASSWORD '<name>'`. */
function ensureRole(name: string, extra = ''): string {
  return `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
       CREATE ROLE ${name} LOGIN ${extra} PASSWORD '${name}';
     END IF;`
}

beforeAll(async () => {
  const admin = await startAdmin()

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
    GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${V1_ROLES.join(', ')};
    GRANT USAGE ON SCHEMA public TO ${V1_ROLES.join(', ')};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${V1_ROLES.join(', ')};
    GRANT INSERT ON customers TO ${WRITER};
    GRANT ${WRITER} TO ${NOINHERIT};

    -- Column-only UPDATE: invisible to has_table_privilege, seen only by
    -- has_any_column_privilege. Re-proves the catch inside a protected
    -- schema now that "public" itself qualifies (3 tables).
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

  // -- v2 shape fixtures --

  await admin.query(`
    -- Service-DB shape: privx_billing is the hot schema (3 tables + a
    -- sequence + an auto-updatable view over one table), privx_trivial and
    -- privx_empty are below the protection threshold.
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_BILLING};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_BILLING}.invoices (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_BILLING}.payments (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_BILLING}.accounts (id int PRIMARY KEY);
    CREATE SEQUENCE IF NOT EXISTS ${SCHEMA_BILLING}.billing_seq;
    CREATE OR REPLACE VIEW ${SCHEMA_BILLING}.invoices_view AS
      SELECT * FROM ${SCHEMA_BILLING}.invoices;

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_TRIVIAL};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TRIVIAL}.notes (id int PRIMARY KEY);

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_EMPTY};
    CREATE SEQUENCE IF NOT EXISTS ${SCHEMA_EMPTY}.empty_seq;

    -- Monorepo shape: three sibling schemas, each independently protected.
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_SVC_A};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_A}.t1 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_A}.t2 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_A}.t3 (id int PRIMARY KEY);

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_SVC_B};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_B}.t1 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_B}.t2 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_B}.t3 (id int PRIMARY KEY);

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_SVC_C};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_C}.t1 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_C}.t2 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_SVC_C}.t3 (id int PRIMARY KEY);

    -- Threshold edges.
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_TWO};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TWO}.t1 (id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TWO}.t2 (id int PRIMARY KEY);

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_VIEWS};
    CREATE OR REPLACE VIEW ${SCHEMA_VIEWS}.v1 AS SELECT 1 AS id;
    CREATE OR REPLACE VIEW ${SCHEMA_VIEWS}.v2 AS SELECT 1 AS id;
    CREATE OR REPLACE VIEW ${SCHEMA_VIEWS}.v3 AS SELECT 1 AS id;
    CREATE OR REPLACE VIEW ${SCHEMA_VIEWS}.v4 AS SELECT 1 AS id;
    CREATE OR REPLACE VIEW ${SCHEMA_VIEWS}.v5 AS SELECT 1 AS id;

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA_PART};
    CREATE TABLE IF NOT EXISTS ${SCHEMA_PART}.events (
      id int NOT NULL,
      created_at date NOT NULL
    ) PARTITION BY RANGE (created_at);
    CREATE TABLE IF NOT EXISTS ${SCHEMA_PART}.events_p1
      PARTITION OF ${SCHEMA_PART}.events FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
    CREATE TABLE IF NOT EXISTS ${SCHEMA_PART}.events_p2
      PARTITION OF ${SCHEMA_PART}.events FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
    CREATE TABLE IF NOT EXISTS ${SCHEMA_PART}.events_p3
      PARTITION OF ${SCHEMA_PART}.events FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
    CREATE TABLE IF NOT EXISTS ${SCHEMA_PART}.events_p4
      PARTITION OF ${SCHEMA_PART}.events FOR VALUES FROM ('2024-04-01') TO ('2024-05-01');
    CREATE TABLE IF NOT EXISTS ${SCHEMA_PART}.events_p5
      PARTITION OF ${SCHEMA_PART}.events FOR VALUES FROM ('2024-05-01') TO ('2024-06-01');
  `)

  await admin.query(`
    DO $$
    BEGIN
      ${ensureRole(ROLE_TRIVIAL_AND_EMPTY_CREATE)}
      ${ensureRole(ROLE_BILLING_UPDATE)}
      ${ensureRole(ROLE_BILLING_VIEW)}
      ${ensureRole(ROLE_EMPTY_SEQ)}
      ${ensureRole(ROLE_BILLING_SEQ)}
      ${ensureRole(ROLE_BILLING_CREATE)}
      ${ensureRole(ROLE_MONOREPO)}
      ${ensureRole(ROLE_TWO)}
      ${ensureRole(ROLE_VIEWS)}
      ${ensureRole(ROLE_PART)}
      ${ensureRole(ROLE_SUPER, 'SUPERUSER')}
      ${ensureRole(ROLE_BYPASSRLS, 'BYPASSRLS')}
      ${ensureRole(ROLE_CREATEDB, 'CREATEDB')}
      ${ensureRole(ROLE_DBCREATE)}
    END
    $$;
    GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ${ALL_PRIVX_ROLES.join(', ')};

    -- Trivial INSERT + CREATE on an empty schema: neither is protected, so
    -- the headline v2 loosening applies (readonly).
    GRANT USAGE ON SCHEMA ${SCHEMA_TRIVIAL} TO ${ROLE_TRIVIAL_AND_EMPTY_CREATE};
    GRANT INSERT ON ${SCHEMA_TRIVIAL}.notes TO ${ROLE_TRIVIAL_AND_EMPTY_CREATE};
    GRANT USAGE ON SCHEMA ${SCHEMA_EMPTY} TO ${ROLE_TRIVIAL_AND_EMPTY_CREATE};
    GRANT CREATE ON SCHEMA ${SCHEMA_EMPTY} TO ${ROLE_TRIVIAL_AND_EMPTY_CREATE};

    -- Writes into the hot service schema, each isolated to its own role.
    GRANT USAGE ON SCHEMA ${SCHEMA_BILLING}
      TO ${ROLE_BILLING_UPDATE}, ${ROLE_BILLING_VIEW}, ${ROLE_BILLING_SEQ}, ${ROLE_BILLING_CREATE};
    GRANT UPDATE ON ${SCHEMA_BILLING}.invoices TO ${ROLE_BILLING_UPDATE};
    GRANT INSERT ON ${SCHEMA_BILLING}.invoices_view TO ${ROLE_BILLING_VIEW};
    GRANT USAGE ON SEQUENCE ${SCHEMA_BILLING}.billing_seq TO ${ROLE_BILLING_SEQ};
    GRANT CREATE ON SCHEMA ${SCHEMA_BILLING} TO ${ROLE_BILLING_CREATE};

    -- Sequence USAGE in the empty (trivial) schema stays readonly.
    GRANT USAGE ON SCHEMA ${SCHEMA_EMPTY} TO ${ROLE_EMPTY_SEQ};
    GRANT USAGE ON SEQUENCE ${SCHEMA_EMPTY}.empty_seq TO ${ROLE_EMPTY_SEQ};

    -- Monorepo: writes in two of three protected sibling schemas.
    GRANT USAGE ON SCHEMA ${SCHEMA_SVC_A} TO ${ROLE_MONOREPO};
    GRANT INSERT ON ${SCHEMA_SVC_A}.t1 TO ${ROLE_MONOREPO};
    GRANT USAGE ON SCHEMA ${SCHEMA_SVC_C} TO ${ROLE_MONOREPO};
    GRANT UPDATE ON ${SCHEMA_SVC_C}.t1 TO ${ROLE_MONOREPO};

    -- Threshold edges.
    GRANT USAGE ON SCHEMA ${SCHEMA_TWO} TO ${ROLE_TWO};
    GRANT INSERT ON ${SCHEMA_TWO}.t1 TO ${ROLE_TWO};

    GRANT USAGE ON SCHEMA ${SCHEMA_VIEWS} TO ${ROLE_VIEWS};
    GRANT INSERT ON ${SCHEMA_VIEWS}.v1 TO ${ROLE_VIEWS};

    GRANT USAGE ON SCHEMA ${SCHEMA_PART} TO ${ROLE_PART};
    GRANT INSERT ON ${SCHEMA_PART}.events_p1 TO ${ROLE_PART};

    -- Database-level CREATE no longer clamps in v2.
    GRANT CREATE ON DATABASE ${PG_DATABASE} TO ${ROLE_DBCREATE};
  `)
})

afterAll(async () => {
  for (const connId of openConns) await postgresDriver.disconnect(connId)
  await postgresDriver.disconnectAll()
  const admin = await startAdmin()
  await admin.query(`DROP SCHEMA IF EXISTS ${ALL_PRIVX_SCHEMAS.join(', ')} CASCADE`)
  await stopAdmin()
})

describe('pg write-capability probe (real server)', () => {
  describe('v1 baseline (against the now-protected seeded "public" schema)', () => {
    it('calls the schema owner writable (the worst case the agent faces)', async () => {
      // dbdesk is the container superuser -- a role-attribute hit, so no
      // schema is named individually.
      const result = await probeAs('dbdesk', 'dbdesk')
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([])
    })

    it('calls the SELECT-only role readonly', async () => {
      // Holds on PG 15+ (no PUBLIC CREATE on "public") and, via the probe's
      // legacy carve-out, also on databases that carried that ACL through
      // pg_upgrade -- see the PUBLIC pseudo-role test below.
      expect((await probeAs('dbdesk_ro', 'dbdesk_ro')).verdict).toBe('readonly')
    })

    it('calls a role with one INSERT grant writable, naming "public"', async () => {
      const result = await probeAs(WRITER, WRITER)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual(['public'])
    })

    it('calls a NOINHERIT member of a writer role writable (SET ROLE escalation)', async () => {
      expect((await probeAs(NOINHERIT, NOINHERIT)).verdict).toBe('writable')
    })

    it('calls a role with only a column-level UPDATE grant writable', async () => {
      // has_table_privilege(...,'UPDATE') is false here; only
      // has_any_column_privilege sees the grant. Re-proves the catch inside
      // a protected schema now that "public" itself qualifies.
      const result = await probeAs(COLGRANT, COLGRANT)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual(['public'])
    })

    it('calls a role with only a sequence USAGE grant writable', async () => {
      // Advancing a sequence (nextval/setval) mutates persistent state and is
      // outside the relkind r/p/v/f table sweep.
      const result = await probeAs(SEQGRANT, SEQGRANT)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual(['public'])
    })

    it('calls a two-hop NOINHERIT chain to a writer role writable', async () => {
      // Guards the recursive closure: a single flat pg_auth_members join would
      // reach CHAIN_MID but not the writable WRITER one hop further.
      expect((await probeAs(CHAIN_LEAF, CHAIN_LEAF)).verdict).toBe('writable')
    })

    it('ignores CREATE on public held only via the PUBLIC pseudo-role (legacy pre-15 ACL)', async () => {
      // Recreates what pg_upgrade carries forward from a <= 14 cluster. The
      // grant is scoped to this test: granted, probed, revoked. Reachable now
      // because "public" is itself protected (3 seeded tables).
      const admin = await startAdmin()
      await admin.query('GRANT CREATE ON SCHEMA public TO PUBLIC')
      try {
        expect((await probeAs(PUBCREATE, PUBCREATE)).verdict).toBe('readonly')
      } finally {
        await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
      }
    })

    it('still calls a direct CREATE grant on public writable, naming "public"', async () => {
      const result = await probeAs(DIRECTCREATE, DIRECTCREATE)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual(['public'])
    })

    it('still calls a PUBLIC CREATE grant on a protected non-public schema writable', async () => {
      // The carve-out is pinned to the schema literally named "public" -- a
      // PUBLIC grant anywhere else is a deliberate DBA action, not the legacy
      // default, and must clamp. This extra schema is given 3 tables so it is
      // PROTECTED -- under v2 a PUBLIC CREATE grant on a trivial schema would
      // not clamp at all (see the sibling test below).
      const admin = await startAdmin()
      await admin.query(`
        CREATE SCHEMA IF NOT EXISTS dbdesk_priv_extra;
        CREATE TABLE IF NOT EXISTS dbdesk_priv_extra.t1 (id int PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS dbdesk_priv_extra.t2 (id int PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS dbdesk_priv_extra.t3 (id int PRIMARY KEY);
        GRANT CREATE ON SCHEMA dbdesk_priv_extra TO PUBLIC;
      `)
      try {
        expect((await probeAs(PUBCREATE, PUBCREATE)).verdict).toBe('writable')
      } finally {
        await admin.query('DROP SCHEMA dbdesk_priv_extra CASCADE')
      }
    })

    it('leaves a PUBLIC CREATE grant on a trivial non-public schema readonly (v2 loosening)', async () => {
      // Same grant shape as above, but the schema never crosses the 3-table
      // threshold -- CREATE there, PUBLIC or not, no longer clamps.
      const admin = await startAdmin()
      await admin.query('CREATE SCHEMA IF NOT EXISTS dbdesk_priv_extra_trivial')
      await admin.query('GRANT CREATE ON SCHEMA dbdesk_priv_extra_trivial TO PUBLIC')
      try {
        expect((await probeAs(PUBCREATE, PUBCREATE)).verdict).toBe('readonly')
      } finally {
        await admin.query('DROP SCHEMA dbdesk_priv_extra_trivial CASCADE')
      }
    })
  })

  describe('service-DB shape (privx_billing hot, privx_trivial/privx_empty below threshold)', () => {
    it('calls INSERT-on-trivial + CREATE-on-empty readonly (the headline v2 loosening)', async () => {
      expect(
        (await probeAs(ROLE_TRIVIAL_AND_EMPTY_CREATE, ROLE_TRIVIAL_AND_EMPTY_CREATE)).verdict
      ).toBe('readonly')
    })

    it('calls a table-level UPDATE in the hot schema writable, naming it', async () => {
      const result = await probeAs(ROLE_BILLING_UPDATE, ROLE_BILLING_UPDATE)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([SCHEMA_BILLING])
    })

    it("calls an INSERT on the hot schema's view writable", async () => {
      // Views don't count toward the 3-table threshold, but they are real
      // write paths in a schema that already qualified without them.
      const result = await probeAs(ROLE_BILLING_VIEW, ROLE_BILLING_VIEW)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([SCHEMA_BILLING])
    })

    it('calls sequence USAGE in the empty (trivial) schema readonly', async () => {
      expect((await probeAs(ROLE_EMPTY_SEQ, ROLE_EMPTY_SEQ)).verdict).toBe('readonly')
    })

    it('calls sequence USAGE in the hot schema writable', async () => {
      const result = await probeAs(ROLE_BILLING_SEQ, ROLE_BILLING_SEQ)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([SCHEMA_BILLING])
    })

    it('calls CREATE on the hot schema writable', async () => {
      const result = await probeAs(ROLE_BILLING_CREATE, ROLE_BILLING_CREATE)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([SCHEMA_BILLING])
    })
  })

  describe('monorepo shape (three independently protected sibling schemas)', () => {
    it('names exactly the schemas actually written, sorted, svc_b absent', async () => {
      const result = await probeAs(ROLE_MONOREPO, ROLE_MONOREPO)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([SCHEMA_SVC_A, SCHEMA_SVC_C])
    })
  })

  describe('threshold edges', () => {
    it('calls a write into a 2-table schema readonly (below threshold)', async () => {
      expect((await probeAs(ROLE_TWO, ROLE_TWO)).verdict).toBe('readonly')
    })

    it('calls a grant on a view-only schema readonly (0 tables, views never count)', async () => {
      expect((await probeAs(ROLE_VIEWS, ROLE_VIEWS)).verdict).toBe('readonly')
    })

    it('calls a write into a partition child readonly (parent counts once, unprotected)', async () => {
      expect((await probeAs(ROLE_PART, ROLE_PART)).verdict).toBe('readonly')
    })
  })

  describe('role attributes', () => {
    it('calls a superuser role writable with no named schemas', async () => {
      const result = await probeAs(ROLE_SUPER, ROLE_SUPER)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([])
    })

    it('calls a BYPASSRLS role writable with no named schemas', async () => {
      const result = await probeAs(ROLE_BYPASSRLS, ROLE_BYPASSRLS)
      expect(result.verdict).toBe('writable')
      expect(result.writableSchemas).toEqual([])
    })

    it('calls a CREATEDB-only role readonly (no longer clamps in v2)', async () => {
      expect((await probeAs(ROLE_CREATEDB, ROLE_CREATEDB)).verdict).toBe('readonly')
    })

    it('calls a role with database-level CREATE readonly (no longer clamps in v2)', async () => {
      expect((await probeAs(ROLE_DBCREATE, ROLE_DBCREATE)).verdict).toBe('readonly')
    })
  })

  describe('fail-closed and non-write behavior', () => {
    it('is indeterminate when the connection is gone (fail closed)', async () => {
      const result = await checkPgWriteCapability((sql) =>
        postgresDriver.runQuery('no-such-conn', PG_DATABASE, sql, null, {
          readOnly: true,
          timeoutMs: 5000
        })
      )
      expect(result.verdict).toBe('indeterminate')
      expect(result.writableSchemas).toEqual([])
    })

    it('runs read-only: the probe itself cannot write', async () => {
      const admin = await startAdmin()
      const before = await admin.query('SELECT count(*)::int AS n FROM customers')
      await probeAs('dbdesk', 'dbdesk')
      const after = await admin.query('SELECT count(*)::int AS n FROM customers')
      expect(after.rows[0].n).toBe(before.rows[0].n)
    })
  })
})
