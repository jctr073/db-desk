/**
 * Connect-time answer to one question: can the role this connection
 * authenticated as write ANYTHING in the pinned database?
 *
 * On prod connections the agent's Read-Only mode is only offered when the
 * answer is provably "no" — then the server's own privilege checks (42501),
 * not this app's belts, are what stand between the agent and a mutation.
 * Anything short of a provable "no" (a write grant, a role attribute that
 * implies one, or a failed/unparseable check) clamps the agent, so every
 * error path here must land on 'writable' or 'indeterminate', never
 * 'readonly'.
 *
 * Known residual the check cannot see: EXECUTE on a SECURITY DEFINER
 * function that writes runs with the function owner's privileges, not the
 * caller's. Grants inspection has no way to prove its absence.
 */

import type { DbResult, QueryResult } from '../shared/db'

export type PgWriteCapability = 'readonly' | 'writable' | 'indeterminate'

/**
 * One statement, one row of booleans. `role_closure` is every role reachable
 * from current_user through pg_auth_members — deliberately ignoring INHERIT,
 * because a member of a NOINHERIT role can still SET ROLE into it and use its
 * grants. Each probe then asks "does ANY role in the closure hold this?".
 *
 * Probe notes:
 *  - rolsuper bypasses the grant system entirely; rolbypassrls and rolcreatedb
 *    are not provably harmless, so all three count as writable.
 *  - Table DML covers relkinds r/p/v/f (plain, partitioned, views — writable
 *    when auto-updatable — and foreign tables). Materialized views are
 *    excluded: writing one takes ownership, and owners already hold DML on
 *    it anyway. pg_catalog writes are superuser-only, covered by rolsuper.
 *    has_table_privilege only sees table-level (relacl) grants, so the same
 *    sweep also calls has_any_column_privilege for INSERT/UPDATE — a
 *    column-only grant (GRANT UPDATE (col) ON t) is a real write the
 *    table-level check is blind to. (DELETE/TRUNCATE have no column form.)
 *  - Sequences (relkind 'S') are a distinct probe: USAGE or UPDATE lets a
 *    role advance one via nextval/setval, which mutates persistent state
 *    (nextval even survives rollback), so either grant counts as writable.
 *  - Schema CREATE skips pg_temp and pg_toast namespaces: every role may create
 *    session-local temp objects, and counting that would classify everyone
 *    as writable. On PG <= 14 PUBLIC holds CREATE on schema "public", so
 *    most roles classify writable there — correct fail-closed behavior for
 *    a prod database, not a bug.
 *  - EXISTS probes short-circuit on the first hit, so genuinely writable
 *    roles answer instantly; only a truly read-only role pays for the full
 *    sweep (syscache lookups, bounded by the caller's statement timeout).
 */
export const PG_WRITE_CAPABILITY_SQL = `
WITH RECURSIVE role_closure AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
  UNION
  SELECT m.roleid
  FROM pg_catalog.pg_auth_members m
  JOIN role_closure rc ON m.member = rc.oid
)
SELECT
  bool_or(r.rolsuper)     AS any_super,
  bool_or(r.rolbypassrls) AS any_bypassrls,
  bool_or(r.rolcreatedb)  AS any_createdb,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN role_closure rc2
    WHERE c.relkind IN ('r', 'p', 'v', 'f')
      AND n.nspname NOT LIKE 'pg\\_%'
      AND n.nspname <> 'information_schema'
      AND (has_table_privilege(rc2.oid, c.oid, 'INSERT')
        OR has_table_privilege(rc2.oid, c.oid, 'UPDATE')
        OR has_table_privilege(rc2.oid, c.oid, 'DELETE')
        OR has_table_privilege(rc2.oid, c.oid, 'TRUNCATE')
        OR has_any_column_privilege(rc2.oid, c.oid, 'INSERT')
        OR has_any_column_privilege(rc2.oid, c.oid, 'UPDATE'))
  ) AS any_table_write,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class s
    JOIN pg_catalog.pg_namespace ns ON ns.oid = s.relnamespace
    CROSS JOIN role_closure rcs
    WHERE s.relkind = 'S'
      AND ns.nspname NOT LIKE 'pg\\_%'
      AND ns.nspname <> 'information_schema'
      AND (has_sequence_privilege(rcs.oid, s.oid, 'USAGE')
        OR has_sequence_privilege(rcs.oid, s.oid, 'UPDATE'))
  ) AS any_sequence_write,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace n2
    CROSS JOIN role_closure rc3
    WHERE n2.nspname NOT LIKE 'pg\\_temp%'
      AND n2.nspname NOT LIKE 'pg\\_toast%'
      AND has_schema_privilege(rc3.oid, n2.oid, 'CREATE')
  ) AS any_schema_create,
  EXISTS (
    SELECT 1 FROM role_closure rc4
    WHERE has_database_privilege(rc4.oid, current_database(), 'CREATE')
  ) AS any_db_create
FROM role_closure rc
JOIN pg_catalog.pg_roles r ON r.oid = rc.oid
`.trim()

/** The probe columns, in SELECT order. Every one true means "can write". */
const PROBE_COLUMNS = [
  'any_super',
  'any_bypassrls',
  'any_createdb',
  'any_table_write',
  'any_sequence_write',
  'any_schema_create',
  'any_db_create'
] as const

/**
 * Fold the probe row into a verdict. Pure so the truth table is unit-testable
 * without a driver. Anything that is not a well-formed row of booleans is
 * 'indeterminate' — a malformed result must clamp, not pass.
 */
export function classifyPrivilegeRow(result: QueryResult): PgWriteCapability {
  if (result.rows.length !== 1) return 'indeterminate'
  const row = result.rows[0]
  const byName = new Map(result.fields.map((f, i) => [f.name, row[i]]))
  let writable = false
  for (const column of PROBE_COLUMNS) {
    const value = byName.get(column)
    // bool_or over an empty set would be NULL; treat like any malformed value.
    if (typeof value !== 'boolean') return 'indeterminate'
    writable = writable || value
  }
  return writable ? 'writable' : 'readonly'
}

/**
 * Run the probe through an injected runner (the facade wires the connected
 * driver in) so this module stays free of driver imports and testable
 * against fakes. The runner is expected to already carry the read-only
 * session flag and a statement timeout.
 */
export async function checkPgWriteCapability(
  run: (sql: string) => Promise<DbResult<QueryResult>>
): Promise<PgWriteCapability> {
  try {
    const res = await run(PG_WRITE_CAPABILITY_SQL)
    if (!res.ok) return 'indeterminate'
    return classifyPrivilegeRow(res.data)
  } catch {
    return 'indeterminate'
  }
}
