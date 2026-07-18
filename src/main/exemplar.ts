/**
 * Exemplar reference extraction (Phase 5). When an exemplar question→SQL pair
 * is saved, we extract the structured `ColumnRef[]` it touches so the exemplar
 * participates in the reverse usage index and the "show usages" view — prose
 * mentions never count, only structured refs.
 *
 * Two paths, tried in order:
 *   1. A one-shot LLM call (the app already ships the Anthropic client): given
 *      the SQL and a compact schema context, return the tables/columns used.
 *   2. A dependency-free fallback that matches identifiers in the SQL text
 *      against the cached introspection — cheap, dialect-agnostic, no parser.
 *
 * Extraction runs once, at save time (never at click time). This module keeps
 * no Electron imports so the pure fallback stays trivially unit-testable.
 */

import Anthropic from '@anthropic-ai/sdk'

import { introspectDatabase } from './db'
import type { ColumnRef } from '../shared/knowledge'
import { normalizeColumnKey } from '../shared/knowledge'
import type { DatabaseIntrospection, DbResult } from '../shared/db'

/** Cap on refs any single extraction yields, guarding against pathological SQL. */
const MAX_REFERENCES = 200
/** Fast, cheap model for the one-shot extraction call. */
const EXTRACTION_MODEL = 'claude-haiku-4-5'
/** Budget for the schema context embedded in the extraction prompt. */
const EXTRACTION_SCHEMA_MAX_CHARS = 12_000

/** A relation flattened from introspection: canonical names + column names. */
interface Rel {
  schema: string
  table: string
  columns: string[]
}

/** Every table/view/materialized view in the database, with canonical casing. */
function collectRelations(intro: DatabaseIntrospection): Rel[] {
  const out: Rel[] = []
  for (const schema of intro.schemas) {
    for (const rel of [...schema.tables, ...schema.views, ...schema.matviews]) {
      out.push({
        schema: schema.name,
        table: rel.name,
        columns: rel.columns.map((c) => c.name)
      })
    }
  }
  return out
}

/**
 * Remove comments and single-quoted string literals so identifiers inside them
 * are never mistaken for schema references. Double-quoted and backtick-quoted
 * identifiers are kept — those are real object names in Postgres/Databricks.
 */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/'(?:[^']|'')*'/g, ' ') // single-quoted string literals
}

const IDENT = String.raw`(?:"[^"]+"|\`[^\`]+\`|[A-Za-z_][A-Za-z0-9_$]*)`
const PATH_RE = new RegExp(`${IDENT}(?:\\s*\\.\\s*${IDENT})*`, 'g')
const IDENT_RE = new RegExp(IDENT, 'g')

/** Strip surrounding double quotes or backticks from a single identifier. */
function unquoteIdent(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith('`') && token.endsWith('`'))
  ) {
    return token.slice(1, -1)
  }
  return token
}

/** Every dotted identifier path in the SQL, each as its component identifiers. */
function extractIdentifierPaths(sql: string): string[][] {
  const cleaned = stripSqlNoise(sql)
  const paths: string[][] = []
  for (const match of cleaned.match(PATH_RE) ?? []) {
    const parts = (match.match(IDENT_RE) ?? []).map(unquoteIdent).filter(Boolean)
    if (parts.length > 0) paths.push(parts)
  }
  return paths
}

/**
 * Fallback extractor: resolve the identifiers in `sql` against `intro` and
 * return the tables/columns they reference, using the introspection's own
 * casing so refs land under the same normalized keys as the usage index.
 *
 * Rules (conservative — this is the fallback, the LLM is primary):
 *   - `schema.table.column` and `schema.table` resolve directly.
 *   - `table.column` resolves when the table name is known and owns the column;
 *     a bare `schema.table` resolves when the schema is known.
 *   - A bare identifier equal to a known table name marks that table referenced.
 *   - A bare identifier equal to a column name is attributed only when exactly
 *     one referenced table owns that column (avoids ambiguous over-matching).
 *
 * Pure and dependency-free; unit-tested directly.
 */
export function matchReferencesInSql(sql: string, intro: DatabaseIntrospection): ColumnRef[] {
  const rels = collectRelations(intro)
  const schemaNames = new Set(intro.schemas.map((s) => s.name.toLowerCase()))
  const relByQualified = new Map<string, Rel>()
  const relsByTable = new Map<string, Rel[]>()
  for (const rel of rels) {
    relByQualified.set(`${rel.schema}.${rel.table}`.toLowerCase(), rel)
    const key = rel.table.toLowerCase()
    const list = relsByTable.get(key)
    if (list) list.push(rel)
    else relsByTable.set(key, [rel])
  }

  const tableRefs = new Map<string, ColumnRef>()
  const columnRefs = new Map<string, ColumnRef>()
  const referencedRels = new Map<string, Rel>()

  const addTable = (rel: Rel): void => {
    const key = `${rel.schema}.${rel.table}`.toLowerCase()
    referencedRels.set(key, rel)
    tableRefs.set(key, { schema: rel.schema, table: rel.table })
  }
  const addColumn = (rel: Rel, column: string): void => {
    // A referenced column implies its table is referenced too.
    addTable(rel)
    columnRefs.set(`${rel.schema}.${rel.table}.${column}`.toLowerCase(), {
      schema: rel.schema,
      table: rel.table,
      column
    })
  }
  const columnNamed = (rel: Rel, lower: string): string | undefined =>
    rel.columns.find((c) => c.toLowerCase() === lower)

  const bareTokens: string[] = []

  for (const parts of extractIdentifierPaths(sql)) {
    if (parts.length === 1) {
      bareTokens.push(parts[0].toLowerCase())
      continue
    }
    const lower = parts.map((p) => p.toLowerCase())
    // schema.table.column (use the last three of a longer catalog path).
    if (lower.length >= 3) {
      const [s, t, c] = lower.slice(-3)
      const rel = relByQualified.get(`${s}.${t}`)
      if (rel) {
        const col = columnNamed(rel, c)
        if (col) {
          addColumn(rel, col)
          continue
        }
      }
    }
    // schema.table or table.column (last two components).
    const [a, b] = lower.slice(-2)
    if (schemaNames.has(a)) {
      const rel = relByQualified.get(`${a}.${b}`)
      if (rel) {
        addTable(rel)
        continue
      }
    }
    const candidates = relsByTable.get(a)
    if (candidates) {
      const owners = candidates.filter((rel) => columnNamed(rel, b))
      if (owners.length > 0) {
        for (const rel of owners) addColumn(rel, columnNamed(rel, b) as string)
      } else {
        // Known table, but `b` is not one of its columns (likely stale or an
        // alias.column we cannot resolve) — at least record the table.
        for (const rel of candidates) addTable(rel)
      }
      continue
    }
    // Unresolvable qualifier (probably an alias): keep the trailing name as a
    // bare-column candidate for the referenced tables below.
    bareTokens.push(b)
  }

  // Bare identifiers that name a table mark it referenced.
  for (const token of bareTokens) {
    const candidates = relsByTable.get(token)
    if (candidates) for (const rel of candidates) addTable(rel)
  }
  // Bare identifiers that name a column are attributed only when exactly one
  // referenced table owns that column.
  const referenced = [...referencedRels.values()]
  for (const token of bareTokens) {
    if (relsByTable.has(token)) continue
    const owners = referenced.filter((rel) => columnNamed(rel, token))
    if (owners.length === 1) {
      addColumn(owners[0], columnNamed(owners[0], token) as string)
    }
  }

  const result: ColumnRef[] = []
  const seen = new Set<string>()
  for (const ref of [...tableRefs.values(), ...columnRefs.values()]) {
    const key = normalizeColumnKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(ref)
    if (result.length >= MAX_REFERENCES) break
  }
  return result
}

/**
 * Injected by main/index.ts at startup with the settings-backed resolver
 * (stored key → ~/.zshrc → environment). A module-level seam rather than an
 * import so this module keeps no Electron dependency (see header). Until
 * injection, no key resolves and extraction uses the text-matching fallback.
 */
let loadApiKey: () => string | null = () => null

export function setExemplarApiKeyLoader(loader: () => string | null): void {
  loadApiKey = loader
}

/** Compact "schema.table: col, col" listing, capped, for the extraction prompt. */
function renderSchemaContext(intro: DatabaseIntrospection): string {
  const lines: string[] = []
  let length = 0
  for (const rel of collectRelations(intro)) {
    const line = `${rel.schema}.${rel.table}: ${rel.columns.join(', ')}`
    length += line.length + 1
    if (length > EXTRACTION_SCHEMA_MAX_CHARS) {
      lines.push('… (schema truncated)')
      break
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** Canonicalize an LLM-proposed ref against introspection casing when possible. */
function canonicalizeRef(
  raw: { schema?: unknown; table?: unknown; column?: unknown },
  relByQualified: Map<string, Rel>
): ColumnRef | null {
  if (typeof raw.schema !== 'string' || typeof raw.table !== 'string') return null
  const rel = relByQualified.get(`${raw.schema}.${raw.table}`.toLowerCase())
  const schema = rel ? rel.schema : raw.schema
  const table = rel ? rel.table : raw.table
  if (raw.column === undefined || raw.column === null) {
    return { schema, table }
  }
  if (typeof raw.column !== 'string') return null
  const column =
    rel?.columns.find((c) => c.toLowerCase() === (raw.column as string).toLowerCase()) ?? raw.column
  return { schema, table, column }
}

/**
 * Primary path: ask the model to extract the refs. Returns null (never throws)
 * when there is no API key or the call/parse fails, so the caller can fall back
 * to `matchReferencesInSql`. Kept as an injectable seam for tests.
 */
async function llmExtractReferences(
  sql: string,
  intro: DatabaseIntrospection
): Promise<ColumnRef[] | null> {
  const key = loadApiKey()
  if (!key) return null
  try {
    const client = new Anthropic({ apiKey: key })
    const prompt = [
      'Extract every table and column the following SQL query references.',
      'Use the schema below to resolve unqualified names and aliases to their real tables.',
      'Respond with ONLY a JSON array of objects like {"schema":"public","table":"orders","column":"total"}.',
      'Omit "column" for a whole-table reference. Include only objects that exist in the schema. No prose, no code fences.',
      '',
      'Schema:',
      renderSchemaContext(intro),
      '',
      'SQL:',
      sql
    ].join('\n')
    const resp = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end <= start) return null
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    const relByQualified = new Map(
      collectRelations(intro).map((rel) => [`${rel.schema}.${rel.table}`.toLowerCase(), rel])
    )
    const result: ColumnRef[] = []
    const seen = new Set<string>()
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const ref = canonicalizeRef(entry as Record<string, unknown>, relByQualified)
      if (!ref) continue
      const normKey = normalizeColumnKey(ref)
      if (seen.has(normKey)) continue
      seen.add(normKey)
      result.push(ref)
      if (result.length >= MAX_REFERENCES) break
    }
    return result
  } catch {
    return null
  }
}

/** Injectable dependencies, so the LLM/introspection seams are mockable. */
export interface ExtractionDeps {
  introspect?: (connId: string, database: string) => Promise<DbResult<DatabaseIntrospection>>
  llm?: (sql: string, intro: DatabaseIntrospection) => Promise<ColumnRef[] | null>
}

/**
 * Extract the structured refs an exemplar's SQL touches, at save time. Tries
 * the LLM first, falling back to text matching when no client/key is available,
 * the call fails, or it resolves nothing. Returns `[]` when introspection is
 * unavailable — the exemplar still saves, just without usage-index participation.
 */
export async function extractExemplarReferences(
  connId: string,
  database: string,
  sql: string,
  deps: ExtractionDeps = {}
): Promise<ColumnRef[]> {
  if (!sql.trim()) return []
  const introspect = deps.introspect ?? introspectDatabase
  const llm = deps.llm ?? llmExtractReferences
  const res = await introspect(connId, database)
  if (!res.ok) return []
  // An empty (not just null) LLM result is a miss too — fall back to matching.
  const viaLlm = await llm(sql, res.data)
  return viaLlm && viaLlm.length > 0 ? viaLlm : matchReferencesInSql(sql, res.data)
}
