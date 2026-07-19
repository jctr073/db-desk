/**
 * Unit tests for the connect-time Databricks write-capability probe
 * (src/main/dbxPrivileges.ts). The classifier is pure, so its truth table runs
 * against fabricated SCIM + effective-permission payloads; the orchestrator's
 * REST sequencing and error paths are exercised with a fake fetcher. As with
 * the Postgres probe, direction matters: no malformed or missing input, and no
 * fetch failure, may ever classify 'readonly'.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  checkDbxWriteCapability,
  classifyDbxPermissions,
  isUnityGovernedCatalog,
  principalFromMe
} from '../../src/main/dbxPrivileges'
import type { DbxFetcher, DbxSecurableState } from '../../src/main/dbxPrivileges'

/** A securable with the given user principal holding the given privileges. */
function grant(
  principal: string,
  privileges: string[],
  owner: string | null = null
): DbxSecurableState {
  return {
    assignments: [{ principal, privileges: privileges.map((p) => ({ privilege: p })) }],
    owner
  }
}

const READER = { userName: 'reader@x', groups: [] }

describe('principalFromMe', () => {
  it('collects userName, emails, and group names, lower-cased', () => {
    const principal = principalFromMe({
      userName: 'Reader@X',
      emails: [{ value: 'Alias@X' }],
      groups: [{ display: 'Data_Readers', value: 'g-1' }]
    })
    expect(principal?.names).toEqual(new Set(['reader@x', 'alias@x', 'data_readers', 'g-1']))
    expect(principal?.isAdmin).toBe(false)
  })

  it('collects a service principal identity, applicationId first', () => {
    // No userName on a service principal; grants key on its applicationId, so
    // that must be the first (filter) name.
    const principal = principalFromMe({
      applicationId: 'AB12-CD34',
      displayName: 'ETL Job',
      groups: [{ display: 'writers' }]
    })
    expect(principal?.names).toEqual(new Set(['ab12-cd34', 'etl job', 'writers']))
    expect([...(principal?.names ?? [])][0]).toBe('ab12-cd34')
  })

  it('flags the workspace admins group as admin', () => {
    expect(principalFromMe({ userName: 'a@x', groups: [{ display: 'admins' }] })?.isAdmin).toBe(
      true
    )
  })

  it('flags an account/metastore admin role as admin', () => {
    expect(principalFromMe({ userName: 'a@x', roles: [{ value: 'account_admin' }] })?.isAdmin).toBe(
      true
    )
  })

  it.each([null, undefined, 42, {}, { userName: '' }, { groups: [{ display: 'x' }] }])(
    'returns null for an unidentifiable payload (%o)',
    (me) => {
      // No usable name → cannot be identified → the caller clamps. (A payload
      // with only a group name still yields a name, so it is identifiable.)
      const principal = principalFromMe(me)
      if (me && typeof me === 'object' && 'groups' in me) {
        expect(principal?.names.has('x')).toBe(true)
      } else {
        expect(principal).toBeNull()
      }
    }
  )
})

describe('classifyDbxPermissions', () => {
  it('classifies a SELECT-only principal as readonly', () => {
    expect(classifyDbxPermissions(READER, [grant('reader@x', ['SELECT', 'USE_SCHEMA'])])).toBe(
      'readonly'
    )
  })

  it('classifies no securables (nothing granted) as readonly', () => {
    expect(classifyDbxPermissions(READER, [])).toBe('readonly')
  })

  it.each(['MODIFY', 'ALL_PRIVILEGES', 'APPLY_TAG', 'WRITE_VOLUME', 'MANAGE', 'REFRESH'])(
    'classifies the write privilege %s as writable',
    (priv) => {
      expect(classifyDbxPermissions(READER, [grant('reader@x', ['SELECT', priv])])).toBe('writable')
    }
  )

  it.each(['CREATE_TABLE', 'CREATE_SCHEMA', 'CREATE_VOLUME', 'CREATE_FUNCTION', 'CREATE_MODEL'])(
    'classifies any CREATE_* privilege (%s) as writable',
    (priv) => {
      expect(classifyDbxPermissions(READER, [grant('reader@x', [priv])])).toBe('writable')
    }
  )

  it('catches a write privilege granted to one of the principal groups', () => {
    const me = { userName: 'u@x', groups: [{ display: 'writers' }] }
    expect(classifyDbxPermissions(me, [grant('writers', ['MODIFY'])])).toBe('writable')
  })

  it('catches a write privilege on any one of several securables', () => {
    const securables = [
      grant('reader@x', ['SELECT']),
      grant('reader@x', ['SELECT']),
      grant('reader@x', ['MODIFY'])
    ]
    expect(classifyDbxPermissions(READER, securables)).toBe('writable')
  })

  it('ignores a write privilege granted to a different principal', () => {
    expect(classifyDbxPermissions(READER, [grant('someone_else@x', ['MODIFY'])])).toBe('readonly')
  })

  it('treats ownership of a checked securable as writable', () => {
    expect(classifyDbxPermissions(READER, [grant('reader@x', ['SELECT'], 'reader@x')])).toBe(
      'writable'
    )
  })

  it('treats group ownership of a checked securable as writable', () => {
    const me = { userName: 'u@x', groups: [{ display: 'owners' }] }
    expect(classifyDbxPermissions(me, [{ assignments: [], owner: 'owners' }])).toBe('writable')
  })

  it('treats an admin principal as writable regardless of grants', () => {
    const me = { userName: 'a@x', groups: [{ display: 'admins' }] }
    expect(classifyDbxPermissions(me, [grant('a@x', ['SELECT'])])).toBe('writable')
  })

  it('classifies an unidentifiable principal as indeterminate', () => {
    expect(classifyDbxPermissions({ userName: '' }, [grant('x', ['SELECT'])])).toBe('indeterminate')
  })

  it('tolerates a bare-string privileges list (plain-grant shape)', () => {
    const securable: DbxSecurableState = {
      assignments: [{ principal: 'reader@x', privileges: ['MODIFY'] }],
      owner: null
    }
    expect(classifyDbxPermissions(READER, [securable])).toBe('writable')
  })

  it.each([null, undefined, 'nope', 42, {}])(
    'tolerates a malformed assignments payload (%o) as readonly, not a throw',
    (assignments) => {
      // A structurally-odd effective-permissions body contributes no write
      // grant; with a valid principal and no write found it is readonly. (The
      // orchestrator, not the classifier, turns a failed *fetch* into
      // indeterminate.)
      expect(classifyDbxPermissions(READER, [{ assignments, owner: null }])).toBe('readonly')
    }
  )
})

describe('isUnityGovernedCatalog', () => {
  it.each(['hive_metastore', 'HIVE_METASTORE', 'spark_catalog', ' spark_catalog ', ''])(
    'rejects the ungoverned/empty catalog %o',
    (name) => {
      expect(isUnityGovernedCatalog(name)).toBe(false)
    }
  )

  it.each(['main', 'samples', 'prod_lake'])('accepts the governed catalog %o', (name) => {
    expect(isUnityGovernedCatalog(name)).toBe(true)
  })
})

describe('checkDbxWriteCapability', () => {
  /** Records requested paths and answers them from a path→payload table. */
  function fakeFetcher(table: Record<string, unknown>, seen: string[] = []): DbxFetcher {
    return (path) => {
      seen.push(path)
      for (const [needle, payload] of Object.entries(table)) {
        if (path.includes(needle)) return Promise.resolve(payload)
      }
      return Promise.reject(new Error(`unexpected path ${path}`))
    }
  }

  const READONLY_TABLE = {
    '/scim/v2/Me': READER,
    '/effective-permissions/': {
      privilege_assignments: [{ principal: 'reader@x', privileges: [{ privilege: 'SELECT' }] }]
    },
    '/unity-catalog/catalogs/': { owner: 'someone@x' },
    '/unity-catalog/schemas/': { owner: 'someone@x' }
  }

  it('returns readonly for a provably read-only pinned scope', async () => {
    const verdict = await checkDbxWriteCapability(fakeFetcher(READONLY_TABLE), 'main', ['sales'])
    expect(verdict).toBe('readonly')
  })

  it('checks the catalog and every pinned schema', async () => {
    const seen: string[] = []
    await checkDbxWriteCapability(fakeFetcher(READONLY_TABLE, seen), 'main', ['sales', 'ops'])
    const permPaths = seen.filter((p) => p.includes('/effective-permissions/'))
    expect(permPaths.some((p) => p.includes('catalog/main'))).toBe(true)
    expect(permPaths.some((p) => p.includes('schema/main.sales'))).toBe(true)
    expect(permPaths.some((p) => p.includes('schema/main.ops'))).toBe(true)
    // Filtered by the user principal so a non-admin may view it.
    expect(permPaths.every((p) => p.includes('principal=reader%40x'))).toBe(true)
  })

  it('returns writable when the pinned scope grants MODIFY', async () => {
    const table = {
      ...READONLY_TABLE,
      '/effective-permissions/': {
        privilege_assignments: [{ principal: 'reader@x', privileges: [{ privilege: 'MODIFY' }] }]
      }
    }
    expect(await checkDbxWriteCapability(fakeFetcher(table), 'main', ['sales'])).toBe('writable')
  })

  it('short-circuits to writable for an admin without fetching permissions', async () => {
    const seen: string[] = []
    const table = { '/scim/v2/Me': { userName: 'a@x', groups: [{ display: 'admins' }] } }
    const verdict = await checkDbxWriteCapability(fakeFetcher(table, seen), 'main', ['sales'])
    expect(verdict).toBe('writable')
    expect(seen.filter((p) => p.includes('/effective-permissions/'))).toHaveLength(0)
  })

  it('filters effective permissions by the applicationId for a service principal', async () => {
    const seen: string[] = []
    const table = {
      '/scim/v2/Me': { applicationId: 'AB12-CD34', displayName: 'ETL Job' },
      '/effective-permissions/': {
        privilege_assignments: [{ principal: 'ab12-cd34', privileges: [{ privilege: 'MODIFY' }] }]
      },
      '/unity-catalog/catalogs/': { owner: 'someone@x' },
      '/unity-catalog/schemas/': { owner: 'someone@x' }
    }
    const verdict = await checkDbxWriteCapability(fakeFetcher(table, seen), 'main', ['sales'])
    expect(verdict).toBe('writable')
    const permPaths = seen.filter((p) => p.includes('/effective-permissions/'))
    expect(permPaths.every((p) => p.includes('principal=ab12-cd34'))).toBe(true)
  })

  it.each([
    ['hive_metastore', ['sales']],
    ['spark_catalog', ['sales']],
    ['', ['sales']]
  ])(
    'clamps ungoverned/empty catalog %o to indeterminate without fetching',
    async (catalog, pins) => {
      const seen: string[] = []
      const verdict = await checkDbxWriteCapability(fakeFetcher({}, seen), catalog, pins)
      expect(verdict).toBe('indeterminate')
      expect(seen).toHaveLength(0)
    }
  )

  it.each([null, []])(
    'clamps a scope with no pinned schemas (%o) without fetching',
    async (pins) => {
      const seen: string[] = []
      const verdict = await checkDbxWriteCapability(fakeFetcher({}, seen), 'main', pins)
      expect(verdict).toBe('indeterminate')
      expect(seen).toHaveLength(0)
    }
  )

  it('maps a throwing fetcher (HTTP error/timeout) to indeterminate', async () => {
    const verdict = await checkDbxWriteCapability(
      vi.fn(() => Promise.reject(new Error('403'))),
      'main',
      ['sales']
    )
    expect(verdict).toBe('indeterminate')
  })

  it('maps an unidentifiable /Me to indeterminate', async () => {
    const table = { '/scim/v2/Me': { foo: 'bar' } }
    expect(await checkDbxWriteCapability(fakeFetcher(table), 'main', ['sales'])).toBe(
      'indeterminate'
    )
  })

  it('maps a 200 whose permissions body lacks the expected shape to indeterminate', async () => {
    // API drift: a successful response with no privilege_assignments array must
    // not read as "no grants → readonly" (fail open). It is unverifiable.
    const table = {
      ...READONLY_TABLE,
      '/effective-permissions/': { unexpected: 'shape' }
    }
    expect(await checkDbxWriteCapability(fakeFetcher(table), 'main', ['sales'])).toBe(
      'indeterminate'
    )
  })
})
