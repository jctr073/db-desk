/**
 * Wire types for the per-knowledge-base codebase attachment: shared by the
 * main-process repo module, the preload bridge, and the renderer composer
 * control. Structured-clone friendly.
 *
 * The repo root itself is chosen through a main-process directory dialog and
 * persisted main-side on the knowledge base it belongs to. The renderer never
 * sends a filesystem path over IPC — it can only ask main to open the picker,
 * read the current status, or clear the attachment. The agent request carries
 * a plain boolean; main resolves the actual root from the turn's active
 * knowledge base.
 */

export interface RepoStatus {
  kbId: string
  /** Absolute repo root, or null when no codebase is attached. */
  root: string | null
  /** Short commit SHA of HEAD, or null when the root is not a git repo. */
  commit: string | null
}

/**
 * The result of picking a monorepo root for the multi-service setup flow:
 * the chosen root plus its immediate child folders (the service candidates).
 * The pick lives main-side under `pickId`; the renderer refers back to it by
 * id when creating mappings, so no filesystem path ever travels
 * renderer → main. `root` is display-only.
 */
export interface MonorepoPick {
  pickId: string
  root: string
  /** Immediate child folder names, sorted; dot/vendored dirs excluded. */
  folders: string[]
}

/** One requested folder → schemas mapping from the monorepo setup dialog. */
export interface MonorepoMappingInput {
  /** Must be one of the pick's listed folders. */
  folder: string
  /** Schemas this folder's service owns — one link is created per schema. */
  schemas: string[]
  /** Name for the created base (ignored when the folder is already mapped). */
  name: string
}

export interface MonorepoCreateInput {
  pickId: string
  connId: string
  database: string
  mappings: MonorepoMappingInput[]
}

export interface MonorepoCreateResult {
  /** Bases newly created by this call. */
  created: number
  /** Mappings that reused an existing base for the same root + folder. */
  reused: number
  /** kbIds in mapping order, for post-create selection. */
  kbIds: string[]
}

/** Case/separator-insensitive key for folder ↔ schema auto-matching. */
function matchKey(value: string): string {
  return value.toLowerCase().replace(/[-_ ]/g, '')
}

/** Suffixes commonly appended to a service folder name but not its schema
 * (`billing-service` → schema `billing`). Tried only after an exact match. */
const SERVICE_SUFFIXES = ['service', 'svc', 'api', 'app', 'worker', 'server']

/**
 * The schema a monorepo service folder most likely maps to, or null when
 * nothing matches. Purely a convenience prefill for the setup dialog — the
 * suggestion is always user-overridable and never creates a mapping by
 * itself. Matching is case- and separator-insensitive (`billing-svc` ↔
 * `billing_svc`), with common service suffixes stripped as a fallback.
 */
export function suggestSchema(folder: string, schemas: string[]): string | null {
  const byKey = new Map(schemas.map((s) => [matchKey(s), s]))
  const key = matchKey(folder)
  const direct = byKey.get(key)
  if (direct) return direct
  for (const suffix of SERVICE_SUFFIXES) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      const stripped = byKey.get(key.slice(0, -suffix.length))
      if (stripped) return stripped
    }
  }
  return null
}

/** Lowercased with `-` and spaces folded to `_`, for prefix matching where
 * segment boundaries still matter (unlike matchKey, which erases them). */
function segKey(value: string): string {
  return value.toLowerCase().replace(/[- ]/g, '_')
}

/**
 * All schemas a monorepo service folder likely owns: the single best match
 * (suggestSchema) plus every schema the folder name prefixes on a segment
 * boundary — `accounts` → `accounts_customer`, `accounts_legal_entity` — so a
 * service owning several schemas prefills them all. The boundary requirement
 * keeps `pay` from claiming `payment`. Result preserves `schemas` order; same
 * contract as suggestSchema: a convenience prefill, always user-overridable.
 */
export function suggestSchemas(folder: string, schemas: string[]): string[] {
  const primary = suggestSchema(folder, schemas)
  const prefixes = [segKey(folder)]
  for (const suffix of SERVICE_SUFFIXES) {
    const stripped = segKey(folder).replace(new RegExp(`_?${suffix}$`), '')
    if (stripped && stripped !== segKey(folder)) prefixes.push(stripped)
  }
  return schemas.filter((s) => s === primary || prefixes.some((p) => segKey(s).startsWith(`${p}_`)))
}

/**
 * Sections shared by the full scan and the targeted follow-up scan, so the
 * two prompts cannot drift on what to record and how.
 */
const SCAN_RECORDING_GUIDE = [
  'Record findings with save_knowledge:',
  '- annotation — what a column or table really means, including caveats (soft deletes, denormalized fields, units, legacy columns).',
  '- relationship — joins the schema does not declare as foreign keys, especially polymorphic associations (discriminator column + targets map).',
  '- glossary — business terms with column mappings and synonyms.',
  '- exemplar — a question the code answers plus its SQL, only when the SQL is valid for this engine.',
  '- note — anything durable that fits nowhere else, with structured references for every table/column mentioned.'
]

const SCAN_RULES = [
  'Rules:',
  '- Save only facts that change how a query would be written: join logic, filter conventions (soft deletes, status values), units, NULL semantics, derived-metric definitions, cross-table gotchas. Skip implementation trivia — hash and payload formats, auth plumbing, config/settings tables, UI behavior — unless a query must account for it.',
  '- Write records telegraphically: short plain clauses, no markdown emphasis, no restating what the schema or another record already says. Aim for 1-3 sentences per record. The whole store is injected into every future agent prompt under a fixed budget; verbose records evict exemplar SQL and note bodies.',
  '- One fact, one record: define a shared concept once (usually as a glossary term) and have other records use the term instead of re-explaining it.',
  '- Verify every schema/table/column reference against the live schema (schema summary, search_schema, describe_table) before saving. Where code and database disagree, prefer the database, lower the confidence, and say so in the record text.',
  '- Row counts and data observations from this database go stale: record them only when they change how a query should be written (e.g. a column that is entirely NULL so far), rounded and labeled as current data, not as schema truth.',
  '- Set provenance on every record to the source file path at the current commit, e.g. "db/migrate/20240301_add_status.rb@abc1234" (the commit is given in your instructions).',
  '- Set confidence honestly: "high" only when code and live schema agree.',
  '- Search the knowledge store first (search_knowledge) and update existing records by id instead of duplicating them.',
  '- Do not save speculation, framework boilerplate, or facts the schema already states (declared foreign keys, column types).'
]

const SCAN_FINISH =
  'Finish with a short summary of what you recorded, grouped by kind, plus anything suspicious or contradictory you noticed.'

/**
 * The canned prompt the composer's "Scan codebase" action sends as a normal
 * chat message. Living here keeps the scan flow out of the agent loop: it is
 * just a turn like any other, with the repo tools available.
 */
export const REPO_SCAN_PROMPT = [
  'Survey the attached codebase and record what it teaches about this database in the local knowledge store.',
  '',
  'Work through these sources, most authoritative first:',
  '1. Migrations (db/migrate, migrations/, alembic/, prisma/migrations, …) — read in order; later migrations supersede earlier ones.',
  '2. ORM models and schema definitions (ActiveRecord, Sequelize, SQLAlchemy, Prisma, Django models, …) — associations, enums, validations, comments.',
  '3. Query layers, repositories, and analytics SQL — real queries in the code make good exemplars.',
  '4. READMEs, docs, and substantive code comments — business terms and caveats.',
  '',
  ...SCAN_RECORDING_GUIDE,
  '',
  ...SCAN_RULES,
  '',
  SCAN_FINISH
].join('\n')

/**
 * A follow-up scan scoped by user-written focus instructions (the knowledge
 * panel's "Targeted scan…" action). Sent as a normal chat turn like the full
 * scan; the focus text is the user's own words, quoted verbatim.
 */
export function repoTargetedScanPrompt(focus: string): string {
  return [
    'Do a targeted follow-up scan of the attached codebase and record what it teaches about this database in the local knowledge store. Scope it to this focus:',
    '',
    focus.trim(),
    '',
    'Survey only the parts of the codebase relevant to that focus — start from any files, directories, tables, or topics it names or implies and follow the code from there. Use the same source hierarchy as a full scan (migrations first, then ORM models and schema definitions, then query layers, then docs and comments), but only where it bears on the focus.',
    'Earlier scans already populated the knowledge store. Before reading code, search_knowledge for what the focus touches so you know what is already recorded; update existing records by id where the focus adds detail or corrections, and save new records only for facts not yet covered.',
    '',
    ...SCAN_RECORDING_GUIDE,
    '',
    ...SCAN_RULES,
    '',
    SCAN_FINISH
  ].join('\n')
}
