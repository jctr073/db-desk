# DB Desk

Electron + TypeScript + React + Vite + Monaco Editor foundation for a Mac desktop database client.

The shell implements the DB Desk connection panel: a light/dark themed three-pane
layout with a schema browser tree (connections → databases → schemas → tables,
views, functions, and more), object filtering, and a New
Connection dialog. The left connection pane and right agent pane are
drag-resizable via the dividers on either side of the editor, and each pane
remembers its width across restarts. Connections are real, and the app speaks
more than one engine: the New Connection dialog opens with a **Database Type**
picker (PostgreSQL or Databricks), and the rest of the form — field labels,
placeholders, the database/catalog term, the secret label, and the
Parameters/Connection URL tabs — adapts to the selected engine. PostgreSQL
connects via discrete parameters or a connection URL, preferring SSL/TLS
automatically and honoring any explicit `sslmode` in a URL, following libpq
semantics; Databricks connects to a SQL warehouse by server hostname, HTTP path,
catalog, and personal access token. Creating a connection introspects the
catalog and populates the tree with actual databases, schemas, tables, columns,
views, materialized views, indexes, functions, sequences, types, and aggregates.
Sibling databases are introspected lazily on first expand. Connections persist
across sessions (passwords encrypted at rest via Electron `safeStorage`) and are
restored offline on launch — reconnect, disconnect, and remove are available from
a right-click menu.

The SQL editor executes queries for real: a toolbar dropdown picks the
(connection, database) target, Run (or ⌘⏎) executes the statement under the
cursor — or the selection — and results land in a grid on the lower half of the
editor. Each run replaces the live results tab unless it is pinned, in which
case the next run opens a fresh tab; pinned tabs are titled `Result N · table`
for scannability (the full statement stays in the tab's tooltip) and can be
re-run and closed. When more tabs are open than fit the bar, the extras collapse
into an overflow dropdown that keeps the active tab visible and offers per-tab
close and a "Close all results" action. Bare
SELECTs get an automatic `LIMIT 500` (configurable in the toolbar, including no
limit); statements that can't take an appended LIMIT are truncated to the same
cap after execution.

The right-hand panel's **AI Agent** tab turns prompts into SQL. It reads
`CLAUDE_API_KEY` from `~/.zshrc` (re-read on every request, so no restart is
needed after editing it), and offers a model and reasoning-effort picker,
defaulting to Opus 4.8 at `xhigh` effort. Chat history streams per-session with
a live "thinking" indicator and a Stop button to cancel mid-response. Each turn
sees the schema of the connection/database selected in its own target picker
and the contents of the active SQL editor file, so generated SQL can reference
real tables and columns. Specific schemas, tables, or views can also be pinned
to the thread as context chips — via **Add to Agent Thread** on a tree node's
right-click menu or the composer's **Add context** picker — so the agent focuses
on the objects you care about. SQL code blocks in a reply get an Insert button that
drops them into the editor at the cursor, and the agent itself writes its final
query into the editor through a `write_to_editor` tool when it finishes an
answer. A globe toggle in the composer (off by default) lets the agent search
the web when a task calls for it — engine documentation, SQL syntax
references, or unfamiliar error messages — via Anthropic's server-side web
search tool.

The agent can also use tools from user-configured **MCP servers**. A split
plug control in the composer, next to the web-search toggle, opens the MCP
Servers dialog on click; its adjoining chevron drops down a live list of
connected servers with per-server status, from which a server row also opens
the dialog. Servers are added as a command line (spawned as stdio child
processes), optional environment variables (stored encrypted via
`safeStorage`), and an enabled toggle; the dialog shows each server's live
status and the tools it advertises, with restart/edit/remove actions. Tools
from running servers are
offered to the model under namespaced names (`mcp__server__tool`) in every
access mode. Note the deliberate delineation: the access modes below guard the
*connected database* (the built-in SQL tools); MCP tools act on external
systems with whatever rights you granted the server process, so their access
is governed by the server's own credentials, not by the agent's database mode.

The agent panel's mode picker offers three access modes: **Metadata Only**
(default) — "Writes SQL from the schema tree. Never executes anything on the
database."; **Read-Only** — "Runs read-only queries to inspect schema and live
data. Writes are blocked."; and **Write/Admin** — "Can change data and schema
(DML/DDL). Disabled in this version." Write/Admin is shown in the picker but
greyed out and unselectable in this release. In Read-Only mode the agent can
run queries against the selected database through a `run_sql` tool to
validate its work — every run also lands in the results grid as a pinned tab
so you can verify the output yourself, and each statement runs with a
30-second timeout. Agent SQL reaches the database only
through a guarded channel that allows exactly one statement per call and
refuses anything not provably read-only (an allowlist classifier over
SELECT/WITH/SHOW/DESCRIBE and EXPLAIN-of-reads); PostgreSQL additionally runs
agent statements under a server-side read-only session
(`default_transaction_read_only`) as a second belt, catching cases the
client-side classifier can't see (e.g. a `SELECT` that calls a volatile,
data-writing function). There is no approval or escalation flow — if you want
a change made, the agent writes the SQL to the editor via `write_to_editor`
for you to review and run yourself. For maximum safety, connect with a
read-only database role. Where the engine supports it, Stop
cancels the in-flight statement on the server (`pg_cancel_backend` for
PostgreSQL), not just the response stream. Generated SQL is targeted at the
selected connection's dialect (PostgreSQL vs. Databricks/Spark SQL), so the
agent uses the right syntax, identifier quoting, and catalog conventions. Three more tools give the agent schema insight beyond the
summary embedded in its prompt (which now includes foreign-key targets, index
definitions, row estimates, and enum values, and degrades gracefully on very
large catalogs): `describe_table` (columns, defaults, constraints, indexes,
inbound FKs, comments, row estimate), `search_schema` (find tables/columns/
functions by name), and `explain_query` (query plans, optionally with
`ANALYZE` for reads). The system prompt and conversation prefix are cached
with Anthropic prompt caching to cut per-turn cost and latency.

Queries are saved as files. Each tab is a `.sql` file persisted under the app's
user-data directory, with metadata (name, owning connection/database) tracked in
`queries/metadata.json`. New query files can be created from the editor tab bar's
`+` button or from the right-click menu on a connection or database in the tree,
and are auto-named per target (`query1.sql`, `query2.sql`, …). Each tab keeps its
own edit buffer so switching tabs preserves unsaved changes, with a per-file
dirty indicator; ⌘S (or the Save button) writes the active file to disk. The
right-hand panel's **SQL Files** tab lists all saved files grouped by their
owning connection and database. The window title and chrome use the native OS
title bar, and the light/dark theme toggle lives in the bottom status bar.

The right-hand panel's **Knowledge** tab is a local knowledge store for
whatever the schema alone can't say: column/table annotations, join
relationships (including polymorphic joins — a discriminator column mapping
to different target tables per value), a business glossary of terms and
synonyms, exemplar question→SQL pairs, and free-form notes. Records are
plain, pretty-printed JSON, one file per (connection, database) under
`<userData>/knowledge/<connId>/<databaseSlug>.json` — not a database, holds
no secrets, and is safe to read, diff, or check into a team's own repo. The AI agent
reads this store two ways: a `## Local knowledge` section is rendered into
its system prompt (relationships first, since join rules are highest-stakes,
then glossary, annotations, and exemplars, degrading gracefully under a char
budget on large stores) and a `search_knowledge` tool lets it look up specific
terms, joins, or annotations on demand. It also writes to the store: a
`save_knowledge` tool lets the agent record a durable fact stated mid-chat
(e.g. "that column is actually the admission date") so it survives a chat
reset instead of being lost; agent-written records are tagged with a
`source: agent` badge and a confidence level in the Knowledge tab and remain
fully editable and deletable like any human-authored record. Both tools touch
only the local store, never the database, so they work in every access mode,
including Metadata Only. In the schema tree, a right-click on a table or
column offers **Show usages** (everything in the knowledge store that
references it, grouped by kind) and **Add annotation…**, and nodes with any
knowledge attached show a small dot badge. Queries can be captured as
exemplars too — a **Save as exemplar…** action on the editor toolbar and on
SQL code blocks in agent replies opens a dialog to pair the query with a
question; on save, the columns and tables it touches are extracted (via a
quick one-shot LLM call, falling back to matching identifiers against the
live schema if that's unavailable) so the exemplar shows up under "Show
usages" for the columns it queries.

A codebase can be attached to a connection so the agent can cross-reference
the app's source alongside the schema. **Attach codebase…** in the agent
composer opens a native directory picker; the chosen root (and HEAD's short
commit SHA, when it's a git checkout) is stored main-side, keyed by
connection id — the renderer never has the filesystem path, only a status.
Once attached, three read-only tools (`list_repo_files`, `grep_repo`,
`read_repo_file`) are sandboxed to that root: paths must resolve lexically
inside it, symlinks are never followed, conventional secret files (`.env*`,
private keys, `.npmrc`, …) are invisible to all three, and every primitive is
capped (visits, results, matches, file size) so a monorepo can't wedge the
main process. A **Scan codebase** action sends a canned prompt that walks the
agent through migrations, ORM models, query/repository code, and docs, saving
what it learns to the local knowledge store (verified against the live
schema first) with provenance like `db/migrate/20240301_add_status.rb@abc1234`.
The attachment is on by default per chat once set and can be toggled off,
detached, or repointed to a different directory from the composer.

## Setup

```bash
npm install
npm run dev
```

## Scripts

```bash
npm run dev       # Start the Electron app in development mode
npm run build     # Typecheck and build production assets
npm run preview   # Run the built Electron app
npm run lint      # Run ESLint
npm run format    # Format project files with Prettier
npm test          # Run all tests (unit + integration; starts the test DB)
npm run test:unit # Fast unit tests only (no Docker required)
```

## Testing

Unit tests are plain [vitest](https://vitest.dev) and need nothing running.

Integration tests exercise the real database drivers against a disposable
PostgreSQL in Docker (`test/docker-compose.yml`), used chiefly to prove the AI
agent's read-only safety rules against a live engine. `npm test` (and
`npm run test:integration`) start and seed the container automatically via
vitest's global setup; you can also manage it directly:

```bash
npm run db:up     # start postgres:17-alpine on localhost:55432 (seeded)
npm run db:psql   # open psql against the test database
npm run db:down   # stop and discard it (data is tmpfs — nothing persists)
```

The container is isolated from the app: it is reachable only if you add a
connection pointing at port 55432. Override the port with
`DBDESK_TEST_PG_PORT`; set `DBDESK_TEST_NO_DOCKER=1` to run the integration
suite against a Postgres you manage yourself. See `docs/agent-modes.md` §8 for
what the suite verifies.

## Project Structure

```text
src/
  main/
    index.ts             # app bootstrap + db/store/files/agent IPC handlers
    db.ts                # engine-agnostic facade: routes calls to the driver for a connection's type
    drivers/
      types.ts           # Driver contract shared by all engines
      postgres.ts        # PostgreSQL driver: pooling, introspection + query execution
      databricks.ts      # Databricks SQL warehouse driver: introspection + query execution
    store.ts             # saved-connection persistence (safeStorage-encrypted)
    files.ts             # query-file persistence (.sql files + metadata.json)
    knowledge.ts         # local knowledge store: CRUD + validation over userData/knowledge/
    exemplar.ts          # exemplar reference extraction (LLM, with identifier-matching fallback)
    repo.ts              # codebase attachment: sandboxed list/grep/read over a per-connection repo root
    agent.ts             # Anthropic agent loop: key loading, schema summary, streaming tool use
  preload/
    index.ts             # typed window.dbDesk bridge (db + store + files + agent + repo)
  shared/
    db.ts                # wire types shared by main, preload, and renderer
    dialect.ts           # per-engine registry: form layout, defaults, agent SQL rules, EXPLAIN syntax
    sql.ts               # statement splitting + auto-LIMIT lexer (main + renderer)
    agent.ts             # AI agent wire types + model/effort catalog
    knowledge.ts         # knowledge record types + column-key normalization + usage index
    repo.ts              # codebase attachment wire types + the "Scan codebase" canned prompt
  renderer/
    index.html
    src/
      main.tsx
      App.tsx              # shell: 3 panes + status bar + dialog
      theme.ts             # light/dark theme hook (persisted)
      styles.css           # design tokens + component styles
      components/
        StatusBar.tsx      # bottom bar: theme toggle
        EditorPanel.tsx    # tab bar, target/limit toolbar, editor + results split
        AgentPanel.tsx     # right pane: SQL Files list + AI Agent chat + Knowledge tab
        FilesPanel.tsx     # saved query files grouped by connection/database
        SqlEditor.tsx
        ResultsPanel.tsx   # result tabs (live + pinned), grid, status bar
        SaveExemplarDialog.tsx # "Save as exemplar…" from the editor or an agent SQL reply
        useQueryRunner.ts  # result-tab state machine + query dispatch
        editorBridge.ts    # imperative handle (active SQL + insert-at-cursor) used by the AI Agent
        icons.tsx          # shared UI icons
      files/
        useFileState.ts    # query-file list/select/create/save/delete state
      knowledge/
        useKnowledgeState.ts  # live records + usage index for the active (connection, database)
        KnowledgePanel.tsx    # record list/filters, "Show usages" view, new-record menu
        RecordEditor.tsx      # kind-specific forms (annotation/relationship/glossary/exemplar/note)
        RefInput.tsx          # schema/table/column ref picker used by the forms
        format.ts             # record titles/summaries, search text, dangling-ref checks
        treeBadges.ts         # which schema-tree nodes get the "has knowledge" dot badge
      connections/
        types.ts
        treeData.ts        # tree construction from introspection results
        flatten.ts         # visible-row flattening + filtering
        useConnectionState.ts
        ConnectionPanel.tsx
        ConnectionTree.tsx
        TreeRow.tsx
        NodeIcon.tsx
        NewConnectionDialog.tsx
test/
  docker-compose.yml       # disposable postgres:17-alpine for integration tests
  seed/                    # schema + idempotent data seed (storefront: customers/orders/order_items)
  support/statements.ts    # shared statement corpus: expected class + observed engine behaviour
  unit/                    # vitest unit tests (no Docker)
  integration/
    support/               # test DB harness: config, global setup, driver wrappers
    postgres/              # driver behaviour vs. a real read-only session + read-only role
```

## Monaco Notes

Monaco is loaded from the local `monaco-editor` package through `@monaco-editor/react`. The renderer configures `loader.config({ monaco })` and registers Vite-bundled web workers with `?worker` imports, so the app does not depend on CDN-hosted Monaco assets and remains compatible with packaged Electron builds.
