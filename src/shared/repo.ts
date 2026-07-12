/**
 * Wire types for the per-connection codebase attachment: shared by the
 * main-process repo module, the preload bridge, and the renderer composer
 * control. Structured-clone friendly.
 *
 * The repo root itself is chosen through a main-process directory dialog and
 * persisted main-side, keyed by connection id. The renderer never sends a
 * filesystem path over IPC — it can only ask main to open the picker, read
 * the current status, or clear the attachment. The agent request carries a
 * plain boolean; main resolves it against its own store.
 */

export interface RepoStatus {
  connId: string
  /** Absolute repo root, or null when no codebase is attached. */
  root: string | null
  /** Short commit SHA of HEAD, or null when the root is not a git repo. */
  commit: string | null
}

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
  'Record findings with save_knowledge:',
  '- annotation — what a column or table really means, including caveats (soft deletes, denormalized fields, units, legacy columns).',
  '- relationship — joins the schema does not declare as foreign keys, especially polymorphic associations (discriminator column + targets map).',
  '- glossary — business terms with column mappings and synonyms.',
  '- exemplar — a question the code answers plus its SQL, only when the SQL is valid for this engine.',
  '- note — anything durable that fits nowhere else, with structured references for every table/column mentioned.',
  '',
  'Rules:',
  '- Verify every schema/table/column reference against the live schema (schema summary, search_schema, describe_table) before saving. Where code and database disagree, prefer the database, lower the confidence, and say so in the record text.',
  '- Set provenance on every record to the source file path at the current commit, e.g. "db/migrate/20240301_add_status.rb@abc1234" (the commit is given in your instructions).',
  '- Set confidence honestly: "high" only when code and live schema agree.',
  '- Search the knowledge store first (search_knowledge) and update existing records by id instead of duplicating them.',
  '- Do not save speculation, framework boilerplate, or facts the schema already states (declared foreign keys, column types).',
  '',
  'Finish with a short summary of what you recorded, grouped by kind, plus anything suspicious or contradictory you noticed.'
].join('\n')
