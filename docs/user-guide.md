# DB Desk User Guide

DB Desk is a desktop workspace for browsing a database, writing SQL, reviewing
results, and collaborating with an AI agent that understands the selected
schema. PostgreSQL and Databricks SQL warehouses are supported.

Return to the [main README](../README.md), or read the
[technical architecture](architecture.md) for implementation details.

## Get oriented

The window has three resizable areas:

1. **Connections** on the left contains saved connections and the live schema
   tree.
2. The **editor and results** in the center contain files, data previews, SQL
   controls, and result tabs.
3. The right side contains **AI Agent**, **Knowledge**, **SQL Files**, and
   **Skills** tabs.

Drag either vertical divider to resize its panel. DB Desk remembers both panel
widths. Use the control in the bottom status bar to switch between light and
dark themes.

## Connect to a database

Select **+** in the Connections header, choose a database type, enter a display
name and connection details, and use **Test Connection** before connecting.

### PostgreSQL

PostgreSQL accepts either individual parameters or a connection URL. The
database field is required, and each connection is pinned to that database;
DB Desk rejects attempts to query or introspect another database through the
same profile.

DB Desk prefers SSL/TLS automatically. An explicit `sslmode` in a PostgreSQL
URL is honored with libpq-style semantics.

### Databricks

For a Databricks SQL warehouse, provide the server hostname, warehouse HTTP
path, catalog, and personal access token. A Databricks connection can expose
multiple catalogs. The initial catalog is loaded at connection time and other
catalogs are introspected when first expanded.

Warehouses can hold far more catalogs and schemas than one session needs, so
Databricks connections support pinning:

- **Manage Schemas…** (right-click a catalog) picks which of its schemas are
  loaded. Unpinned schemas are not introspected: they stay out of the schema
  tree, the AI Agent's schema summary, and the agent's schema search and
  describe tools. Raw SQL can still query them.
- **Manage Catalogs…** (right-click the connection) picks which catalogs
  appear in the tree. The connected catalog is always shown.

A catalog with no saved schema selection loads everything, except that a large
catalog (more than 25 schemas) opens the schema picker instead of loading; a
pinned catalog shows a faint "12 of 240" count on its row. Checking every item
clears the selection, so schemas created later appear again automatically.
Selections are stored with the saved connection profile.

### Saved connections

Connection profiles remain available when DB Desk is restarted. If **Save
password** or **Save access token** is selected, the secret is encrypted with
Electron `safeStorage`; URL passwords are stripped from the stored URL. When
OS-backed encryption is unavailable, DB Desk does not save a connection
secret.

Right-click a connection to:

- create a query file;
- refresh every catalog/database already loaded in its schema tree;
- choose which catalogs are shown (Databricks, **Manage Catalogs…**);
- disconnect while keeping the saved profile;
- reconnect an offline profile; or
- remove the connection.

> **Important:** removing a connection also deletes its saved files, its links
> to knowledge bases (the bases themselves survive), and connection-scoped
> skills. Disconnect it instead when you only want to close the live database
> session.

## Browse the schema

Expand the tree to browse databases or catalogs, schemas, tables, views,
materialized views, columns, indexes, functions, sequences, types, aggregates,
and enum values. Use **Filter objects…** to narrow the visible tree, and the
collapse control in the panel header to close every expanded branch.

Double-click a table, view, or materialized view to open a read-only
`SELECT *` preview capped at 100 rows. Opening the same relation again refreshes
its existing preview tab.

Right-click supported schema objects to:

- copy the qualified object name;
- add a schema, table, or view to the AI thread as context;
- show or add local knowledge for a table or column; and
- on PostgreSQL, inspect outgoing and incoming references.

PostgreSQL columns with declared foreign keys show an **FK** badge. DB Desk can
also infer conservative logical foreign keys and display them as dashed
**LFK** badges. Inference requires compatible types and exact naming patterns,
uses only single-column primary keys, never overrides a declared foreign key,
and avoids self-references. **View references** distinguishes declared and
logical relationships and can navigate directly to a referenced column.

## Work with files and the editor

Every file belongs to a connection and database. Create one from the editor's
**+** menu, the SQL Files tab, or a connection/database context menu. Supported
file types are:

- SQL (`.sql`)
- Markdown (`.md` or `.markdown`)
- JSON (`.json`)
- plain text (`.txt` or `.text`)

Files are saved in DB Desk's application-data directory rather than in the
current source repository. New files receive names such as `query1.sql` and
`notes1.md`. Right-click an editor tab to rename it. Names must be unique in
their connection/database group; missing extensions are added automatically.

Each tab keeps its own edit buffer. A dirty indicator identifies unsaved work,
and closing dirty tabs asks whether to save or discard it. Closing a clean tab
does not delete its saved file; reopen it from **SQL Files** or from the empty
editor state. Use the eye control to render Markdown, pretty-print JSON, or
preview plain text. Malformed JSON displays its parse error inline.

Useful editor shortcuts:

| Shortcut  | Action                                                |
| --------- | ----------------------------------------------------- |
| `⌘ Enter` | Run the selected SQL, or the statement at the cursor. |
| `⌘ S`     | Save the active file.                                 |
| `⌘ Z`     | Undo an accepted AI editor change.                    |
| `Esc`     | Reject an open AI diff proposal.                      |

The SQL editor also offers **Add Selection to AI Chat** and **Add Query to AI
Chat** in its context menu. These create frozen context snapshots; later edits
do not change what was attached.

## Run SQL

Choose a connection/database target in the editor toolbar. **Run** executes the
current selection, or the statement under the cursor when nothing is selected.
Each manual run replaces the live result tab unless that tab has been pinned.

DB Desk applies an automatic limit of 500 rows to plain `SELECT` statements.
Change the limit from the results toolbar or choose no limit. For statements
where a `LIMIT` cannot safely be appended, DB Desk truncates the returned rows
to the selected cap after execution.

Use **Save as exemplar…** to pair the current SQL with a natural-language
question in the local Knowledge store. DB Desk extracts referenced tables and
columns so the exemplar appears in relevant knowledge lookups.

## Read and manage results

Pin a result to preserve it before the next run. Pinned results receive
descriptive numbered titles, can be rerun, and can be closed independently.
When tabs no longer fit, the overflow menu keeps the active result visible and
offers **Close all results**. AI-run queries appear in a separate AI Agent
result group.

In the grid:

- drag a column-header edge to resize it;
- focus a resize handle and use the arrow keys for keyboard resizing;
- select a row by clicking its row number;
- select a column by clicking its header;
- use `Shift` for a range and `⌘` to toggle individual rows or columns; and
- click the top-left corner to select the entire grid.

Right-click the grid to add either the current selection or the result to the
AI chat. Context is serialized with cell and row caps so a large result cannot
overfill the prompt.

### Export results

Use **Export** to save CSV, tab-delimited text, or JSON. Row and column
selections constrain what is exported.

- With selected rows, DB Desk exports the loaded selection.
- Without selected rows, CSV and TSV rerun the statement through a read-only
  export path without the grid limit, producing the full result.
- JSON exports the rows currently loaded in the grid.

## Use the AI Agent

Database browsing, editing, and queries do not require AI. To enable the agent,
add the following to `~/.zshrc` and replace the placeholder with an Anthropic
API key:

```bash
export CLAUDE_API_KEY="your-key"
```

The file is read for every request, so a restart is unnecessary. Select the
agent's connection/database target, model, reasoning effort, and access mode
before sending a prompt.

### Access modes

- **Metadata Only** is the default. The agent sees schema and supplied context
  but cannot execute SQL.
- **Read-Only** gives the agent guarded tools for inspecting schema, plans, and
  live data. Calls accept one provably read-only statement, have a 30-second
  timeout, and are shown as pinned results. PostgreSQL also enforces a
  server-side read-only session.
- **Write/Admin** is displayed but disabled in this version. The agent cannot
  make data or schema changes.

For defense in depth, connect with a database role that itself has only the
permissions the agent should use. MCP servers are separate external systems;
the database access mode does not restrict their credentials or effects.

### Agent context

Every turn includes the selected schema, the active editor file, and any active
editor selection. Add explicit context chips when the task needs a stable
snapshot or extra focus:

- schemas, tables, and views from the schema tree or **Add context** picker;
- selected SQL or the whole query from the editor context menu;
- loaded result data or a grid selection; and
- a failed query, its SQL, and its error through **Fix with AI**.

Context chips remain attached until removed. A live codebase attachment can be
toggled separately in the composer.

### Review generated work

SQL code blocks in replies have an insert action and can be saved as
exemplars. When the agent uses its editor-writing tool, an empty editor can be
filled directly; otherwise DB Desk presents an inline diff with **Accept** and
**Reject** controls. The existing buffer is not silently overwritten.

**Fix with AI** asks the agent to resolve a failed query and requires an editor
diff rather than a prose-only answer. Tool activity—such as SQL runs, schema
descriptions, knowledge searches, codebase reads, web searches, and MCP
calls—is shown inline with status indicators.

### Sessions, web search, and context size

Use **New chat** to archive the current chat in the running application
session. **Chat history** reopens an archived chat with its messages, target,
model, effort, mode, toggles, and draft. Use **Stop** to cancel a response; when
supported, DB Desk also cancels an in-flight database statement.

The context gauge shows approximate token usage. Type `/compact` to replace a
long history with an agent-written summary, or `/clear` to start fresh. In the
cog menu, the **Web browsing** toggle permits Anthropic's server-side web
search for that chat and is off by default.

### MCP servers

The cog menu shows connected MCP servers and opens MCP configuration. Add a
server with a display name, a stdio command line, optional `KEY=VALUE`
environment variables, and an enabled state. The dialog reports startup status
and advertised tools and provides edit, restart, disable, and remove actions.

Environment values are encrypted with OS-backed `safeStorage` when available.
An MCP server runs locally with the command and credentials you configure, and
its tools are offered to the model under namespaced names.

## Build local database knowledge

The **Knowledge** tab stores facts that schema introspection cannot express.
Facts live in named **knowledge bases** — free-standing collections, typically
one per code repository — that you link to connections. One base can be linked
to several connections (say, the prod, staging, and dev copies of the same
database), one database can be linked to several bases (two services writing
to one schema), and on multi-schema catalogs a link can be scoped to a single
schema so each schema draws on the repository that owns it.

Choose a connection/database target and a linked knowledge base, search or
filter its records, and create:

- **annotations** for a table or column;
- **relationships**, including polymorphic joins;
- **glossary** terms, synonyms, definitions, and column mappings;
- **exemplars** that pair a question with working SQL; and
- Markdown **notes** with structured table/column references.

Knowledge is local JSON, not a database table, and contains no connection
secrets. Records can be edited or deleted. A warning badge identifies a record
whose structured reference no longer exists in the current schema. Schema-tree
dots identify objects with attached knowledge, and **Show knowledge entries**
opens the reverse-usage view for an object.

The agent receives every base linked to the active target in its prompt —
grouped by base, with schema-scoped links called out — and can search across
them on demand. It can also save a fact learned in conversation, which lands
in the target's default base (created automatically on first save if none is
linked). Agent-authored records show their source and confidence and remain
fully editable. When knowledge influences a response, `[kb:…]` citations
render as clickable chips that open the source record.

Deleting a connection removes its links but never a knowledge base itself, so
a base shared with other environments survives. Bases can be renamed, linked,
unlinked, and deleted from the Knowledge tab.

## Attach and scan a codebase

In Knowledge, use the folder control to attach a local source directory to a
knowledge base. If it is a Git checkout, DB Desk also records the current short
commit SHA. The agent then gains read-only tools to list, search, and read files
inside that root.

Codebase access is sandboxed: paths cannot escape the selected directory,
symlinks are not followed, conventional secret files are hidden, generated and
vendored directories are skipped, and reads and searches have size limits.
The codebase toggle is enabled by default for new chats after an attachment is
present.

Use **Scan codebase** to have the agent inspect migrations, models, query code,
and documentation and save verified findings to Knowledge. Use **Targeted
scan…** to focus a later pass and reconcile it with existing records.

> **Important:** the detach dialog offers two actions — detaching only the
> codebase (knowledge kept) or also deleting the knowledge base, which removes
> it from every connection it is linked to. The confirmation dialog describes
> the affected base before continuing.

## Create and run skills

The **Skills** tab stores reusable agent prompts. A custom skill has a name,
optional description, prompt, and scope. General skills are available to every
connection; connection-scoped skills are grouped under that connection.

Insert `{{args}}` in a prompt to collect input at run time. Running a skill
sends the resolved prompt as a normal agent turn against the agent's current
connection, using the current mode and context settings.

DB Desk ships built-in **Scan codebase** and **Targeted scan** skills. Built-in
skills can be edited, and **Reset to installed** restores the version bundled
with the application. The Knowledge tab's scan actions use these same skill
definitions, so edits apply there too. Scan skills require an attached
codebase.

## Data and safety summary

- Queries, knowledge, skills, connection profiles, MCP configuration, and
  codebase attachments are stored under Electron's per-user application-data
  directory.
- Connection secrets and MCP environment variables use OS-backed encryption
  when available; knowledge and skill content are intentionally readable JSON.
- The renderer has no direct Node.js or filesystem access. Privileged work is
  performed through a constrained preload bridge.
- Metadata Only is the safest AI mode; Read-Only adds guarded inspection but is
  not a substitute for a least-privilege database role.
- Removing a connection and detaching a codebase can delete related local data;
  read the confirmation or warning text before proceeding.
