/**
 * Connect-time answer to one question, for a prod Databricks connection: can
 * the principal this connection authenticated as write ANYTHING within the
 * pinned scope (the connected catalog and its pinned schemas)?
 *
 * The Postgres probe (pgPrivileges.ts) can ask the server directly because
 * Postgres grants are visible from SQL. Unity Catalog grants are normally made
 * to *groups*, and a SQL session cannot enumerate its own group memberships —
 * a `SHOW GRANTS` check would miss a group-granted MODIFY and classify a
 * writable principal as read-only, the dangerous fail-open direction. So the
 * check runs over the REST API instead, using the same host + PAT the
 * connection already holds:
 *
 *  - SCIM `/Me` resolves the principal's identity (userName/emails) and whether
 *    it is a workspace/account/metastore admin (admins bypass grant checks).
 *  - Unity Catalog "effective permissions", queried *filtered by the user
 *    principal*, returns the privileges the principal effectively holds on a
 *    securable — INCLUDING those inherited through group membership and through
 *    the catalog/metastore hierarchy. A non-admin may always view their own
 *    effective permissions, so this needs no elevated PAT scope.
 *  - The securable's `owner` is fetched separately: owners implicitly hold all
 *    privileges, and ownership is not surfaced as a privilege assignment.
 *
 * As with Postgres, every uncertain path lands on 'writable' or
 * 'indeterminate', never 'readonly': the caller clamps the agent on anything
 * short of a provable read-only.
 *
 * Known residuals the check cannot see (documented, not defended):
 *  - If "effective permissions" filtered by the user does not expand a nested
 *    group grant, a MODIFY reachable only through that nesting is missed.
 *  - Legacy `hive_metastore` has no Unity Catalog governance to inspect; it is
 *    clamped by construction (see checkDbxWriteCapability).
 */

export type DbxWriteCapability = 'readonly' | 'writable' | 'indeterminate'

/**
 * Privileges that let a principal change data or structure within a securable.
 * Compared upper-cased; any `CREATE *` (CREATE_TABLE, CREATE_SCHEMA,
 * CREATE_VOLUME, CREATE_FUNCTION, CREATE_MODEL, …) also counts and is matched
 * by prefix rather than enumerated, so a new CREATE_* privilege is caught
 * without a code change. USE_/SELECT/READ/BROWSE/EXECUTE are read-class and
 * deliberately absent.
 */
const WRITE_PRIVILEGES = new Set<string>([
  'ALL_PRIVILEGES',
  'MODIFY',
  'APPLY_TAG',
  'WRITE_VOLUME',
  'WRITE_FILES',
  'MANAGE',
  'REFRESH'
])

function isWritePrivilege(privilege: string): boolean {
  const p = privilege.toUpperCase()
  return WRITE_PRIVILEGES.has(p) || p.startsWith('CREATE')
}

/** The principal this connection authenticated as, resolved from SCIM /Me. */
interface DbxPrincipal {
  /**
   * Every name a grant or ownership might use for this principal, lower-cased:
   * the userName, each email, and each direct group's display name and id.
   * Being liberal here only ever adds matches — the fail-safe direction, since
   * an extra name can turn a missed grant into a caught one but never the
   * reverse.
   */
  names: Set<string>
  /** Workspace `admins` member, or an account/metastore admin role. */
  isAdmin: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function addName(names: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) names.add(value.trim().toLowerCase())
}

/**
 * Parse a SCIM /Me payload into a principal, or null when it is too malformed
 * to identify anyone (no name at all) — the caller treats null as
 * indeterminate. Parsing is defensive: unexpected shapes never throw, they
 * simply contribute nothing.
 */
export function principalFromMe(me: unknown): DbxPrincipal | null {
  const obj = asRecord(me)
  if (!obj) return null
  const names = new Set<string>()
  addName(names, obj.userName)
  for (const email of asArray(obj.emails)) {
    addName(names, asRecord(email)?.value)
  }
  let isAdmin = false
  for (const group of asArray(obj.groups)) {
    const g = asRecord(group)
    if (!g) continue
    const display = typeof g.display === 'string' ? g.display : ''
    addName(names, g.display)
    addName(names, g.value)
    if (display.toLowerCase() === 'admins') isAdmin = true
  }
  // Account/metastore admin shows up as a role (shape varies by workspace);
  // any role naming "admin" is treated as admin — the fail-safe direction.
  for (const role of asArray(obj.roles)) {
    const r = asRecord(role)
    const value = typeof r?.value === 'string' ? r.value : ''
    if (/admin/i.test(value)) isAdmin = true
  }
  if (names.size === 0) return null
  return { names, isAdmin }
}

/**
 * A securable's fetched state: its effective-permission assignments and its
 * owner. `assignments` is the raw `privilege_assignments` array from the
 * effective-permissions endpoint; `owner` is the securable's owner name (a
 * user or group) or null when unknown.
 */
export interface DbxSecurableState {
  assignments: unknown
  owner: string | null
}

/** True when any assignment for a name in `names` carries a write privilege. */
function assignmentsGrantWrite(assignments: unknown, names: Set<string>): boolean {
  for (const assignment of asArray(assignments)) {
    const a = asRecord(assignment)
    if (!a) continue
    const principal = typeof a.principal === 'string' ? a.principal.toLowerCase() : ''
    if (!names.has(principal)) continue
    for (const entry of asArray(a.privileges)) {
      // Effective permissions list objects ({ privilege, inherited_from* });
      // plain-grant responses list bare strings. Accept both.
      const priv = typeof entry === 'string' ? entry : (asRecord(entry)?.privilege as unknown)
      if (typeof priv === 'string' && isWritePrivilege(priv)) return true
    }
  }
  return false
}

/**
 * Fold the fetched principal + per-securable state into a verdict. Pure, so
 * the truth table is unit-testable against fabricated REST payloads.
 *
 *  - An unidentifiable principal (null) → indeterminate.
 *  - An admin principal → writable (admins bypass grants).
 *  - Ownership of any checked securable, or a write privilege on any of them
 *    → writable.
 *  - Otherwise → readonly.
 */
export function classifyDbxPermissions(
  me: unknown,
  securables: DbxSecurableState[]
): DbxWriteCapability {
  const principal = principalFromMe(me)
  if (!principal) return 'indeterminate'
  if (principal.isAdmin) return 'writable'
  for (const securable of securables) {
    if (securable.owner && principal.names.has(securable.owner.toLowerCase())) {
      return 'writable'
    }
    if (assignmentsGrantWrite(securable.assignments, principal.names)) return 'writable'
  }
  return 'readonly'
}

/** A GET against the Databricks REST API, returning parsed JSON. Throws on any
 *  non-2xx status, network error, or timeout — the orchestrator maps that to
 *  indeterminate. Injected by the facade so this module has no network imports
 *  and is testable against fakes. */
export type DbxFetcher = (path: string) => Promise<unknown>

const SCIM_ME_PATH = '/api/2.0/preview/scim/v2/Me'

/** Legacy catalog with no Unity Catalog governance; nothing to inspect. */
const UNGOVERNED_CATALOG = 'hive_metastore'

function effectivePermPath(
  securableType: 'catalog' | 'schema',
  fullName: string,
  principal: string
): string {
  return (
    `/api/2.1/unity-catalog/effective-permissions/${securableType}/` +
    `${encodeURIComponent(fullName)}?principal=${encodeURIComponent(principal)}`
  )
}

function securableMetaPath(securableType: 'catalog' | 'schema', fullName: string): string {
  const collection = securableType === 'catalog' ? 'catalogs' : 'schemas'
  return `/api/2.1/unity-catalog/${collection}/${encodeURIComponent(fullName)}`
}

function ownerOf(meta: unknown): string | null {
  const owner = asRecord(meta)?.owner
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null
}

/**
 * Run the REST check through an injected fetcher and fold the result. The
 * scope is the connected catalog plus its pinned schemas; a connection with
 * no schema pinning is left to the caller (there is no bounded scope to prove
 * read-only over, so it stays clamped). Legacy hive_metastore and any fetch
 * failure resolve to indeterminate — fail closed, always.
 */
export async function checkDbxWriteCapability(
  fetch: DbxFetcher,
  catalog: string,
  pinnedSchemas: string[] | null
): Promise<DbxWriteCapability> {
  try {
    const catalogName = catalog.trim()
    if (!catalogName || catalogName === UNGOVERNED_CATALOG) return 'indeterminate'
    // No pinned scope to prove read-only over — stay conservative rather than
    // sweep the whole metastore.
    if (!pinnedSchemas || pinnedSchemas.length === 0) return 'indeterminate'

    const me = await fetch(SCIM_ME_PATH)
    const principal = principalFromMe(me)
    if (!principal) return 'indeterminate'
    if (principal.isAdmin) return 'writable'
    // A user principal to filter effective permissions by. userName/email is
    // what UC grants use for a user; the first name added is the userName.
    const [filterName] = principal.names
    if (!filterName) return 'indeterminate'

    const targets: { type: 'catalog' | 'schema'; fullName: string }[] = [
      { type: 'catalog', fullName: catalogName },
      ...pinnedSchemas.map((schema) => ({
        type: 'schema' as const,
        fullName: `${catalogName}.${schema}`
      }))
    ]

    const securables: DbxSecurableState[] = []
    for (const target of targets) {
      const perms = await fetch(effectivePermPath(target.type, target.fullName, filterName))
      const meta = await fetch(securableMetaPath(target.type, target.fullName))
      // A 200 whose body lacks a privilege_assignments array is API drift, not
      // "no grants": treat an unrecognized shape as unverifiable rather than
      // read the absent grants as read-only (which would fail open). An empty
      // array is a legitimate "nothing granted" and passes.
      const assignments = asRecord(perms)?.privilege_assignments
      if (!Array.isArray(assignments)) return 'indeterminate'
      securables.push({ assignments, owner: ownerOf(meta) })
    }
    return classifyDbxPermissions(me, securables)
  } catch {
    return 'indeterminate'
  }
}
