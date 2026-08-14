import { describe, expect, it } from 'vitest'

import type {
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeTargetGroup
} from '../../../shared/knowledge'
import { buildRailSections, repoRootName } from './manageKb'

const TARGET = { connId: 'c1', database: 'prod' }

let seq = 0

function base(overrides: Partial<KnowledgeBaseSummary>): KnowledgeBaseSummary {
  seq++
  return {
    id: `kb-${seq}`,
    name: `base ${seq}`,
    repoRoot: null,
    subPath: null,
    createdAt: seq,
    updatedAt: seq,
    recordCount: 0,
    linkCount: 0,
    ...overrides
  }
}

function link(kbId: string, schema: string, overrides?: Partial<KnowledgeLink>): KnowledgeLink {
  seq++
  return {
    id: `kl-${seq}`,
    kbId,
    connId: TARGET.connId,
    database: TARGET.database,
    schema,
    createdAt: seq,
    ...overrides
  }
}

function group(b: KnowledgeBaseSummary, links: KnowledgeLink[]): KnowledgeTargetGroup {
  return { base: b, links, records: [] }
}

function build(
  groups: KnowledgeTargetGroup[],
  opts?: {
    allBases?: KnowledgeBaseSummary[]
    links?: KnowledgeLink[]
    schemaOptions?: string[]
    neverScannedIds?: Set<string>
    connNames?: Record<string, string>
  }
): ReturnType<typeof buildRailSections> {
  return buildRailSections({
    groups,
    allBases: opts?.allBases ?? groups.map((g) => ({ ...g.base, recordCount: 0, linkCount: 1 })),
    links: opts?.links ?? groups.flatMap((g) => g.links),
    connNames: opts?.connNames ?? { c1: 'prod-conn' },
    target: TARGET,
    schemaOptions: opts?.schemaOptions ?? [],
    neverScannedIds: opts?.neverScannedIds ?? new Set()
  })
}

describe('repoRootName', () => {
  it('returns the last path segment', () => {
    expect(repoRootName('/Users/x/src/hs-monorepo')).toBe('hs-monorepo')
    expect(repoRootName('C:\\src\\repo')).toBe('repo')
  })
})

describe('buildRailSections', () => {
  it('puts solo bases in a "Mapped to <database>" section', () => {
    const b = base({ name: 'wcap' })
    const sections = build([group(b, [link(b.id, 'billing')])])
    expect(sections).toHaveLength(1)
    expect(sections[0].header).toBe('Mapped to prod')
    expect(sections[0].items).toHaveLength(1)
    const item = sections[0].items[0]
    expect(item).toMatchObject({
      kind: 'base',
      label: 'wcap',
      mappingLabel: '→ billing',
      monorepo: false,
      neverScanned: false
    })
  })

  it('omits every empty section', () => {
    expect(build([])).toEqual([])
  })

  it('collapses multi-schema mappings to +n with the full list in the title', () => {
    const b = base({})
    const sections = build([group(b, [link(b.id, 'accounts'), link(b.id, 'ledger')])])
    const item = sections[0].items[0]
    expect(item).toMatchObject({
      mappingLabel: '→ accounts +1',
      mappingTitle: 'accounts, ledger'
    })
  })

  it('labels a legacy schema-less link as entire database', () => {
    const b = base({})
    const legacy: KnowledgeLink = {
      id: 'kl-legacy',
      kbId: b.id,
      connId: TARGET.connId,
      database: TARGET.database,
      createdAt: 1
    }
    const sections = build([group(b, [legacy])])
    expect(sections[0].items[0]).toMatchObject({ mappingLabel: '→ entire database' })
  })

  it('clusters monorepo bases under a repo header with shared-prefix stripping', () => {
    const root = '/src/hs-monorepo'
    const b1 = base({ name: 'billing', repoRoot: root, subPath: 'go/billing' })
    const b2 = base({ name: 'accounts', repoRoot: root, subPath: 'go/accounts' })
    const sections = build([
      group(b1, [link(b1.id, 'billing')]),
      group(b2, [link(b2.id, 'accounts')])
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0].header).toBe('hs-monorepo · go/')
    expect(sections[0].items.map((i) => i.label)).toEqual(['billing', 'accounts'])
    expect(sections[0].items[0]).toMatchObject({ kind: 'base', monorepo: true })
  })

  it('keeps full subPaths when the cluster shares no first segment', () => {
    const root = '/src/mono'
    const b1 = base({ repoRoot: root, subPath: 'go/billing' })
    const b2 = base({ repoRoot: root, subPath: 'py/accounts' })
    const sections = build([group(b1, [link(b1.id, 'a')]), group(b2, [link(b2.id, 'b')])])
    expect(sections[0].header).toBe('mono')
    expect(sections[0].items.map((i) => i.label)).toEqual(['go/billing', 'py/accounts'])
  })

  it('mixes solo and cluster sections, solo first', () => {
    const root = '/src/mono'
    const solo = base({ name: 'solo' })
    const b1 = base({ repoRoot: root, subPath: 'a' })
    const b2 = base({ repoRoot: root, subPath: 'b' })
    const sections = build([
      group(b1, [link(b1.id, 'a')]),
      group(solo, [link(solo.id, 's')]),
      group(b2, [link(b2.id, 'b')])
    ])
    expect(sections.map((s) => s.header)).toEqual(['Mapped to prod', 'mono'])
  })

  it('lists monorepo siblings linked to another database as unmapped', () => {
    const root = '/src/mono'
    const b1 = base({ repoRoot: root, subPath: 'go/billing' })
    const b2 = base({ repoRoot: root, subPath: 'go/accounts' })
    const b3 = base({ name: 'ledger-svc', repoRoot: root, subPath: 'go/ledger' })
    const elsewhere = link(b3.id, 'ledger', { database: 'wcap_dev' })
    // b1+b2 linked here (a cluster), b3 only linked to wcap_dev.
    const sections = build([group(b1, [link(b1.id, 'billing')]), group(b2, [link(b2.id, 'acc')])], {
      allBases: [b1, b2, b3],
      links: [link(b1.id, 'billing'), link(b2.id, 'acc'), elsewhere]
    })
    const unmapped = sections[sections.length - 1]
    expect(unmapped.header).toBe('Unmapped · 1')
    expect(unmapped.items[0]).toMatchObject({
      kind: 'unmapped',
      label: 'go/ledger',
      sublabel: 'mapped in wcap_dev'
    })
  })

  it('prefixes the connection name when the sibling is mapped on another connection', () => {
    const root = '/src/mono'
    const b1 = base({ repoRoot: root, subPath: 'a' })
    const b2 = base({ repoRoot: root, subPath: 'b' })
    const b3 = base({ repoRoot: root, subPath: 'c' })
    const sections = build([group(b1, [link(b1.id, 'a')]), group(b2, [link(b2.id, 'b')])], {
      allBases: [b1, b2, b3],
      links: [link(b3.id, 'x', { connId: 'c2', database: 'staging' })],
      connNames: { c1: 'prod-conn', c2: 'stage-conn' }
    })
    const unmapped = sections[sections.length - 1]
    expect(unmapped.items[0]).toMatchObject({ sublabel: 'mapped in stage-conn / staging' })
  })

  it('lists uncovered schemas as unmapped with "no code path"', () => {
    const b = base({})
    const sections = build([group(b, [link(b.id, 'billing')])], {
      schemaOptions: ['billing', 'analytics', 'audit']
    })
    const unmapped = sections[sections.length - 1]
    expect(unmapped.header).toBe('Unmapped · 2')
    expect(unmapped.items.map((i) => i.label)).toEqual(['analytics', 'audit'])
    expect(unmapped.items[0]).toMatchObject({ sublabel: 'no code path' })
  })

  it('matches schema coverage case-insensitively', () => {
    const b = base({})
    const sections = build([group(b, [link(b.id, 'Billing')])], {
      schemaOptions: ['billing']
    })
    expect(sections.some((s) => s.header.startsWith('Unmapped'))).toBe(false)
  })

  it('flags never-scanned bases', () => {
    const b = base({ repoRoot: '/src/repo' })
    const sections = build([group(b, [link(b.id, 's')])], {
      neverScannedIds: new Set([b.id])
    })
    expect(sections[0].items[0]).toMatchObject({ neverScanned: true })
  })
})
