/**
 * Wire types for the local knowledge store: shared by the main-process store
 * module, the preload bridge, the agent loop, and the renderer knowledge panel.
 * Structured-clone friendly (plain data only — no classes, no Date objects).
 *
 * The knowledge store captures what the schema alone cannot: column/table
 * annotations, a business glossary, join nuance (including polymorphic
 * relationships), exemplar question→SQL pairs, and free-form notes. Every
 * column reference lives in a structured field (never in prose) so the reverse
 * usage index can be complete.
 */

/**
 * A knowledge base is a named, free-standing collection of knowledge records —
 * typically everything learned from one code repository. It is not owned by a
 * connection: KnowledgeLink rows attach it to any number of (connection,
 * database) targets, optionally scoped to one schema. One repo backing prod /
 * staging / dev databases = one base with three links; two repos writing to
 * one database = two bases each linked to that database.
 */
export interface KnowledgeBase {
  /** `kb-${Date.now()}-${rand}` (house id pattern); doubles as the filename. */
  id: string
  name: string
  /**
   * Absolute path of the attached codebase, or null when none. Set only via
   * the main-process directory picker — never renderer-supplied.
   */
  repoRoot: string | null
  createdAt: number
  updatedAt: number
}

/** A base plus derived display fields, for list surfaces. */
export interface KnowledgeBaseSummary extends KnowledgeBase {
  recordCount: number
  /** Number of links pointing at this base (0 = orphaned). */
  linkCount: number
}

/**
 * Attaches one knowledge base to one (connection, database) target. `schema`
 * scopes the attachment to a single schema of that database — e.g. a repo's
 * base linked to the `contract_db` schema of a Databricks catalog — and is
 * surfaced to the agent as context ("this base describes schema X"); records
 * are not rewritten.
 */
export interface KnowledgeLink {
  /** `kl-${Date.now()}-${rand}`. */
  id: string
  kbId: string
  connId: string
  database: string
  /** Absent = the base applies to the whole database. */
  schema?: string
  createdAt: number
}

/** Caller-supplied fields of a link; the store mints id and createdAt. */
export interface KnowledgeLinkInput {
  kbId: string
  connId: string
  database: string
  schema?: string
}

/**
 * One linked base's contribution to a (connection, database) target: the wire
 * shape of `knowledge:listForTarget`, and what the agent prompt renders as a
 * titled knowledge section.
 */
export interface KnowledgeTargetGroup {
  base: KnowledgeBase
  link: KnowledgeLink
  records: KnowledgeRecord[]
}

/**
 * The link a target falls back to when no base is named explicitly: the
 * oldest database-wide link, else the oldest schema-scoped one. Pure and
 * shared so the main process (agent write path) and the renderer (panel
 * default selection) can never disagree. `links` must already be filtered to
 * one (connection, database) target.
 */
export function pickDefaultLink(links: KnowledgeLink[]): KnowledgeLink | null {
  const sorted = [...links].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
  return sorted.find((l) => l.schema === undefined) ?? sorted[0] ?? null
}

export type KnowledgeSource = 'human' | 'agent'

export interface ColumnRef {
  schema: string
  table: string
  /** Absent = a reference to the table itself. */
  column?: string
}

export type KnowledgeKind =
  | 'annotation' // description/caveat for a table or column
  | 'relationship' // join knowledge, incl. polymorphic
  | 'glossary' // business term -> column mappings + synonyms
  | 'exemplar' // question -> SQL pair
  | 'note' // free-form markdown

interface KnowledgeRecordBase {
  /** `kn-${Date.now()}-${rand}` (house id pattern). */
  id: string
  kind: KnowledgeKind
  source: KnowledgeSource
  /** Mainly for agent-written records. */
  confidence?: 'high' | 'medium' | 'low'
  /** e.g. repo path / file the agent derived this from. */
  provenance?: string
  createdAt: number
  updatedAt: number
}

export interface AnnotationRecord extends KnowledgeRecordBase {
  kind: 'annotation'
  target: ColumnRef
  /** markdown; short description, caveats, gotchas. */
  text: string
}

export interface RelationshipRecord extends KnowledgeRecordBase {
  kind: 'relationship'
  relType: 'standard' | 'polymorphic'
  /** column required. */
  from: ColumnRef
  /** relType === 'standard' */
  to?: ColumnRef
  /** relType === 'polymorphic' */
  discriminator?: ColumnRef
  /** discriminator value -> join target. */
  targets?: Record<string, ColumnRef>
  notes?: string
}

export interface GlossaryRecord extends KnowledgeRecordBase {
  kind: 'glossary'
  term: string
  synonyms: string[]
  definition?: string
  mappings: Array<{ ref: ColumnRef; caveat?: string }>
}

export interface ExemplarRecord extends KnowledgeRecordBase {
  kind: 'exemplar'
  question: string
  sql: string
  /** extracted at save time (see Phase 5). */
  references: ColumnRef[]
}

export interface NoteRecord extends KnowledgeRecordBase {
  kind: 'note'
  title: string
  body: string
  /**
   * REQUIRED discipline: column mentions must be mirrored here or the usage
   * index cannot see them.
   */
  references: ColumnRef[]
}

export type KnowledgeRecord =
  | AnnotationRecord
  | RelationshipRecord
  | GlossaryRecord
  | ExemplarRecord
  | NoteRecord

/**
 * A record as proposed by a caller (renderer form or agent tool). The store
 * owns identity and timestamps, so those fields are optional on input: an
 * absent `id` mints a new record, a present one that matches an existing
 * record updates it in place.
 */
type Draft<T extends KnowledgeRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
  createdAt?: number
  updatedAt?: number
}

export type KnowledgeRecordInput =
  | Draft<AnnotationRecord>
  | Draft<RelationshipRecord>
  | Draft<GlossaryRecord>
  | Draft<ExemplarRecord>
  | Draft<NoteRecord>

/**
 * Normalized key for indexing/dedup: `schema.table.column` (or `schema.table`
 * for a table-level ref), lowercased. Postgres folds unquoted identifiers to
 * lowercase and Databricks/Unity Catalog is case-insensitive, so lowercase is
 * the shared key space; the original casing is preserved in the stored
 * `ColumnRef`. Main and renderer must agree on this, hence its home here.
 */
export function normalizeColumnKey(ref: ColumnRef): string {
  const parts = ref.column ? [ref.schema, ref.table, ref.column] : [ref.schema, ref.table]
  return parts.join('.').toLowerCase()
}

/**
 * Best-effort alternate names a relation should also answer to when a
 * knowledge base spans engines with different naming conventions. Databricks
 * workspaces migrated from Postgres commonly repeat the schema name as a
 * table-name prefix (`billing.subscriptions` → `billing.billing_subscriptions`),
 * so a ref written against one engine dangles on the other. Ref-key builders
 * register these aliases alongside the real name — in both directions, since
 * the checker can't know which engine the ref was authored against:
 * the schema-prefixed form always, and the stripped form when the name
 * already carries the prefix. Aliases only widen resolution (fewer false
 * "missing from schema" warnings); suggestions and stored refs always use the
 * relation's real name.
 */
export function tableNameAliases(schema: string, table: string): string[] {
  const aliases = [`${schema}_${table}`]
  const prefix = `${schema.toLowerCase()}_`
  if (table.toLowerCase().startsWith(prefix) && table.length > prefix.length) {
    aliases.push(table.slice(prefix.length))
  }
  return aliases
}

/**
 * Deterministic, filesystem-safe slug for a database name, used as the JSON
 * filename under `knowledge/<connId>/`. Every character outside a
 * conservative safe set (`[a-z0-9_-]`) is percent-encoded from its UTF-8
 * bytes. Uppercase letters are encoded too, so names differing only in case
 * (e.g. "Sales" vs "sales") map to distinct files even on case-insensitive
 * filesystems (macOS/Windows). Handles "/", "." and unicode. Reversible in
 * principle, though the store keeps the raw name inside the file regardless.
 */
export function databaseSlug(database: string): string {
  const bytes = new TextEncoder().encode(database)
  let out = ''
  for (const byte of bytes) {
    // Safe set matches the [a-z0-9_-] bytes directly (all single-byte ASCII).
    if (
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x5f || // _
      byte === 0x2d // -
    ) {
      out += String.fromCharCode(byte)
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

/**
 * How a knowledge record touches a given column/table, for the reverse usage
 * index (Phase 4). Each role maps 1:1 to a structured ref field on some kind:
 *
 * - `annotates`          — an AnnotationRecord's `target`.
 * - `joins-from`         — a RelationshipRecord's `from` (the local side).
 * - `joins-to`           — a RelationshipRecord's `to` (standard) or any
 *                          `targets[value]` (polymorphic join target).
 * - `discriminator`      — a polymorphic RelationshipRecord's `discriminator`.
 * - `glossary-mapping`   — a GlossaryRecord `mappings[].ref`.
 * - `referenced-by-note` — a NoteRecord `references[]` entry.
 * - `used-in-exemplar`   — an ExemplarRecord `references[]` entry.
 */
export type UsageRole =
  | 'annotates'
  | 'joins-from'
  | 'joins-to'
  | 'discriminator'
  | 'glossary-mapping'
  | 'referenced-by-note'
  | 'used-in-exemplar'

/** One hit in the reverse usage index: which record, of which kind, and how. */
export interface UsageHit {
  recordId: string
  kind: KnowledgeKind
  role: UsageRole
}

/**
 * Reverse index: normalized column key (`schema.table.column`, or
 * `schema.table` for table-level refs) -> the records that reference it and in
 * what role. Structured-clone friendly values (plain objects), though the Map
 * container itself is meant for in-process use, not the wire.
 */
export type UsageIndex = Map<string, UsageHit[]>

/**
 * Build the reverse usage index from a database's knowledge records (Phase 4
 * step 1). Pure, no side effects. Every structured ref field of every known
 * kind is indexed under `normalizeColumnKey(ref)`; a table-level ref (no
 * `column`) lands under the table key. Dangling refs (pointing at columns that
 * no longer exist in the live schema) are indexed the same as any other — the
 * store never resolves refs against introspection, so it cannot tell. Records
 * of an unknown/forward-compat `kind` contribute nothing and are skipped
 * gracefully.
 */
export function buildUsageIndex(records: KnowledgeRecord[]): UsageIndex {
  const index: UsageIndex = new Map()

  const add = (ref: ColumnRef | undefined | null, kind: KnowledgeKind, role: UsageRole, id: string): void => {
    if (!ref || typeof ref.schema !== 'string' || typeof ref.table !== 'string') return
    const key = normalizeColumnKey(ref)
    const hits = index.get(key)
    const hit: UsageHit = { recordId: id, kind, role }
    if (hits) hits.push(hit)
    else index.set(key, [hit])
  }

  for (const record of records) {
    // The store filters shapeless entries on load, but this is a shared pure
    // function — never let a null/non-object entry throw on `.kind`.
    if (!record || typeof record !== 'object') continue
    switch (record.kind) {
      case 'annotation':
        add(record.target, 'annotation', 'annotates', record.id)
        break
      case 'relationship':
        add(record.from, 'relationship', 'joins-from', record.id)
        add(record.to, 'relationship', 'joins-to', record.id)
        add(record.discriminator, 'relationship', 'discriminator', record.id)
        if (record.targets) {
          for (const target of Object.values(record.targets)) {
            add(target, 'relationship', 'joins-to', record.id)
          }
        }
        break
      case 'glossary':
        if (record.mappings) {
          for (const mapping of record.mappings) {
            add(mapping?.ref, 'glossary', 'glossary-mapping', record.id)
          }
        }
        break
      case 'exemplar':
        if (record.references) {
          for (const ref of record.references) {
            add(ref, 'exemplar', 'used-in-exemplar', record.id)
          }
        }
        break
      case 'note':
        if (record.references) {
          for (const ref of record.references) {
            add(ref, 'note', 'referenced-by-note', record.id)
          }
        }
        break
      default:
        // Unknown/forward-compat kind (the loader preserves these verbatim).
        // Nothing structured to index; skip without throwing.
        break
    }
  }

  return index
}

/**
 * Look up usage hits for a ref at both the column and the table level. For a
 * column ref this returns the column's own hits followed by the enclosing
 * table's table-level hits (useful for the UI: a column's usages plus anything
 * attached to its whole table). For a table-level ref it returns just the
 * table's hits. Never returns `undefined` — an unreferenced ref yields `[]`.
 */
export function lookupUsages(index: UsageIndex, ref: ColumnRef): UsageHit[] {
  const columnHits = ref.column ? (index.get(normalizeColumnKey(ref)) ?? []) : []
  const tableHits = index.get(normalizeColumnKey({ schema: ref.schema, table: ref.table })) ?? []
  return [...columnHits, ...tableHits]
}
