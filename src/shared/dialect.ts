/**
 * Connection-type registry: everything that varies between supported
 * database engines lives here — UI labels and form layout, connection
 * defaults, and the SQL-dialect guidance fed to the AI agent. Adding an
 * engine means adding an entry here plus a driver in src/main/drivers.
 */

export type ConnectionType = 'postgres' | 'databricks'

export const CONNECTION_TYPES: ConnectionType[] = ['postgres', 'databricks']

/** Connection-dialog field layout for one engine. */
export interface DialectFormInfo {
  hostLabel: string
  hostPlaceholder: string
  showPort: boolean
  showUser: boolean
  /** Databricks warehouses are addressed by an HTTP path next to the host. */
  showHttpPath: boolean
  httpPathPlaceholder: string
  databaseLabel: string
  /** Label for the secret field ("Password" vs "Access token"). */
  secretLabel: string
  savePwdLabel: string
}

export interface DialectAgentInfo {
  /** Dialect-specific SQL rules appended to the agent system prompt. */
  rules: string[]
  /** How to look up metadata instead of engine-specific catalogs. */
  catalogHint: string
  /** True when EXPLAIN can execute the statement for real timings. */
  supportsExplainAnalyze: boolean
  /**
   * 'server': statements run in a server-enforced read-only session.
   * 'client': statements are classified client-side before execution.
   */
  readOnlyEnforcement: 'server' | 'client'
}

export interface DialectInfo {
  id: ConnectionType
  /** Short display name: "PostgreSQL", "Databricks". */
  label: string
  /** Engine name as the agent should describe the SQL dialect. */
  engine: string
  /** What the engine calls a top-level database ("database" / "catalog"). */
  databaseTerm: string
  /** Subtitle shown in the connection dialog header. */
  dialogSubtitle: string
  /** True when a single connection URL is a supported input format. */
  supportsUrl: boolean
  urlExample: string
  form: DialectFormInfo
  defaults: {
    name: string
    host: string
    port: string
    database: string
    user: string
    url: string
  }
  agent: DialectAgentInfo
  /** Wrap a statement in this engine's EXPLAIN syntax. */
  explainSql: (sql: string, analyze: boolean) => string
}

const POSTGRES: DialectInfo = {
  id: 'postgres',
  label: 'PostgreSQL',
  engine: 'PostgreSQL',
  databaseTerm: 'database',
  dialogSubtitle: 'Connect to a PostgreSQL database',
  supportsUrl: true,
  urlExample: 'postgresql://user:password@host:port/database',
  form: {
    hostLabel: 'HOST',
    hostPlaceholder: 'localhost',
    showPort: true,
    showUser: true,
    showHttpPath: false,
    httpPathPlaceholder: '',
    databaseLabel: 'DATABASE',
    secretLabel: 'PASSWORD',
    savePwdLabel: 'Save password'
  },
  defaults: {
    name: 'New PostgreSQL Connection',
    host: 'localhost',
    port: '5432',
    database: 'postgres',
    user: 'postgres',
    url: 'postgresql://postgres@localhost:5432/postgres'
  },
  agent: {
    rules: [
      '- Target PostgreSQL syntax only.',
      '- Prefer schema-qualified names when the table is outside the public schema.'
    ],
    catalogHint: 'prefer them over querying pg_catalog yourself',
    supportsExplainAnalyze: true,
    readOnlyEnforcement: 'server'
  },
  explainSql: (sql, analyze) =>
    `EXPLAIN (FORMAT TEXT${analyze ? ', ANALYZE, BUFFERS' : ''}) ${sql}`
}

const DATABRICKS: DialectInfo = {
  id: 'databricks',
  label: 'Databricks',
  engine: 'Databricks SQL',
  databaseTerm: 'catalog',
  dialogSubtitle: 'Connect to a Databricks SQL warehouse',
  supportsUrl: false,
  urlExample: '',
  form: {
    hostLabel: 'SERVER HOSTNAME',
    hostPlaceholder: 'dbc-a1b2c3d4-e5f6.cloud.databricks.com',
    showPort: false,
    showUser: false,
    showHttpPath: true,
    httpPathPlaceholder: '/sql/1.0/warehouses/abc123def456',
    databaseLabel: 'CATALOG',
    secretLabel: 'ACCESS TOKEN',
    savePwdLabel: 'Save access token'
  },
  defaults: {
    name: 'New Databricks Connection',
    host: '',
    port: '443',
    database: '',
    user: '',
    url: ''
  },
  agent: {
    rules: [
      '- Target Databricks SQL (Spark SQL) syntax only — not PostgreSQL, not T-SQL.',
      '- Names resolve as catalog.schema.table; qualify at least schema.table, and quote identifiers with backticks (`) when needed.',
      '- Databricks has no indexes, sequences, or SERIAL; use IDENTITY columns, and GENERATE ALWAYS AS for computed columns.',
      '- Use Spark SQL functions and date arithmetic (date_add, datediff, current_timestamp()); :: casts and Postgres operators like ILIKE do not exist — use CAST(...) and lower()/rlike.'
    ],
    catalogHint:
      'prefer them over querying information_schema or SHOW commands yourself',
    supportsExplainAnalyze: false,
    readOnlyEnforcement: 'client'
  },
  explainSql: (sql) => `EXPLAIN FORMATTED ${sql}`
}

export const DIALECTS: Record<ConnectionType, DialectInfo> = {
  postgres: POSTGRES,
  databricks: DATABRICKS
}

/** Dialect for a possibly-unknown type, defaulting to PostgreSQL (legacy records). */
export function dialectFor(type: string | null | undefined): DialectInfo {
  return type && type in DIALECTS ? DIALECTS[type as ConnectionType] : POSTGRES
}
