/**
 * Local knowledge: rendering the "## Local knowledge" system-prompt section,
 * the search_knowledge and save_knowledge tool executors, and the shared
 * rendering/search helpers they use.
 *
 * The knowledge store is app-local: rendering it into the prompt and
 * searching it never touches the warehouse, so these helpers carry no
 * access-mode gate. Knowledge is organized as free-standing bases linked to
 * (connection, database) targets; a turn reads the union of every base
 * linked to its target and writes to one "active" base (see
 * resolveActiveKbId). Records are read fresh from the store on every prompt
 * build (they are small), so saves and deletes take effect on the very next
 * turn with no cache to invalidate — unlike the schema summary, which is
 * introspection-priced and cached in agent.ts's schemaCache.
 */

import type Anthropic from '@anthropic-ai/sdk'

import {
  addLink,
  createBase,
  defaultKbForTarget,
  groupsForTarget,
  linksForTarget,
  saveRecord,
  validateKnowledgeRecord
} from '../knowledge'
import { getConnectionType } from '../db'
import type { AgentSendRequest, AgentTargetRef } from '../../shared/agent'
import { normalizeColumnKey } from '../../shared/knowledge'
import type {
  AnnotationRecord,
  ColumnRef,
  ExemplarRecord,
  GlossaryRecord,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeRecordInput,
  NoteRecord,
  RelationshipRecord
} from '../../shared/knowledge'
import { dialectFor } from '../../shared/dialect'
import { liveRefKeys } from '../agent'
import { describeError, toolError } from './executors'
import type { Sender } from './executors'

/** Cap on the local-knowledge section embedded in the system prompt. */
export const KNOWLEDGE_SUMMARY_MAX_CHARS = 16_000
/** Cap on hits one search_knowledge call returns to the model. */
const KNOWLEDGE_SEARCH_MAX_HITS = 20
/** Per-hit cap on the rendered record text in a search_knowledge payload. */
const KNOWLEDGE_HIT_MAX_CHARS = 1_000

/**
 * The base a turn writes to (save_knowledge) and reads its codebase from
 * (repo tools). A renderer-supplied `target.kbId` is honored only when that
 * base is actually linked to the target — anything else fails closed to the
 * target's default linked base (same trust model as the repo flag). Null when
 * the target has no linked bases at all.
 */
export function resolveActiveKbId(target: AgentTargetRef): string | null {
  if (target.kbId) {
    const linked = linksForTarget(target.connId, target.database).some(
      (l) => l.kbId === target.kbId
    )
    if (linked) return target.kbId
  }
  return defaultKbForTarget(target.connId, target.database)
}

/** Union of records across every base linked to the target — what
 * search_knowledge and describe_table consult. */
export function allRecordsForTarget(target: AgentTargetRef): KnowledgeRecord[] {
  return groupsForTarget(target.connId, target.database).flatMap((g) => g.records)
}

/** The five kinds this build renders; unknown kinds are preserved on disk but skipped here. */
const KNOWN_KNOWLEDGE_KINDS = new Set<string>([
  'relationship',
  'glossary',
  'annotation',
  'exemplar',
  'note'
])

/**
 * Containment for every single-line interpolation of record content into the
 * prompt/tool output: newlines and control characters collapse to a space so
 * a field can never fabricate its own lines (fake headings, list items) —
 * knowledge records persist across conversations, so an uncontained field
 * would turn a one-time data-level injection into a durable prompt injection.
 * Tolerates non-strings (hand-edited files) rather than crashing the build.
 */
export function singleLine(text: unknown): string {
  if (typeof text !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- filtering control chars is the point
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
}

/** `schema.table` or `schema.table.column`, as prompt/search display text. */
function refName(ref: ColumnRef | undefined): string {
  if (!ref || typeof ref.schema !== 'string' || typeof ref.table !== 'string') {
    return '(invalid ref)'
  }
  return singleLine(
    ref.column ? `${ref.schema}.${ref.table}.${ref.column}` : `${ref.schema}.${ref.table}`
  )
}

/** Provenance marker so the model can weigh agent-inferred records. */
function sourceTag(rec: KnowledgeRecord): string {
  if (rec.source !== 'agent') return ''
  return rec.confidence ? ` [agent-recorded, ${rec.confidence} confidence]` : ' [agent-recorded]'
}

/**
 * Citation marker appended to each record rendered for the model, so it can
 * cite the records that shaped an answer by writing the tag back in prose
 * (the renderer turns `[kb:id]` into a link to the record). Omitted in the
 * 'terms' degradation tier, where every character competes with real content.
 */
function idTag(rec: KnowledgeRecord): string {
  return ` [kb:${singleLine(rec.id)}]`
}

function quoteValue(value: string): string {
  return `'${singleLine(value).replace(/'/g, "''")}'`
}

/** Continuation lines of a multi-line value stay inside the list item. */
function indentBlock(text: unknown, prefix: string): string {
  const s = typeof text === 'string' ? text : ''
  return s.replace(/\r\n?/g, '\n').split('\n').join(`\n${prefix}`)
}

/**
 * One relationship as an explicit join instruction. Polymorphic joins spell
 * out every discriminator value → target pair and end with the warning the
 * model must not lose, e.g.: "public.events.subject_id joins to
 * public.patients.id when public.events.subject_type = 'patient', to
 * public.providers.id when 'provider'. Never join without filtering the
 * discriminator."
 */
function renderRelationship(rel: RelationshipRecord, withNotes: boolean): string {
  const notes = withNotes && rel.notes ? ` ${singleLine(rel.notes)}` : ''
  if (rel.relType === 'polymorphic' && rel.discriminator && rel.targets) {
    const disc = refName(rel.discriminator)
    const cases = Object.entries(rel.targets).map(([value, target], i) =>
      i === 0
        ? `to ${refName(target)} when ${disc} = ${quoteValue(value)}`
        : `to ${refName(target)} when ${quoteValue(value)}`
    )
    return `${refName(rel.from)} joins ${cases.join(', ')}. Never join without filtering the discriminator.${notes}`
  }
  const to = rel.to ? refName(rel.to) : '(target unspecified)'
  return `${refName(rel.from)} joins to ${to}.${notes}`
}

function renderGlossaryTerm(g: GlossaryRecord, detail: KnowledgeDetail): string {
  const synonyms = (g.synonyms ?? []).map(singleLine)
  const term = singleLine(g.term)
  const aka = synonyms.length > 0 ? ` (aka ${synonyms.join(', ')})` : ''
  if (detail === 'terms') return `- ${term}${aka}`
  const maps = (g.mappings ?? [])
    .map((m) => `${refName(m?.ref)}${m?.caveat ? ` (${singleLine(m.caveat)})` : ''}`)
    .join(', ')
  const def = g.definition ? `${singleLine(g.definition)}${maps ? ' — ' : ''}` : ''
  return `- ${term}${aka}: ${def}${maps ? `maps to ${maps}` : ''}${sourceTag(g)}`
}

/**
 * Degradation tiers for the prompt section, mirroring SchemaDetail: 'full' =
 * everything; 'no-note-bodies' = notes shrink to titles; 'no-exemplar-sql' =
 * exemplars additionally shrink to their questions; 'terms' = every record is
 * one compact line (titles/terms/targets only — join rules stay explicit
 * because they are the highest-stakes content).
 */
type KnowledgeDetail = 'full' | 'no-note-bodies' | 'no-exemplar-sql' | 'terms'

function renderKnowledge(records: KnowledgeRecord[], detail: KnowledgeDetail): string {
  const dropNoteBodies = detail !== 'full'
  const dropExemplarSql = detail === 'no-exemplar-sql' || detail === 'terms'
  const terms = detail === 'terms'

  const relationships = records.filter((r): r is RelationshipRecord => r.kind === 'relationship')
  const glossary = records.filter((r): r is GlossaryRecord => r.kind === 'glossary')
  const annotations = records.filter((r): r is AnnotationRecord => r.kind === 'annotation')
  const exemplars = records.filter((r): r is ExemplarRecord => r.kind === 'exemplar')
  const notes = records.filter((r): r is NoteRecord => r.kind === 'note')
  if (
    relationships.length +
      glossary.length +
      annotations.length +
      exemplars.length +
      notes.length ===
    0
  ) {
    return ''
  }

  const lines: string[] = []
  if (relationships.length > 0) {
    lines.push('', 'Relationships (join rules):')
    for (const rel of relationships) {
      const tags = terms ? '' : `${sourceTag(rel)}${idTag(rel)}`
      lines.push(`- ${renderRelationship(rel, !terms)}${tags}`)
    }
  }
  if (glossary.length > 0) {
    lines.push('', 'Glossary:')
    for (const g of glossary) {
      lines.push(`${renderGlossaryTerm(g, detail)}${terms ? '' : idTag(g)}`)
    }
  }
  if (annotations.length > 0) {
    lines.push('', 'Annotations:')
    for (const a of annotations) {
      lines.push(
        terms
          ? `- ${refName(a.target)}`
          : `- ${refName(a.target)}: ${indentBlock(a.text, '  ')}${sourceTag(a)}${idTag(a)}`
      )
    }
  }
  if (exemplars.length > 0) {
    lines.push('', 'Exemplar queries (question → SQL):')
    for (const e of exemplars) {
      if (dropExemplarSql) {
        lines.push(`- Q: ${singleLine(e.question)}`)
      } else {
        lines.push(
          `- Q: ${singleLine(e.question)}${sourceTag(e)}${idTag(e)}`,
          `  SQL: ${indentBlock(e.sql, '  ')}`
        )
      }
    }
  }
  if (notes.length > 0) {
    lines.push('', 'Notes:')
    for (const n of notes) {
      if (dropNoteBodies) {
        lines.push(`- ${singleLine(n.title)}`)
      } else {
        lines.push(
          `- ${singleLine(n.title)}: ${indentBlock(n.body, '  ')}${sourceTag(n)}${idTag(n)}`
        )
        if ((n.references ?? []).length > 0) {
          lines.push(`  [refs: ${n.references.map(refName).join(', ')}]`)
        }
      }
    }
  }
  // Sections above each push a leading '' separator; drop the first one so a
  // group body never starts with a blank line under its heading.
  return lines.join('\n').replace(/^\n+/, '')
}

/** One linked base's contribution to the prompt section: its display name,
 * the schema scopes of its links, and records. */
export interface KnowledgePromptGroup {
  name: string
  schemas: string[]
  records: KnowledgeRecord[]
}

/**
 * The "## Local knowledge" prompt section: one titled subsection per linked
 * base, degrading tier by tier under the shared budget instead of cutting
 * mid-text (mirror of summarizeSchema). The link's schema scopes are surfaced
 * as context on its subsection — records are presented as recorded, never
 * rewritten. Empty bases render nothing; no non-empty base renders nothing.
 * Exported for unit tests.
 */
export function summarizeKnowledge(groups: KnowledgePromptGroup[]): string {
  const render = (detail: KnowledgeDetail): string => {
    const sections: string[] = []
    for (const group of groups) {
      const body = renderKnowledge(group.records, detail)
      if (body === '') continue
      const schemas = group.schemas.filter((s) => typeof s === 'string' && s !== '')
      const scopeNames = schemas.map((s) => `"${singleLine(s)}"`).join(', ')
      const scope =
        schemas.length > 0
          ? `\nThis knowledge base describes the ${scopeNames} schema${schemas.length === 1 ? '' : 's'} of this database. Its records may name schemas as they exist in the source codebase's own engine — map them onto ${scopeNames} here.`
          : ''
      sections.push(`### Knowledge base: ${singleLine(group.name)}${scope}\n${body}`)
    }
    if (sections.length === 0) return ''
    return [
      '## Local knowledge',
      'Knowledge recorded locally in DB Desk by the user and past agent sessions — business meaning and join rules the database catalog does not carry. Trust it when writing queries.',
      '',
      sections.join('\n\n')
    ].join('\n')
  }
  const full = render('full')
  if (full === '') return ''
  if (full.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) return full
  const abridgedNote =
    '\n(local knowledge abridged to fit context — use search_knowledge to retrieve full entries)'
  for (const detail of ['no-note-bodies', 'no-exemplar-sql'] as const) {
    const rendered = render(detail)
    if (rendered.length + abridgedNote.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) {
      return rendered + abridgedNote
    }
  }
  const minimal = render('terms')
  if (minimal.length + abridgedNote.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) {
    return minimal + abridgedNote
  }
  return minimal.slice(0, KNOWLEDGE_SUMMARY_MAX_CHARS - abridgedNote.length) + abridgedNote
}

/** Every structured column reference a record carries, in a stable order. */
function knowledgeRefs(rec: KnowledgeRecord): ColumnRef[] {
  switch (rec.kind) {
    case 'annotation':
      return [rec.target]
    case 'relationship': {
      const refs: ColumnRef[] = []
      if (rec.from) refs.push(rec.from)
      if (rec.to) refs.push(rec.to)
      if (rec.discriminator) refs.push(rec.discriminator)
      if (rec.targets) refs.push(...Object.values(rec.targets))
      return refs
    }
    case 'glossary':
      return (rec.mappings ?? []).flatMap((m) => (m?.ref ? [m.ref] : []))
    case 'exemplar':
      return rec.references ?? []
    case 'note':
      return rec.references ?? []
    default:
      return []
  }
}

/** Lowercased searchable text: record prose plus every ref's name parts. */
function knowledgeHaystack(rec: KnowledgeRecord): string {
  const texts: string[] = []
  switch (rec.kind) {
    case 'annotation':
      texts.push(rec.text)
      break
    case 'relationship':
      if (rec.notes) texts.push(rec.notes)
      if (rec.targets) texts.push(...Object.keys(rec.targets))
      break
    case 'glossary':
      texts.push(rec.term, ...(rec.synonyms ?? []))
      if (rec.definition) texts.push(rec.definition)
      for (const m of rec.mappings ?? []) if (m?.caveat) texts.push(m.caveat)
      break
    case 'exemplar':
      texts.push(rec.question, rec.sql)
      break
    case 'note':
      texts.push(rec.title, rec.body)
      break
  }
  for (const ref of knowledgeRefs(rec)) {
    texts.push(ref.schema, ref.table)
    if (ref.column) texts.push(ref.column)
  }
  return texts.join('\n').toLowerCase()
}

/** Full one-record rendering for a search hit, capped per hit. */
function knowledgeHitSummary(rec: KnowledgeRecord): string {
  let text: string
  switch (rec.kind) {
    case 'annotation':
      text = `${refName(rec.target)}: ${rec.text}`
      break
    case 'relationship':
      text = renderRelationship(rec, true)
      break
    case 'glossary':
      text = renderGlossaryTerm(rec, 'full').replace(/^- /, '')
      break
    case 'exemplar':
      text = `Q: ${singleLine(rec.question)}\nSQL: ${rec.sql}`
      break
    case 'note':
      text = `${singleLine(rec.title)}: ${rec.body}`
      break
    default:
      text = ''
  }
  return text.length > KNOWLEDGE_HIT_MAX_CHARS ? `${text.slice(0, KNOWLEDGE_HIT_MAX_CHARS)}…` : text
}

/**
 * One search_knowledge hit. The id matters: the agent write path updates
 * existing records by id, and search_knowledge is where the model gets them.
 */
export interface KnowledgeSearchHit {
  id: string
  kind: KnowledgeKind
  refs: ColumnRef[]
  summary: string
}

/**
 * Case-insensitive keyword search (every whitespace-separated keyword must
 * match) over record text — glossary terms/synonyms/definitions, annotation
 * text, note titles/bodies, exemplar questions/SQL, relationship notes and
 * discriminator values — plus the schema/table/column names inside structured
 * refs. Pure and local; never touches the warehouse. Exported for unit tests.
 */
export function searchKnowledgeRecords(
  records: KnowledgeRecord[],
  query: string
): KnowledgeSearchHit[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return []
  const hits: KnowledgeSearchHit[] = []
  for (const rec of records) {
    if (!KNOWN_KNOWLEDGE_KINDS.has(rec.kind)) continue
    const haystack = knowledgeHaystack(rec)
    if (keywords.every((k) => haystack.includes(k))) {
      hits.push({
        id: rec.id,
        kind: rec.kind,
        refs: knowledgeRefs(rec),
        summary: knowledgeHitSummary(rec)
      })
    }
  }
  return hits
}

/**
 * Local annotations and relationships touching one table, appended to
 * describe_table output after the DB-native detail. `name` is the tool input
 * ("orders" or "sales.orders"); matching is case-insensitive and, when no
 * schema is given, spans all schemas. Returns null when nothing is recorded.
 * Exported for unit tests.
 */
export function renderTableKnowledge(records: KnowledgeRecord[], name: string): string | null {
  const parts = name.toLowerCase().split('.').filter(Boolean)
  if (parts.length === 0) return null
  const table = parts[parts.length - 1]
  const schema = parts.length > 1 ? parts[parts.length - 2] : null
  const matches = (ref: ColumnRef | undefined): boolean =>
    ref !== undefined &&
    ref.table.toLowerCase() === table &&
    (schema === null || ref.schema.toLowerCase() === schema)
  const annotations = records.filter(
    (r): r is AnnotationRecord => r.kind === 'annotation' && matches(r.target)
  )
  const relationships = records.filter(
    (r): r is RelationshipRecord =>
      r.kind === 'relationship' &&
      (matches(r.from) ||
        matches(r.to) ||
        matches(r.discriminator) ||
        Object.values(r.targets ?? {}).some(matches))
  )
  if (annotations.length === 0 && relationships.length === 0) return null
  const lines: string[] = ['local knowledge (recorded in DB Desk, not from the database catalog):']
  if (annotations.length > 0) {
    lines.push('annotations:')
    for (const a of annotations) {
      lines.push(`  ${refName(a.target)}: ${indentBlock(a.text, '    ')}${sourceTag(a)}${idTag(a)}`)
    }
  }
  if (relationships.length > 0) {
    lines.push('relationships:')
    for (const rel of relationships) {
      lines.push(`  ${renderRelationship(rel, true)}${sourceTag(rel)}${idTag(rel)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Fires the same `knowledge:changed` push the UI save path emits (see
 * registerKnowledgeHandlers in index.ts) so renderer knowledge views refresh
 * when the agent's save_knowledge tool writes a record. Set via
 * setBroadcastKnowledgeChanged in registerAgentHandlers; a no-op until then
 * (e.g. in unit tests) so the write still succeeds without a window.
 */
let broadcastKnowledgeChanged: (kbId: string) => void = () => {}

/** Injects the renderer push used by save_knowledge; called from registerAgentHandlers. */
export function setBroadcastKnowledgeChanged(fn: (kbId: string) => void): void {
  broadcastKnowledgeChanged = fn
}

/**
 * search_knowledge: local store lookup only. No access-mode check on purpose —
 * the mode protects the connected database, and this tool never proxies SQL or
 * touches the warehouse in any mode. Exported for unit tests.
 */
export function execSearchKnowledge(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Anthropic.ToolResultBlockParam {
  const query = String((block.input as { query?: unknown }).query ?? '').trim()
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  const target = req.target
  if (!target) {
    return toolError(base, req, block.id, send, 'no target', 'No database target is connected.')
  }
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: `search knowledge "${query}"`
  })
  const all = searchKnowledgeRecords(allRecordsForTarget(target), query)
  const hits = all.slice(0, KNOWLEDGE_SEARCH_MAX_HITS)
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: `${all.length} match${all.length === 1 ? '' : 'es'}`
  })
  return {
    ...base,
    content: JSON.stringify({
      hits,
      note:
        all.length > hits.length
          ? `showing first ${hits.length} of ${all.length} matches — refine the query for the rest`
          : undefined
    })
  }
}

/**
 * save_knowledge: writes one record into the local knowledge store. No
 * access-mode gate on purpose — it only writes DB Desk's app-local store, never
 * the warehouse — but it does require a connected target. New records land in
 * the turn's active base (`resolveActiveKbId`); when the target has no linked
 * base yet, one named after the database is created and linked so the first
 * save always succeeds. An update by `id` is routed to whichever linked base
 * holds that record — search_knowledge spans all of them, so the id may come
 * from any. `source` is forced to 'agent'; the record is validated with the
 * same `validateKnowledgeRecord` the UI save path uses (via saveRecord), so
 * malformed payloads become a useful tool error rather than a bad write. On
 * success it fires the `knowledge:changed` push so open knowledge views
 * refresh. Exported for unit tests.
 */
export function execSaveKnowledge(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender
): Anthropic.ToolResultBlockParam {
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  const target = req.target
  if (!target) {
    return toolError(base, req, block.id, send, 'no target', 'No database target is connected.')
  }
  const input = (block.input ?? {}) as Record<string, unknown>
  // Force source: the agent only ever writes agent-sourced records. Strip any
  // caller-supplied source/timestamps; the store owns identity and stamping.
  const draft = { ...input, source: 'agent' } as KnowledgeRecordInput
  const kindLabel = typeof input.kind === 'string' ? input.kind : 'record'
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: input.id ? `update knowledge ${kindLabel}` : `save knowledge ${kindLabel}`
  })
  // An id from search_knowledge may live in any linked base; update it where
  // it is rather than duplicating it into the active base.
  const holder =
    typeof input.id === 'string'
      ? groupsForTarget(target.connId, target.database).find((g) =>
          g.records.some((r) => r.id === input.id)
        )
      : undefined
  const existed = holder !== undefined
  let kbId = holder?.base.id ?? resolveActiveKbId(target)
  let saved: KnowledgeRecord
  try {
    if (!kbId) {
      // First knowledge for this target: create and link a base named after
      // the database so the save lands somewhere durable and discoverable.
      // Validate the draft before creating anything — a rejected record must
      // not leave an empty auto-created base and link behind.
      validateKnowledgeRecord(draft)
      const created = createBase(target.database)
      // Links are schema-scoped: derive the scope from the record's own
      // references, falling back to the engine's default schema when the
      // record names none.
      const schema =
        knowledgeRefs(draft as KnowledgeRecord).find(
          (ref) => typeof ref.schema === 'string' && ref.schema.trim() !== ''
        )?.schema ?? dialectFor(getConnectionType(target.connId)).defaultSchema
      addLink({
        kbId: created.id,
        connId: target.connId,
        database: target.database,
        schema
      })
      kbId = created.id
    }
    saved = saveRecord(kbId, draft)
  } catch (err) {
    return toolError(
      base,
      req,
      block.id,
      send,
      'invalid record',
      `save_knowledge rejected the record: ${describeError(err)}`
    )
  }
  broadcastKnowledgeChanged(kbId)
  // Flag (never block) refs the live schema cannot satisfy: the record is
  // saved either way — dangling refs are legal in the store — but the model
  // should fix a typo or lower the confidence rather than leave it silent.
  // Requires the introspection cached by this session's schema summary; when
  // absent, saving proceeds unchecked exactly as before.
  const keys = liveRefKeys(target)
  const unresolved = keys
    ? [
        ...new Set(
          knowledgeRefs(saved)
            .map((ref) => normalizeColumnKey(ref))
            .filter((key) => !keys.has(key))
        )
      ]
    : []
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: `${existed ? 'updated' : 'saved'} ${saved.kind}${unresolved.length > 0 ? ` (${unresolved.length} unresolved ref${unresolved.length === 1 ? '' : 's'})` : ''}`
  })
  return {
    ...base,
    content: JSON.stringify({
      id: saved.id,
      kind: saved.kind,
      action: existed ? 'updated' : 'created',
      unresolvedRefs: unresolved.length > 0 ? unresolved : undefined,
      note:
        unresolved.length > 0
          ? 'These references match nothing in the live schema. If they are typos, update the record (pass this id); if the schema is simply ahead/behind the code, lower the confidence.'
          : undefined
    })
  }
}
