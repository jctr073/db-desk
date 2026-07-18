/**
 * Static tool definitions offered to the model: the SQL tools (run_sql,
 * explain_query, describe_table, search_schema), the local-knowledge tools
 * (search_knowledge, save_knowledge), the repo tools, web search, and the
 * editor tools. Purely declarative — dispatch and execution live in
 * ./executors and ./knowledge.
 */

import type Anthropic from '@anthropic-ai/sdk'

import type { DialectInfo } from '../../shared/dialect'

/** Cap on web searches the model may run in a single turn. */
const WEB_SEARCH_MAX_USES = 5

export function runSqlTool(dialect: DialectInfo): Anthropic.Tool {
  return {
    name: 'run_sql',
    description: `Execute a single read-only SQL statement against the connected ${dialect.engine} ${dialect.databaseTerm} and return the result. Exactly one statement per call. Statements that modify data or schema — or anything not provably a read — are blocked and fail. SELECT results are limited to 500 rows and the first 50 rows are returned to you; the full result is shown to the user in the results grid. Use this to validate queries and check real data.`,
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: `A single ${dialect.engine} statement to execute.`
        }
      },
      required: ['sql']
    }
  }
}

export function explainQueryTool(dialect: DialectInfo): Anthropic.Tool {
  const analyzeProps: Record<string, unknown> = dialect.agent.supportsExplainAnalyze
    ? {
        analyze: {
          type: 'boolean',
          description:
            'Execute the statement to collect real timings (EXPLAIN ANALYZE). Reads only.'
        }
      }
    : {}
  return {
    name: 'explain_query',
    description: dialect.agent.supportsExplainAnalyze
      ? 'Run EXPLAIN on a SQL statement and return the query plan as text. Set analyze to true to execute the statement and get actual timings and row counts. Use this to check whether a query uses indexes before recommending it. Statements that modify data or schema cannot be explained.'
      : 'Run EXPLAIN on a SQL statement and return the query plan as text, without executing the statement. Use this to sanity-check how a query will be executed before recommending it. Statements that modify data or schema cannot be explained.',
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: `A single ${dialect.engine} statement to explain.`
        },
        ...analyzeProps
      },
      required: ['sql']
    }
  }
}

export function describeTableTool(dialect: DialectInfo): Anthropic.Tool {
  return {
    name: 'describe_table',
    description: `Return full detail for one table, view, or materialized view: columns with types and comments, plus whatever the engine tracks — constraints, indexes, defaults, row estimates, storage detail. ${dialect.agent.catalogHint.replace(/^prefer/, 'Prefer')}.`,
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Relation name, optionally schema-qualified (e.g. "orders" or "sales.orders").'
        }
      },
      required: ['name']
    }
  }
}

export function searchSchemaTool(dialect: DialectInfo): Anthropic.Tool {
  return {
    name: 'search_schema',
    description: `Case-insensitive substring search over table, view, column, and function names in the connected ${dialect.databaseTerm}. Use this to locate where a piece of data lives when the schema summary is abridged or a name is unknown.`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Substring to search for, e.g. "order_total".'
        }
      },
      required: ['pattern']
    }
  }
}

/**
 * Purely local tool: searches the DB Desk knowledge store, never the
 * warehouse, so — unlike the SQL tools — it is offered in Metadata Only mode
 * too and carries no access-mode gate.
 */
export const SEARCH_KNOWLEDGE_TOOL: Anthropic.Tool = {
  name: 'search_knowledge',
  description:
    'Keyword search over the local knowledge store for the connected database: glossary terms and synonyms, table/column annotations, join relationships (including polymorphic join rules), exemplar question→SQL pairs, and notes recorded by the user or past agent sessions. Matches record text and the schema/table/column names in structured references. Returns hits with the record id, kind, refs, and content. Reads only the local store — it never queries the database — and is available in every access mode.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for (all must match), e.g. "MRN" or "orders join".'
      }
    },
    required: ['query']
  }
}

/** JSON-schema fragment for a structured column/table reference. */
const COLUMN_REF_SCHEMA = {
  type: 'object',
  properties: {
    schema: { type: 'string' },
    table: { type: 'string' },
    column: {
      type: 'string',
      description: 'Omit for a reference to the whole table.'
    }
  },
  required: ['schema', 'table']
} as const

/**
 * Write path into the local knowledge store. Like search_knowledge this never
 * touches the warehouse — it only writes DB Desk's app-local records — so it is
 * offered in Metadata Only as well as Read-Only. The record shape is validated
 * with the same `validateKnowledgeRecord` the UI save path uses; `source` is
 * forced to 'agent' by the handler. Kind-specific fields are all optional at
 * the schema level and enforced per-kind by validation, so one flat schema
 * covers every record kind.
 */
export const SAVE_KNOWLEDGE_TOOL: Anthropic.Tool = {
  name: 'save_knowledge',
  description:
    'Record a durable fact about this database in the local DB Desk knowledge store so it survives chat resets and informs future conversations. Use it when the user states a lasting truth about their data — what a column really means, a join rule (including polymorphic joins), a glossary term, or a good example query. Save only facts that change how a query would be written, and write them terse: 1-3 plain sentences, no markdown emphasis, no restating the schema (the whole store renders into every future prompt under a fixed budget). Do NOT save conversation-local trivia, one-off answers, or anything you are unsure about. To correct or extend an existing record, pass its `id` from a search_knowledge result so it is updated in place instead of duplicated. Records you write are marked as agent-sourced; set `confidence` to reflect how sure you are. Writes only the local store, never the database, so it is available in every access mode.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Omit to create a new record. Pass an id from search_knowledge to update that existing record in place.'
      },
      kind: {
        type: 'string',
        enum: ['annotation', 'relationship', 'glossary', 'exemplar', 'note'],
        description: 'Which record kind to save; determines the required fields.'
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How sure you are of this fact.'
      },
      provenance: {
        type: 'string',
        description: 'Optional note on where this fact came from.'
      },
      target: {
        ...COLUMN_REF_SCHEMA,
        description: 'annotation: the table or column this describes.'
      },
      text: {
        type: 'string',
        description: 'annotation: markdown description, caveat, or gotcha.'
      },
      relType: {
        type: 'string',
        enum: ['standard', 'polymorphic'],
        description: 'relationship: standard single-target join, or polymorphic.'
      },
      from: {
        ...COLUMN_REF_SCHEMA,
        description: 'relationship: the local (foreign-key) column; a column is required.'
      },
      to: {
        ...COLUMN_REF_SCHEMA,
        description: 'relationship (standard): the single join target column.'
      },
      discriminator: {
        ...COLUMN_REF_SCHEMA,
        description: 'relationship (polymorphic): the column whose value selects the target.'
      },
      targets: {
        type: 'object',
        description:
          'relationship (polymorphic): map of discriminator value -> join target ColumnRef.',
        additionalProperties: COLUMN_REF_SCHEMA
      },
      notes: {
        type: 'string',
        description: 'relationship: optional free-form join notes.'
      },
      term: { type: 'string', description: 'glossary: the business term.' },
      synonyms: {
        type: 'array',
        items: { type: 'string' },
        description: 'glossary: alternate names for the term (may be empty).'
      },
      definition: {
        type: 'string',
        description: 'glossary: optional definition of the term.'
      },
      mappings: {
        type: 'array',
        description: 'glossary: which columns realize this term.',
        items: {
          type: 'object',
          properties: {
            ref: COLUMN_REF_SCHEMA,
            caveat: { type: 'string' }
          },
          required: ['ref']
        }
      },
      question: {
        type: 'string',
        description: 'exemplar: the natural-language question.'
      },
      sql: { type: 'string', description: 'exemplar: the SQL that answers it.' },
      title: { type: 'string', description: 'note: a short title.' },
      body: { type: 'string', description: 'note: markdown body.' },
      references: {
        type: 'array',
        items: COLUMN_REF_SCHEMA,
        description:
          'exemplar & note: every table/column the record refers to, as structured refs (required so usage lookups can find it — prose mentions do not count).'
      }
    },
    required: ['kind']
  }
}

/**
 * Repo tools: read-only, sandboxed access to the codebase attached to the
 * connection (see repo.ts for the sandbox invariants). Offered only when the
 * user enabled the codebase toggle AND main has a configured root for the
 * target connection — the model never supplies or learns absolute paths
 * beyond the root shown in the system prompt.
 */
export const LIST_REPO_FILES_TOOL: Anthropic.Tool = {
  name: 'list_repo_files',
  description:
    'List files in the attached codebase. Returns repo-relative paths. Skips dot-directories, vendored/build directories (node_modules, dist, …), and credential files. A glob without "/" matches basenames anywhere (e.g. "*.rb"); with "/" it matches the full relative path ("db/migrate/**"). Results are capped; narrow with dir/glob when truncated.',
  input_schema: {
    type: 'object',
    properties: {
      dir: {
        type: 'string',
        description: 'Directory to list from, relative to the repo root. Default: the root.'
      },
      glob: {
        type: 'string',
        description: 'Optional filter supporting **, *, and ?, e.g. "**/*.sql" or "*.prisma".'
      }
    }
  }
}

export const GREP_REPO_TOOL: Anthropic.Tool = {
  name: 'grep_repo',
  description:
    'Search file contents in the attached codebase with a JavaScript regular expression (case-insensitive unless caseSensitive is true). Returns matching lines as path:line pairs, capped at 200 matches. Binary files, oversized files, and credential files are skipped. Narrow with dir/glob for focused searches.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Regular expression to search for, e.g. "belongs_to|has_many" or "CREATE TABLE".'
      },
      dir: {
        type: 'string',
        description: 'Directory to search under, relative to the repo root. Default: the root.'
      },
      glob: {
        type: 'string',
        description: 'Optional filename filter supporting **, *, and ?, e.g. "*.py".'
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Match case-sensitively. Default false.'
      }
    },
    required: ['pattern']
  }
}

export const READ_REPO_FILE_TOOL: Anthropic.Tool = {
  name: 'read_repo_file',
  description:
    'Read a file from the attached codebase. Path is relative to the repo root. Returns up to 500 lines per call by default; use offset/limit to page through longer files. Binary and credential files are refused.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Repo-relative file path, e.g. "db/schema.rb".'
      },
      offset: {
        type: 'number',
        description: '1-based line number to start from. Default 1.'
      },
      limit: {
        type: 'number',
        description: 'Maximum lines to return. Default 500.'
      }
    },
    required: ['path']
  }
}

/**
 * Server-side web search tool, executed on Anthropic's infrastructure.
 * Haiku 4.5 predates the dynamic-filtering variant and needs the basic one.
 */
export function webSearchTool(modelId: string): Anthropic.Messages.ToolUnion {
  if (modelId === 'claude-haiku-4-5') {
    return {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES
    }
  }
  return {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES
  }
}

export const WRITE_EDITOR_TOOL: Anthropic.Tool = {
  name: 'write_to_editor',
  description:
    "Propose the full new contents of the user's active SQL editor. If the editor is empty the SQL is applied immediately; otherwise the user reviews a diff and accepts or rejects it, so always pass the complete contents the file should end up with — when editing the user's existing query, the full edited version with untouched parts preserved, never a fragment. Call this once at the end of your answer with the final, validated query. Do not call it for intermediate or exploratory queries.",
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'The complete SQL contents the editor should hold.'
      }
    },
    required: ['sql']
  }
}

export const READ_EDITOR_TOOL: Anthropic.Tool = {
  name: 'read_editor',
  description:
    "Read the live contents of the user's active SQL editor, plus their current selection if any. The editor contents in your instructions are a snapshot from when the user sent the message; call this for the current state before proposing an edit with write_to_editor, especially after several other tool calls — the user may have edited meanwhile.",
  input_schema: {
    type: 'object',
    properties: {}
  }
}
