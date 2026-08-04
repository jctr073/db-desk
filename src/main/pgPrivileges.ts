/**
 * Connect-time answer to one question: can the role this connection
 * authenticated as write any PROTECTED schema in the pinned database?
 *
 * A protected schema is one holding real production data, recognized purely
 * by shape: three or more tables (relkind r/p, partition children excluded so
 * a partitioned table counts once; views, materialized views and foreign
 * tables never count). No name heuristics — "public" is protected when it is
 * the hot schema and ignored when it is empty. Counts come from pg_catalog
 * inside the probe statement itself, never from the (cache-first, possibly
 * stale) introspection, so classification and privilege sweep are atomic.
 *
 * On prod connections the agent's Read-Only mode is only offered when the
 * answer is provably "no" — then the server's own privilege checks (42501),
 * not this app's belts, are what stand between the agent and a mutation to
 * data that matters. Anything short of a provable "no" (a write grant on a
 * protected schema, a role attribute that bypasses grants, or a
 * failed/unparseable check) clamps the agent, so every error path here must
 * land on 'writable' or 'indeterminate', never 'readonly'.
 *
 * Deliberate v2 scoping (see docs/plan-prod-gating-v2.md):
 *  - Write/CREATE on a trivial schema (< 3 tables) does not clamp. The
 *    accepted residual: with every app-side belt failed, such a role could
 *    still create or mutate objects there — including search_path shadowing
 *    for other clients (CVE-2018-1058 style).
 *  - rolcreatedb and database-level CREATE no longer clamp: a new database
 *    or a new schema cannot touch an existing protected schema.
 *  - rolsuper and rolbypassrls still clamp unconditionally (they bypass the
 *    grant system everywhere, protected schemas included).
 *  - A schema empty at connect that receives a migration mid-session stays
 *    unprotected until reconnect (same snapshot semantics as v1), and a
 *    sequence living outside the schema of the tables it backs is only
 *    protected with its own schema.
 *
 * Known residuals carried over from v1:
 *  - EXECUTE on a SECURITY DEFINER function that writes runs with the
 *    function owner's privileges, not the caller's. Grants inspection has
 *    no way to prove its absence.
 *  - CREATE on schema "public" held ONLY through the PUBLIC pseudo-role is
 *    ignored (now relevant only when public is protected). Databases
 *    pg_upgraded/restored from PG <= 14 carry the legacy
 *    "GRANT CREATE ON SCHEMA public TO PUBLIC" ACL forward, which would
 *    classify every role writable — including genuinely read-only monitoring
 *    roles — through a grant nobody chose. The same grant on any other
 *    protected schema, or CREATE held directly/via a real role, still clamps.
 */

import type { DbResult, QueryResult } from '../shared/db'

export type PgWriteCapability = 'readonly' | 'writable' | 'indeterminate'

/**
 * Probe outcome: the verdict plus which protected schemas tripped it, so the
 * clamp reason and the connect-time warning dialog can name them. Empty for a
 * role-attribute hit (superuser / BYPASSRLS — the role can write everywhere)
 * and for every non-writable verdict.
 */
export interface PgWriteCapabilityResult {
  verdict: PgWriteCapability
  writableSchemas: string[]
}

/**
 * One statement, one row. `role_closure` is every role reachable from
 * current_user through pg_auth_members — deliberately ignoring INHERIT,
 * because a member of a NOINHERIT role can still SET ROLE into it and use its
 * grants. `protected_schemas` classifies namespaces by live table count, and
 * each sweep asks "does ANY role in the closure hold this, on ANY protected
 * schema?", collecting the offending schema names.
 *
 * Probe notes:
 *  - rolsuper bypasses the grant system entirely and rolbypassrls is not
 *    provably harmless, so both stay global (no schema scoping can excuse
 *    them). They surface as booleans, not schema names.
 *  - The protected_schemas filter drops pg_% (which also covers pg_temp and
 *    pg_toast) and information_schema before counting.
 *  - Table DML sweeps relkinds r/p/v/f (plain, partitioned, views — writable
 *    when auto-updatable — and foreign tables) within protected schemas:
 *    views don't count toward the threshold but are real write paths into
 *    schemas that qualified without them. Materialized views are excluded:
 *    writing one takes ownership, and owners already hold DML on it anyway.
 *    pg_catalog writes are superuser-only, covered by rolsuper.
 *    has_table_privilege only sees table-level (relacl) grants, so the same
 *    sweep also calls has_any_column_privilege for INSERT/UPDATE — a
 *    column-only grant (GRANT UPDATE (col) ON t) is a real write the
 *    table-level check is blind to. (DELETE/TRUNCATE have no column form.)
 *  - Sequences (relkind 'S') are a distinct probe: USAGE or UPDATE lets a
 *    role advance one via nextval/setval, which mutates persistent state
 *    (nextval even survives rollback), so either grant counts as writable.
 *  - Schema CREATE covers protected schemas only. On schema "public" only,
 *    CREATE that is reachable solely through the PUBLIC pseudo-role is
 *    ignored (the legacy pre-15 default, carried forward by
 *    pg_upgrade/restore — see the header residuals). The carve-out demands a
 *    positive sign of a real grant: the closure owning the schema, or an
 *    nspacl entry whose grantee is a closure role. A superuser sails past
 *    the aclexplode test but is already caught by rolsuper, and acldefault()
 *    covers a NULL nspacl (owner-only ACL).
 *  - The schema list is emitted as JSON text (not a text[] value) so the
 *    result survives the driver's cell folding verbatim; the classifier
 *    parses it and treats anything unparseable as indeterminate. Unlike
 *    v1's EXISTS probes this sweep cannot short-circuit on the first hit —
 *    it names every offender — but it visits protected schemas only and
 *    stays bounded by the caller's statement timeout.
 */
export const PG_WRITE_CAPABILITY_SQL = `
WITH RECURSIVE role_closure AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
  UNION
  SELECT m.roleid
  FROM pg_catalog.pg_auth_members m
  JOIN role_closure rc ON m.member = rc.oid
),
protected_schemas AS (
  SELECT n.oid, n.nspname
  FROM pg_catalog.pg_namespace n
  JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid
  WHERE n.nspname NOT LIKE 'pg\\_%'
    AND n.nspname <> 'information_schema'
    AND t.relkind IN ('r', 'p')
    AND NOT t.relispartition
  GROUP BY n.oid, n.nspname
  HAVING count(*) >= 3
),
writable_protected AS (
  SELECT p.nspname
  FROM pg_catalog.pg_class c
  JOIN protected_schemas p ON p.oid = c.relnamespace
  CROSS JOIN role_closure rc2
  WHERE c.relkind IN ('r', 'p', 'v', 'f')
    AND (has_table_privilege(rc2.oid, c.oid, 'INSERT')
      OR has_table_privilege(rc2.oid, c.oid, 'UPDATE')
      OR has_table_privilege(rc2.oid, c.oid, 'DELETE')
      OR has_table_privilege(rc2.oid, c.oid, 'TRUNCATE')
      OR has_any_column_privilege(rc2.oid, c.oid, 'INSERT')
      OR has_any_column_privilege(rc2.oid, c.oid, 'UPDATE'))
  UNION
  SELECT p.nspname
  FROM pg_catalog.pg_class s
  JOIN protected_schemas p ON p.oid = s.relnamespace
  CROSS JOIN role_closure rcs
  WHERE s.relkind = 'S'
    AND (has_sequence_privilege(rcs.oid, s.oid, 'USAGE')
      OR has_sequence_privilege(rcs.oid, s.oid, 'UPDATE'))
  UNION
  SELECT p.nspname
  FROM protected_schemas p
  JOIN pg_catalog.pg_namespace n2 ON n2.oid = p.oid
  CROSS JOIN role_closure rc3
  WHERE has_schema_privilege(rc3.oid, n2.oid, 'CREATE')
    AND (n2.nspname <> 'public'
      OR n2.nspowner = rc3.oid
      OR EXISTS (
        SELECT 1
        FROM aclexplode(coalesce(n2.nspacl, pg_catalog.acldefault('n', n2.nspowner))) a
        WHERE a.privilege_type = 'CREATE'
          AND a.grantee IN (SELECT oid FROM role_closure)
      ))
)
SELECT
  bool_or(r.rolsuper)     AS any_super,
  bool_or(r.rolbypassrls) AS any_bypassrls,
  coalesce(
    (SELECT json_agg(w.nspname ORDER BY w.nspname)::text FROM writable_protected w),
    '[]'
  ) AS writable_schemas
FROM role_closure rc
JOIN pg_catalog.pg_roles r ON r.oid = rc.oid
`.trim()

/** The role-attribute columns; either true means "can write everywhere". */
const ATTRIBUTE_COLUMNS = ['any_super', 'any_bypassrls'] as const

function indeterminate(): PgWriteCapabilityResult {
  return { verdict: 'indeterminate', writableSchemas: [] }
}

/**
 * Fold the probe row into a verdict. Pure so the truth table is unit-testable
 * without a driver. Anything that is not a well-formed row — booleans plus a
 * JSON array of schema-name strings (which the driver's 10k-char cell cap can
 * corrupt in pathological databases) — is 'indeterminate': a malformed result
 * must clamp, not pass.
 */
export function classifyPrivilegeRow(result: QueryResult): PgWriteCapabilityResult {
  if (result.rows.length !== 1) return indeterminate()
  const row = result.rows[0]
  const byName = new Map(result.fields.map((f, i) => [f.name, row[i]]))
  let attributeHit = false
  for (const column of ATTRIBUTE_COLUMNS) {
    const value = byName.get(column)
    // bool_or over an empty set would be NULL; treat like any malformed value.
    if (typeof value !== 'boolean') return indeterminate()
    attributeHit = attributeHit || value
  }
  const rawSchemas = byName.get('writable_schemas')
  if (typeof rawSchemas !== 'string') return indeterminate()
  let schemas: unknown
  try {
    schemas = JSON.parse(rawSchemas)
  } catch {
    return indeterminate()
  }
  if (!Array.isArray(schemas) || schemas.some((name) => typeof name !== 'string')) {
    return indeterminate()
  }
  if (attributeHit) return { verdict: 'writable', writableSchemas: [] }
  if (schemas.length > 0) return { verdict: 'writable', writableSchemas: schemas as string[] }
  return { verdict: 'readonly', writableSchemas: [] }
}

/**
 * Run the probe through an injected runner (the facade wires the connected
 * driver in) so this module stays free of driver imports and testable
 * against fakes. The runner is expected to already carry the read-only
 * session flag and a statement timeout.
 */
export async function checkPgWriteCapability(
  run: (sql: string) => Promise<DbResult<QueryResult>>
): Promise<PgWriteCapabilityResult> {
  try {
    const res = await run(PG_WRITE_CAPABILITY_SQL)
    if (!res.ok) return indeterminate()
    return classifyPrivilegeRow(res.data)
  } catch {
    return indeterminate()
  }
}
