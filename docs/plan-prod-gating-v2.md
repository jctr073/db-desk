# Plan: Prod privilege gating v2 — schema-scoped Postgres probe, Databricks exempt

Status: implemented — all four phases landed on `permission_v2`, 2026-08-03.
Note: the gating docs live in `docs/architecture.md` + `docs/user-guide.md`
(the `docs/agent-modes.md` named below never existed).

## Goal

Rescope the prod agent-privilege gate (v1: PRs #44–47 Postgres, #48 Databricks):

1. **Databricks is exempt entirely.** It is a data warehouse (CDC replica of the
   Postgres sources), not a system where live writes immediately impact
   production. No probe, no clamp, even on `prod`. The environment field,
   badges, and prod accent stay.
2. **Postgres prod clamps only on write access to schemas that hold real
   production data** ("protected" schemas), instead of write access to
   anything anywhere in the database. dev/stage behavior is unchanged
   (unrestricted, no probe).
3. **A clamp is announced, not silent.** When a prod connect finds write
   access to protected schemas, a warning dialog names the hot schemas,
   says the agent has been downgraded to Metadata Only for safety, and
   advises reconnecting with a read-only role.

## Threat model (why the loosening is sound)

v1 rejected an "ignore empty schemas" heuristic (emptiness ≠ safety). v2
adopts a scoped version deliberately: the server's privilege system remains
the guarantor for the data that matters. The clamp fires exactly when the
role could write a protected schema; when it doesn't fire, even a total
failure of the app-side belts (single-statement guard, read-only session)
exposes only objects classified as not mattering. The gate is the second
layer — the first is the agent tool lockdown itself
(`guardAgentStatement` + `readOnly` session, verified against the escape
corpus in `test/integration/postgres/corpus.test.ts`).

## Decisions (agreed 2026-08-03)

- **Protected schema** = a schema containing **≥ 3 tables**. Tables means
  relkind `r`/`p`, excluding partition children (`relispartition`) so one
  partitioned table with many partitions counts once. Views, materialized
  views, and foreign tables do **not** count toward the threshold.
  `pg_*`/`information_schema` never count. No largest-schema backstop.
- **One rule, both database shapes.** No service-DB vs monorepo detection:
  every schema is classified independently, clamp on write access to _any_
  protected schema. A service DB simply has one protected schema, a monorepo
  several. Schema names are irrelevant (`public` can be the hot schema).
- **Global role checks**: `rolsuper` and `rolbypassrls` still clamp
  unconditionally (a superuser writes anywhere). `rolcreatedb` and
  database-level `CREATE` (new-schema right) no longer clamp — neither can
  touch an existing protected schema.
- **Legacy public ACL carve-out stays**, now only reachable when `public`
  is protected: `CREATE` on schema `public` held solely through the `PUBLIC`
  pseudo-role (pre-PG15 default carried forward by pg_upgrade/restore) does
  not clamp. Same positive-evidence test as v1 (closure owns the schema, or
  an `aclexplode` grantee is a closure role).
- **Ungoverned-catalog exclusion removed**: prod Databricks no longer hides
  `hive_metastore`/`spark_catalog` from the tree and pin dialog — its
  rationale ("the probe cannot reason about them") dies with the probe.
- **Clamp reasons name the offending schema(s)** — the scoped probe returns
  which protected schemas are writable, so the reason string can say
  “…can write to production schema "billing"” instead of a generic sentence.
- **Connect-time warning dialog on a `writable` clamp** (agreed 2026-08-03):
  shown every prod connect that clamps with a `writable` verdict, naming
  the hot schema(s). An `indeterminate` clamp stays passive (badge +
  reason only, as in v1) — it is usually transient (probe timeout,
  malformed row) and a modal would be noise; flip this if it proves wrong
  in practice. The dialog warns, it does not block: the connection is
  already up, and Metadata Only is already enforced main-side before the
  renderer hears anything.

### Accepted residuals (on the record)

- A role with write/CREATE on a _trivial_ schema gets agent Read-Only on
  prod. It could (belts failing) create objects there, including
  search_path shadowing that affects other clients (CVE-2018-1058 style) —
  v1 accepted this for legacy `public` only; v2 broadens it to all trivial
  schemas by design.
- Connect-time snapshot: a schema empty at connect that receives a
  migration mid-session stays unprotected until reconnect (same snapshot
  semantics as v1).
- A sequence living in a different schema than the tables it backs (rare)
  is only protected if _its_ schema is protected.
- SECURITY DEFINER EXECUTE residual unchanged from v1.
- Sub-threshold real schemas (a service schema with only 1–2 tables) are
  unprotected — fail-open below the threshold is inherent to the design.

---

## Phase 1 — Databricks exemption

1. `src/main/db.ts`
   - `computeAgentCapability`: return `AGENT_UNRESTRICTED` for
     `type === 'databricks'` before the environment branch. Delete
     `checkDatabricksCapability` and `databricksFetcher`; drop the
     `dbxPrivileges` imports and the "role vs principal" noun branch.
   - `connect()`: remove the prod ungoverned-catalog filter block;
     `listCatalogs()`: remove the same filter. Remove the
     `connEnvironments` map if nothing else reads it after this.
   - Update the `CAPABILITY_PROBE_TIMEOUT_MS` comment (Postgres-only now).
2. Delete `src/main/dbxPrivileges.ts` and its unit tests.
3. `docs/agent-modes.md`: Databricks section → exempt, with the
   warehouse/CDC-replica rationale.

Result: prod Databricks connections get full agent Read-Only mode and show
all catalogs; Postgres behavior untouched.

## Phase 2 — Scoped Postgres probe

All in `src/main/pgPrivileges.ts`; the shape (one SQL statement, pure
classifier, injected runner, fail-closed) is unchanged.

1. **`protected_schemas` CTE** added after `role_closure`:
   namespaces with `count(*) >= 3` over
   `relkind IN ('r','p') AND NOT relispartition`, excluding
   `pg_%`/`information_schema`.
2. **Scope the sweeps** by joining each EXISTS probe's namespace to
   `protected_schemas`:
   - `any_table_write`: same relkinds as v1 (`r`,`p`,`v`,`f` — writable
     auto-updatable views and foreign tables in a protected schema are real
     write paths even though they don't _count_ toward the threshold), same
     `has_table_privilege` + `has_any_column_privilege` probes.
   - `any_sequence_write`: same USAGE/UPDATE probe, protected schemas only.
   - `any_schema_create`: `has_schema_privilege(…, 'CREATE')` over protected
     schemas only, keeping the `public`/PUBLIC carve-out branch verbatim.
3. **Drop** the `any_createdb` and `any_db_create` columns; keep
   `any_super`/`any_bypassrls` global.
4. **Return offending schemas**: add a `writable_schemas` column (`text[]`,
   distinct nspnames that tripped any scoped probe, `'*'` sentinel or empty
   for role-attribute hits). `classifyPrivilegeRow` returns
   `{ verdict: PgWriteCapability; writableSchemas: string[] }`; any
   malformed row (missing column, non-boolean, non-array) stays
   `indeterminate` → clamp.
5. **Structured `AgentCapability`** (`src/shared/db.ts`): alongside
   `readOnlyAvailable`/`reason`, add `verdict?: 'writable' | 'indeterminate'`
   and `writableSchemas?: string[]` (empty for role-attribute hits — the
   dialog copy then says the role itself can write everywhere). The facade
   map in `db.ts` stays the single author; the renderer gets structured
   data instead of parsing strings.
6. `src/main/db.ts` reason strings: writable →
   `The connecting role can write to production schema "billing". Connect
with a read-only role to enable agent Read-Only mode.` (list, truncated
   past 3 schemas); role-attribute hit → superuser wording; indeterminate
   wording unchanged.
7. Header comment: rewrite the "one question" framing (can the role write
   _protected_ schemas), fold the Decisions/residuals above into it.

Counts come live from `pg_catalog` inside the probe statement itself —
never from the (cache-first, possibly stale) introspection — so
classification and privilege sweep are atomic and current.

## Phase 3 — Clamp warning dialog

1. **Trigger.** In the renderer connect flow (`useConnectionState`, where
   the `ConnectResult` lands), a successful connect whose
   `agentCapability` has `verdict === 'writable'` queues the warning
   dialog. Postgres-prod only by construction (the probe no longer runs
   anywhere else). Shown on every such connect — no suppression state.
2. **Dialog** (new component alongside the existing connection dialogs,
   reusing the app's modal pattern):
   - Title: "Production database with write access".
   - Body: this connection reaches a production database whose hot
     schema(s) — listed by name from `writableSchemas`, e.g. `billing`,
     `orders` — are writable by the connecting role. Role-attribute
     variant (empty list): the role can write everywhere (superuser /
     BYPASSRLS).
   - Consequence line: the AI agent has been downgraded to **Metadata
     Only** for safety on this connection.
   - Advice line: reconnect with a read-only role to restore agent
     Read-Only mode.
   - Actions: primary **Continue** (acknowledge; connection stays up),
     secondary **Disconnect**.
3. The dialog is informational — enforcement happened in main before the
   renderer saw the result; dismissing it changes nothing about the clamp.

## Phase 4 — Tests and docs

1. `classifyPrivilegeRow` unit truth table: new column set, schema-list
   passthrough, malformed-array → indeterminate.
2. `test/integration/postgres/privilegeCheck.test.ts` — rebuild fixtures
   around schema shapes:
   - **Service DB** (`billing` 10 tables, `public` empty, `data` 1 view):
     write/CREATE only on `public`+`data` → `readonly` (the v2 loosening);
     UPDATE on a `billing` table → `writable`; column-only grant in
     `billing` → `writable`; sequence USAGE in `billing` → `writable`;
     CREATE on `billing` → `writable`.
   - **Monorepo** (3 schemas ≥ 3 tables each): write in any one →
     `writable`; write only in a trivial fourth → `readonly`.
   - **Hot `public`**: ≥ 3 tables in `public`; legacy
     `GRANT CREATE … TO PUBLIC` alone → `readonly` (carve-out); a direct
     CREATE grant or DML → `writable`.
   - **Threshold edges**: 2 tables → unprotected; 3 → protected; 5 views +
     0 tables → unprotected; 1 partitioned table with 5 partitions →
     counts as 1 → unprotected.
   - **Role attributes**: superuser → `writable` even with zero protected
     schemas; `CREATEDB`-only role → `readonly` (was `writable` in v1).
   - Re-prove the two v1 fail-open catches (column-only grant, sequence
     grant) _inside_ a protected schema.
3. Facade-level check that a prod Databricks connect records an
   unrestricted capability and `listCatalogs` returns ungoverned catalogs.
4. Capability plumbing: a `writable` verdict surfaces `writableSchemas`
   on the `ConnectResult` capability (facade test); renderer test (if the
   existing connect-flow tests allow) that a writable capability opens the
   warning dialog and an indeterminate one does not.
5. `docs/agent-modes.md` updated for both engines, including the new
   warning dialog.

---

## Non-goals

- No changes to dev/stage behavior, `clampAgentMode`, `runAgentQuery`
  belts, the environment field/badges/accent, or SQL-editor/export gating
  (still deliberately ungated).
- No re-probe on schema revalidation (drift residual documented instead).
- No configurability of the threshold (constant in `pgPrivileges.ts`).
