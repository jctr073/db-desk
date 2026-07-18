/**
 * Foreign-key reference graph over a cached DatabaseIntrospection: real FK
 * edges read straight from introspection (ColumnInfo.fkRef), plus "logical"
 * edges inferred from naming conventions when no declared constraint exists:
 *
 *   Convention 1 — pk table customers(id)          -> columns named customer_id
 *   Convention 2 — pk table customers(customer_id) -> columns named customer_id
 *
 * Inference is best-effort by design: exact name matches only, single-column
 * primary keys only, and both ends must share a coarse type family. Pure over
 * the introspection data so the tree badges, the references popover, and unit
 * tests share one implementation.
 */

import type { DatabaseIntrospection, RelationInfo } from '../../../shared/db'

export type RelationKind = 'table' | 'view' | 'matview'
export type ReferenceKind = 'fk' | 'lfk'

export interface ColumnEndpoint {
  schema: string
  table: string
  column: string
}

export interface ReferenceEdge {
  kind: ReferenceKind
  from: ColumnEndpoint
  /** What kind of relation the referencing column lives in. */
  fromRelationKind: RelationKind
  to: ColumnEndpoint
}

export interface ReferenceIndex {
  edges: ReferenceEdge[]
  /** Inferred target ("schema.table.column") per source column key, for LFK badges. */
  logicalRefs: Map<string, string>
}

export interface ReferenceLists {
  /** Edges pointing away from the subject (it references …). */
  outbound: ReferenceEdge[]
  /** Edges pointing at the subject (… referenced by). */
  inbound: ReferenceEdge[]
}

export interface NamePeer {
  endpoint: ColumnEndpoint
  relationKind: RelationKind
}

export type ColumnPeers =
  | { kind: 'semantic'; peers: ReferenceEdge[] }
  | { kind: 'name'; peers: NamePeer[] }
  | { kind: null; peers: [] }

/** Map key for a column; NUL-joined so dots in names can't collide. */
export function columnKey(schema: string, table: string, column: string): string {
  return `${schema}\u0000${table}\u0000${column}`
}

/**
 * Plurals no suffix rule can reach, plus words that shouldn't be inflected
 * (a `data` table conventionally keys `data_id`, not `datum_id`).
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  geese: 'goose',
  mice: 'mouse',
  oxen: 'ox',
  indices: 'index',
  vertices: 'vertex',
  matrices: 'matrix',
  analyses: 'analysis',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  data: 'data',
  media: 'media',
  metadata: 'metadata',
  series: 'series',
  species: 'species'
}

/**
 * Best-effort singular stems for a table name, applied to the last
 * underscore-separated word ("order_statuses" -> "order_status"). Ambiguous
 * suffixes yield several candidates (e.g. "cases" -> case, cas); matching
 * against real column names filters the nonsense, so bad guesses are harmless.
 */
export function singularStems(tableName: string): string[] {
  const name = tableName.toLowerCase()
  const cut = name.lastIndexOf('_')
  const prefix = cut >= 0 ? name.slice(0, cut + 1) : ''
  const last = cut >= 0 ? name.slice(cut + 1) : name
  const stems = new Set<string>([name])
  const irregular = IRREGULAR_PLURALS[last]
  if (irregular !== undefined) {
    stems.add(prefix + irregular)
  } else {
    if (last.endsWith('ies') && last.length > 3) stems.add(prefix + last.slice(0, -3) + 'y')
    if (last.endsWith('es') && last.length > 2) stems.add(prefix + last.slice(0, -2))
    if (last.endsWith('s') && !last.endsWith('ss')) stems.add(prefix + last.slice(0, -1))
  }
  return [...stems]
}

const TYPE_FAMILY: Record<string, string> = {
  smallint: 'int',
  int2: 'int',
  integer: 'int',
  int: 'int',
  int4: 'int',
  bigint: 'int',
  int8: 'int',
  smallserial: 'int',
  serial: 'int',
  bigserial: 'int',
  oid: 'int',
  uuid: 'uuid',
  text: 'text',
  'character varying': 'text',
  varchar: 'text',
  character: 'text',
  char: 'text',
  bpchar: 'text',
  citext: 'text',
  numeric: 'numeric',
  decimal: 'numeric'
}

/** Coarse type family; a logical pair must sit in one family (int ≠ uuid ≠ text). */
export function typeFamily(dataType: string): string {
  const base = dataType
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return TYPE_FAMILY[base] ?? base
}

/** Parse a ColumnInfo.fkRef ("schema.table.column"); null when malformed. */
export function parseFkRef(fkRef: string): ColumnEndpoint | null {
  const parts = fkRef.split('.')
  if (parts.length < 3) return null
  const column = parts.pop() as string
  const table = parts.pop() as string
  return { schema: parts.join('.'), table, column }
}

interface PkTarget extends ColumnEndpoint {
  family: string
}

export function buildReferenceIndex(db: DatabaseIntrospection): ReferenceIndex {
  // Candidate referencing-column name -> the single-column-PK tables it names.
  const candidates = new Map<string, PkTarget[]>()
  for (const schema of db.schemas) {
    for (const table of schema.tables) {
      const pks = table.columns.filter((col) => col.badge === 'pk')
      if (pks.length !== 1) continue // composite or missing PK: skip inference
      const pk = pks[0]
      // Convention 2 with a pk literally named "id" would match every id
      // column in the database, so it only applies to distinctive pk names.
      const names =
        pk.name.toLowerCase() === 'id'
          ? singularStems(table.name).map((stem) => `${stem}_id`)
          : [pk.name.toLowerCase()]
      const target: PkTarget = {
        schema: schema.name,
        table: table.name,
        column: pk.name,
        family: typeFamily(pk.dataType)
      }
      for (const name of new Set(names)) {
        const list = candidates.get(name)
        if (list) list.push(target)
        else candidates.set(name, [target])
      }
    }
  }

  const edges: ReferenceEdge[] = []
  const logicalRefs = new Map<string, string>()
  for (const schema of db.schemas) {
    const groups: Array<[RelationKind, RelationInfo[]]> = [
      ['table', schema.tables],
      ['view', schema.views],
      ['matview', schema.matviews]
    ]
    for (const [relationKind, relations] of groups) {
      for (const rel of relations) {
        for (const col of rel.columns) {
          const from: ColumnEndpoint = {
            schema: schema.name,
            table: rel.name,
            column: col.name
          }
          const declared = col.fkRef ? parseFkRef(col.fkRef) : null
          if (declared) {
            // A declared FK beats convention for the same column.
            edges.push({ kind: 'fk', from, fromRelationKind: relationKind, to: declared })
            continue
          }
          const targets = candidates.get(col.name.toLowerCase())
          if (!targets) continue
          const family = typeFamily(col.dataType)
          for (const target of targets) {
            // A table never logically references its own PK (convention 2
            // would otherwise match the pk column against itself).
            if (target.schema === from.schema && target.table === from.table) continue
            if (target.family !== family) continue
            const to = { schema: target.schema, table: target.table, column: target.column }
            edges.push({ kind: 'lfk', from, fromRelationKind: relationKind, to })
            const key = columnKey(from.schema, from.table, from.column)
            if (!logicalRefs.has(key)) {
              logicalRefs.set(key, `${to.schema}.${to.table}.${to.column}`)
            }
          }
        }
      }
    }
  }
  return { edges, logicalRefs }
}

/** Edges touching one column, in both directions. */
export function columnReferences(index: ReferenceIndex, ref: ColumnEndpoint): ReferenceLists {
  const matches = (end: ColumnEndpoint): boolean =>
    end.schema === ref.schema && end.table === ref.table && end.column === ref.column
  return {
    outbound: index.edges.filter((edge) => matches(edge.from)),
    inbound: index.edges.filter((edge) => matches(edge.to))
  }
}

/** Edges touching any column of one relation, in both directions. */
export function tableReferences(
  index: ReferenceIndex,
  schema: string,
  table: string
): ReferenceLists {
  const matches = (end: ColumnEndpoint): boolean => end.schema === schema && end.table === table
  return {
    outbound: index.edges.filter((edge) => matches(edge.from)),
    inbound: index.edges.filter((edge) => matches(edge.to))
  }
}

function sameEndpoint(a: ColumnEndpoint, b: ColumnEndpoint): boolean {
  return a.schema === b.schema && a.table === b.table && a.column === b.column
}

/**
 * Other source columns that resolve to one of the subject column's targets.
 * The returned edges retain their FK/LFK kind for display in the popover.
 */
export function semanticPeers(index: ReferenceIndex, subject: ColumnEndpoint): ReferenceEdge[] {
  const targets = index.edges
    .filter((edge) => sameEndpoint(edge.from, subject))
    .map((edge) => edge.to)

  if (targets.length === 0) return []
  return index.edges.filter(
    (edge) =>
      !sameEndpoint(edge.from, subject) && targets.some((target) => sameEndpoint(edge.to, target))
  )
}

/** Names too universal to make useful peers, regardless of database prevalence. */
const NAME_PEER_STOPLIST = new Set([
  'id',
  'name',
  'created_at',
  'updated_at',
  'deleted_at',
  'status',
  'type',
  'description'
])

const NAME_PEER_PREVALENCE_CUTOFF = 0.3

/**
 * Same-name, same-type-family columns across the database. This is intentionally
 * independent of the edge graph; columnPeers applies the no-target fallback rule.
 */
export function nameBasedPeers(db: DatabaseIntrospection, subject: ColumnEndpoint): NamePeer[] {
  const subjectName = subject.column.toLowerCase()
  if (NAME_PEER_STOPLIST.has(subjectName)) return []

  let subjectFamily: string | null = null
  let relationCount = 0
  let relationsWithName = 0
  const candidates: Array<NamePeer & { family: string }> = []

  for (const schema of db.schemas) {
    const groups: Array<[RelationKind, RelationInfo[]]> = [
      ['table', schema.tables],
      ['view', schema.views],
      ['matview', schema.matviews]
    ]
    for (const [relationKind, relations] of groups) {
      for (const relation of relations) {
        relationCount += 1
        const matchingColumns = relation.columns.filter(
          (column) => column.name.toLowerCase() === subjectName
        )
        if (matchingColumns.length > 0) relationsWithName += 1

        for (const column of matchingColumns) {
          const endpoint = {
            schema: schema.name,
            table: relation.name,
            column: column.name
          }
          const family = typeFamily(column.dataType)
          if (sameEndpoint(endpoint, subject)) subjectFamily = family
          else candidates.push({ endpoint, relationKind, family })
        }
      }
    }
  }

  if (
    subjectFamily === null ||
    relationCount === 0 ||
    relationsWithName / relationCount > NAME_PEER_PREVALENCE_CUTOFF
  ) {
    return []
  }

  return candidates
    .filter((candidate) => candidate.family === subjectFamily)
    .map(({ endpoint, relationKind }) => ({ endpoint, relationKind }))
}

/**
 * Resolve peers with strict precedence: a resolved target permits semantic
 * peers only; name matching is a fallback exclusively for targetless columns.
 */
export function columnPeers(
  index: ReferenceIndex,
  db: DatabaseIntrospection,
  subject: ColumnEndpoint
): ColumnPeers {
  const hasTarget = index.edges.some((edge) => sameEndpoint(edge.from, subject))
  if (hasTarget) {
    const peers = semanticPeers(index, subject)
    return peers.length > 0 ? { kind: 'semantic', peers } : { kind: null, peers: [] }
  }

  const peers = nameBasedPeers(db, subject)
  return peers.length > 0 ? { kind: 'name', peers } : { kind: null, peers: [] }
}
