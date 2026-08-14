/**
 * Pure rail-section builder for the Manage Knowledge Bases mapping view.
 * Kept out of the dialog component so the clustering/labelling rules are
 * unit-testable: sections are (1) solo bases mapped to this database,
 * (2) one section per monorepo cluster — several linked bases sharing one
 * repoRoot — and (3) an "Unmapped" section of monorepo siblings linked
 * elsewhere plus schemas no base covers.
 */

import type {
  KnowledgeBaseSummary,
  KnowledgeLink,
  KnowledgeTargetGroup
} from '../../../shared/knowledge'

/** Last path segment of a repo root, for display — renderer never parses paths. */
export function repoRootName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

export interface RailItem {
  kind: 'base'
  group: KnowledgeTargetGroup
  /** Display name: base name, or subPath remainder for clustered monorepo rows. */
  label: string
  /** "→ billing" / "→ hs_accounts_customer +1"; empty scopes = legacy link. */
  mappingLabel: string
  /** Full schema list for the title tooltip. */
  mappingTitle: string
  monorepo: boolean
  neverScanned: boolean
}

export interface RailUnmappedItem {
  kind: 'unmapped'
  /** Base subPath/name, or the uncovered schema name. */
  label: string
  /** "mapped in wcap_dev" | "no code path" */
  sublabel: string
  title: string
}

export interface RailSection {
  /** "Mapped to prod" | "hs-monorepo · go/" | "Unmapped · 3" */
  header: string
  items: Array<RailItem | RailUnmappedItem>
}

/**
 * The shared first path segment of a cluster's subPaths ("go/billing",
 * "go/accounts" → "go"), or null when the members don't all sit under one.
 */
function sharedSubPathSegment(groups: KnowledgeTargetGroup[]): string | null {
  let segment: string | null = null
  for (const g of groups) {
    const sub = g.base.subPath
    if (!sub || !sub.includes('/')) return null
    const first = sub.split('/')[0]
    if (segment === null) segment = first
    else if (segment !== first) return null
  }
  return segment
}

function baseRailItem(
  group: KnowledgeTargetGroup,
  label: string,
  monorepo: boolean,
  neverScannedIds: Set<string>
): RailItem {
  const scopes = group.links.map((l) => l.schema).filter((s): s is string => !!s)
  const mappingTitle = scopes.length > 0 ? scopes.join(', ') : 'entire database'
  const mappingLabel =
    scopes.length === 0
      ? '→ entire database'
      : scopes.length === 1
        ? `→ ${scopes[0]}`
        : `→ ${scopes[0]} +${scopes.length - 1}`
  return {
    kind: 'base',
    group,
    label,
    mappingLabel,
    mappingTitle,
    monorepo,
    neverScanned: neverScannedIds.has(group.base.id)
  }
}

export function buildRailSections(args: {
  groups: KnowledgeTargetGroup[]
  /** Every base in the store, for "mapped elsewhere" rows. */
  allBases: KnowledgeBaseSummary[]
  /** The full link table, for those rows' "mapped in <db>" sublabels. */
  links: KnowledgeLink[]
  connNames: Record<string, string>
  target: { connId: string; database: string }
  schemaOptions: string[]
  /** Bases with a codebase but no agent-written records and no active job. */
  neverScannedIds: Set<string>
}): RailSection[] {
  const { groups, allBases, links, connNames, target, schemaOptions, neverScannedIds } = args

  // Cluster linked bases by shared repoRoot, mirroring the monorepo setup's
  // output (same root, differing subPath).
  const rootCount = new Map<string, number>()
  for (const g of groups) {
    if (g.base.repoRoot) {
      rootCount.set(g.base.repoRoot, (rootCount.get(g.base.repoRoot) ?? 0) + 1)
    }
  }

  const sections: RailSection[] = []
  const solo: RailItem[] = []
  const clustered = new Set<string>()
  const clusterSections: RailSection[] = []

  for (const g of groups) {
    const root = g.base.repoRoot
    if (root && (rootCount.get(root) ?? 0) > 1) {
      if (clustered.has(root)) continue
      clustered.add(root)
      const members = groups.filter((x) => x.base.repoRoot === root)
      const segment = sharedSubPathSegment(members)
      const header = segment ? `${repoRootName(root)} · ${segment}/` : repoRootName(root)
      clusterSections.push({
        header,
        items: members.map((m) => {
          const sub = m.base.subPath
          const label = sub
            ? segment && sub.startsWith(`${segment}/`)
              ? sub.slice(segment.length + 1)
              : sub
            : m.base.name
          return baseRailItem(m, label, true, neverScannedIds)
        })
      })
    } else {
      solo.push(baseRailItem(g, g.base.name, false, neverScannedIds))
    }
  }

  if (solo.length > 0) {
    sections.push({ header: `Mapped to ${target.database}`, items: solo })
  }
  sections.push(...clusterSections)

  // Unmapped, part 1: bases sharing a linked base's repoRoot (monorepo
  // siblings, or the same repo attached twice) with no link to this target.
  const unmapped: RailUnmappedItem[] = []
  const linkedIds = new Set(groups.map((g) => g.base.id))
  const linkedRoots = new Set(groups.map((g) => g.base.repoRoot).filter((r): r is string => !!r))
  for (const base of allBases) {
    if (linkedIds.has(base.id)) continue
    if (!base.repoRoot || !linkedRoots.has(base.repoRoot)) continue
    const baseLinks = links
      .filter((l) => l.kbId === base.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const first = baseLinks[0]
    if (!first) continue // orphaned base: nothing meaningful to point at
    const where =
      first.connId === target.connId
        ? first.database
        : `${connNames[first.connId] ?? first.connId} / ${first.database}`
    unmapped.push({
      kind: 'unmapped',
      label: base.subPath ?? base.name,
      sublabel: `mapped in ${where}`,
      title: `${base.name} — mapped in ${where}`
    })
  }

  // Unmapped, part 2: schemas of this database no linked base covers.
  const covered = new Set<string>()
  for (const g of groups) {
    for (const l of g.links) {
      if (l.schema) covered.add(l.schema.toLowerCase())
    }
  }
  for (const schema of schemaOptions) {
    if (covered.has(schema.toLowerCase())) continue
    unmapped.push({
      kind: 'unmapped',
      label: schema,
      sublabel: 'no code path',
      title: `No code path is mapped to ${schema}`
    })
  }

  if (unmapped.length > 0) {
    sections.push({ header: `Unmapped · ${unmapped.length}`, items: unmapped })
  }
  return sections
}
