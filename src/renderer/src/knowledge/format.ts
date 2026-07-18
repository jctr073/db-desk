/**
 * Pure display helpers for the knowledge panel: ref formatting/parsing, record
 * list titles, search text, dangling-ref detection, and the human-readable
 * summaries shown for "Show usages" hits. Kept free of React and IPC so every
 * helper is unit-testable from test/unit.
 */

import type { DatabaseIntrospection } from '../../../shared/db'
import { normalizeColumnKey, tableNameAliases } from '../../../shared/knowledge'
import type {
  ColumnRef,
  KnowledgeKind,
  KnowledgeRecord,
  RelationshipRecord,
  UsageHit
} from '../../../shared/knowledge'

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  annotation: 'Annotation',
  relationship: 'Relationship',
  glossary: 'Glossary',
  exemplar: 'Exemplar',
  note: 'Note'
}

/** Group/list order for kinds — join rules are the highest-stakes knowledge. */
export const KIND_ORDER: KnowledgeKind[] = [
  'relationship',
  'glossary',
  'annotation',
  'exemplar',
  'note'
]

/** True for the record kinds this UI knows how to render (forward compat). */
export function isKnownKind(kind: string): kind is KnowledgeKind {
  return kind in KIND_LABELS
}

export function formatRef(ref: ColumnRef): string {
  return ref.column ? `${ref.schema}.${ref.table}.${ref.column}` : `${ref.schema}.${ref.table}`
}

/** Parse "schema.table" or "schema.table.column" text into a ColumnRef. */
export function parseRefText(text: string): ColumnRef | null {
  const parts = text.trim().split('.')
  if (parts.length < 2 || parts.length > 3) return null
  if (parts.some((part) => !part.trim())) return null
  const [schema, table, column] = parts.map((part) => part.trim())
  return column ? { schema, table, column } : { schema, table }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One-line title for a record in the panel's list view. */
export function recordTitle(record: KnowledgeRecord): string {
  switch (record.kind) {
    case 'annotation':
      return `${formatRef(record.target)} — ${truncate(record.text, 60)}`
    case 'relationship': {
      if (record.relType === 'polymorphic') {
        const count = Object.keys(record.targets ?? {}).length
        return `${formatRef(record.from)} → ${count} polymorphic target${count === 1 ? '' : 's'}`
      }
      return `${formatRef(record.from)} → ${record.to ? formatRef(record.to) : '?'}`
    }
    case 'glossary':
      return record.term
    case 'exemplar':
      return truncate(record.question, 70)
    case 'note':
      return record.title
    default:
      // Unknown/forward-compat kind: the loader preserves these verbatim and
      // the list filters them out, but never crash if one leaks through.
      return (record as { kind: string }).kind
  }
}

/** Lowercased haystack for the panel's free-text filter. */
export function recordSearchText(record: KnowledgeRecord): string {
  const parts: string[] = [record.kind, record.source]
  const pushRef = (ref: ColumnRef | undefined | null): void => {
    if (ref) parts.push(formatRef(ref))
  }
  switch (record.kind) {
    case 'annotation':
      pushRef(record.target)
      parts.push(record.text)
      break
    case 'relationship':
      pushRef(record.from)
      pushRef(record.to)
      pushRef(record.discriminator)
      for (const [value, target] of Object.entries(record.targets ?? {})) {
        parts.push(value)
        pushRef(target)
      }
      if (record.notes) parts.push(record.notes)
      break
    case 'glossary':
      parts.push(record.term, ...(record.synonyms ?? []))
      if (record.definition) parts.push(record.definition)
      for (const mapping of record.mappings ?? []) {
        pushRef(mapping?.ref)
        if (mapping?.caveat) parts.push(mapping.caveat)
      }
      break
    case 'exemplar':
      parts.push(record.question, record.sql)
      for (const ref of record.references ?? []) pushRef(ref)
      break
    case 'note':
      parts.push(record.title, record.body)
      for (const ref of record.references ?? []) pushRef(ref)
      break
  }
  return parts.join(' ').toLowerCase()
}

/** Every structured column ref carried by a record (for dangling checks). */
export function recordRefs(record: KnowledgeRecord): ColumnRef[] {
  switch (record.kind) {
    case 'annotation':
      return record.target ? [record.target] : []
    case 'relationship': {
      const out: ColumnRef[] = []
      if (record.from) out.push(record.from)
      if (record.to) out.push(record.to)
      if (record.discriminator) out.push(record.discriminator)
      for (const target of Object.values(record.targets ?? {})) out.push(target)
      return out
    }
    case 'glossary':
      return (record.mappings ?? []).flatMap((m) => (m?.ref ? [m.ref] : []))
    case 'exemplar':
      return record.references ?? []
    case 'note':
      return record.references ?? []
    default:
      return []
  }
}

/**
 * Every valid normalized ref key (`schema.table` and `schema.table.column`)
 * in an introspection, across tables, views, and materialized views. Refs
 * missing from this set are dangling — rendered with a warning, never deleted.
 * Each relation also registers its `tableNameAliases`, so a base linked to
 * both a Postgres database and a Databricks catalog resolves refs across the
 * schema-prefix naming convention instead of warning on every record.
 */
export function buildRefKeySet(intro: DatabaseIntrospection): Set<string> {
  const keys = new Set<string>()
  for (const schema of intro.schemas) {
    for (const rel of [...schema.tables, ...schema.views, ...schema.matviews]) {
      for (const table of [rel.name, ...tableNameAliases(schema.name, rel.name)]) {
        keys.add(normalizeColumnKey({ schema: schema.name, table }))
        for (const col of rel.columns) {
          keys.add(normalizeColumnKey({ schema: schema.name, table, column: col.name }))
        }
      }
    }
  }
  return keys
}

/** The record's refs that are missing from the current introspection. */
export function danglingRefs(record: KnowledgeRecord, validKeys: Set<string>): ColumnRef[] {
  return recordRefs(record).filter((ref) => !validKeys.has(normalizeColumnKey(ref)))
}

/** Discriminator values whose polymorphic join target is the given ref. */
function polymorphicValuesFor(record: RelationshipRecord, ref: ColumnRef): string[] {
  const key = normalizeColumnKey(ref)
  return Object.entries(record.targets ?? {})
    .filter(([, target]) => normalizeColumnKey(target) === key)
    .map(([value]) => value)
}

/**
 * Human-readable one-liner for a usage hit against `ref`, e.g. "Polymorphic
 * join target of events.subject_id when subject_type = 'patient'". Falls back
 * to a generic phrase when the record is missing or of an unexpected kind.
 */
export function summarizeUsage(
  hit: UsageHit,
  record: KnowledgeRecord | undefined,
  ref: ColumnRef
): string {
  switch (hit.role) {
    case 'annotates':
      return record?.kind === 'annotation'
        ? `Annotated: “${truncate(record.text, 80)}”`
        : 'Annotated'
    case 'joins-from': {
      if (record?.kind !== 'relationship') return 'Join source'
      if (record.relType === 'polymorphic') {
        const disc = record.discriminator ? formatRef(record.discriminator) : 'a discriminator'
        return `Polymorphic join source — target depends on ${disc}`
      }
      return record.to ? `Joins to ${formatRef(record.to)}` : 'Join source'
    }
    case 'joins-to': {
      if (record?.kind !== 'relationship') return 'Join target'
      if (record.relType === 'polymorphic') {
        const values = polymorphicValuesFor(record, ref)
        const disc = record.discriminator ? formatRef(record.discriminator) : 'the discriminator'
        const when = values.length
          ? ` when ${disc} = ${values.map((v) => `'${v}'`).join(' or ')}`
          : ''
        return `Polymorphic join target of ${formatRef(record.from)}${when}`
      }
      return `Join target of ${formatRef(record.from)}`
    }
    case 'discriminator':
      return record?.kind === 'relationship'
        ? `Discriminator for the polymorphic join from ${formatRef(record.from)}`
        : 'Polymorphic join discriminator'
    case 'glossary-mapping': {
      if (record?.kind !== 'glossary') return 'Glossary mapping'
      const key = normalizeColumnKey(ref)
      const mapping = (record.mappings ?? []).find(
        (m) => m?.ref && normalizeColumnKey(m.ref) === key
      )
      return mapping?.caveat
        ? `Maps the term “${record.term}” — ${truncate(mapping.caveat, 60)}`
        : `Maps the term “${record.term}”`
    }
    case 'used-in-exemplar':
      return record?.kind === 'exemplar'
        ? `Used by exemplar “${truncate(record.question, 70)}”`
        : 'Used in an exemplar'
    case 'referenced-by-note':
      return record?.kind === 'note'
        ? `Referenced by note “${truncate(record.title, 70)}”`
        : 'Referenced by a note'
  }
}

/**
 * Qualified name suggestions ("schema.table" and "schema.table.column") from
 * the introspection matching a substring filter, capped for the dropdown.
 */
export function refSuggestions(
  intro: DatabaseIntrospection | undefined,
  filter: string,
  limit = 50
): string[] {
  if (!intro) return []
  const q = filter.trim().toLowerCase()
  const out: string[] = []
  for (const schema of intro.schemas) {
    for (const rel of [...schema.tables, ...schema.views, ...schema.matviews]) {
      const relName = `${schema.name}.${rel.name}`
      if (!q || relName.toLowerCase().includes(q)) {
        out.push(relName)
        if (out.length >= limit) return out
      }
      for (const col of rel.columns) {
        const colName = `${relName}.${col.name}`
        if (!q || colName.toLowerCase().includes(q)) {
          out.push(colName)
          if (out.length >= limit) return out
        }
      }
    }
  }
  return out
}
