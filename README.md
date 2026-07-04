# DB Desk

Electron + TypeScript + React + Vite + Monaco Editor foundation for a Mac desktop database client.

The shell implements the DB Desk connection panel: a light/dark themed three-pane
layout with a schema browser tree (connections → databases → schemas → tables,
views, functions, and more), object filtering, two tree styles, and a New
Connection dialog. Connections are real: creating one connects to a live
PostgreSQL server (via discrete parameters or a connection URL), introspects the
catalog, and populates the tree with actual databases, schemas, tables, columns,
views, materialized views, indexes, functions, sequences, types, and aggregates.
Sibling databases are introspected lazily on first expand. Connections persist
across sessions (passwords encrypted at rest via Electron `safeStorage`) and are
restored offline on launch — reconnect, disconnect, and remove are available from
a right-click menu.

The SQL editor executes queries for real: a toolbar dropdown picks the
(connection, database) target, Run (or ⌘⏎) executes the statement under the
cursor — or the selection — and results land in a grid on the lower half of the
editor. Each run replaces the live results tab unless it is pinned, in which
case the next run opens a fresh tab; pinned tabs can be re-run and closed. Bare
SELECTs get an automatic `LIMIT 500` (configurable in the toolbar, including no
limit); statements that can't take an appended LIMIT are truncated to the same
cap after execution. AI features are not yet wired up.

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
```

## Project Structure

```text
src/
  main/
    index.ts             # app bootstrap + db/store IPC handlers
    db.ts                # PostgreSQL pooling, introspection + query execution
    store.ts             # saved-connection persistence (safeStorage-encrypted)
  preload/
    index.ts             # typed window.dbDesk bridge (db + store)
  shared/
    db.ts                # wire types shared by main, preload, and renderer
    sql.ts               # statement splitting + auto-LIMIT lexer (main + renderer)
  renderer/
    index.html
    src/
      main.tsx
      App.tsx              # shell: title bar + 3 panes + dialog
      theme.ts             # light/dark theme hook (persisted)
      styles.css           # design tokens + component styles
      components/
        TitleBar.tsx
        EditorPanel.tsx    # tab bar, target/limit toolbar, editor + results split
        AgentPanel.tsx
        SqlEditor.tsx
        ResultsPanel.tsx   # result tabs (live + pinned), grid, status bar
        useQueryRunner.ts  # result-tab state machine + query dispatch
        icons.tsx          # shared UI icons
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
```

## Monaco Notes

Monaco is loaded from the local `monaco-editor` package through `@monaco-editor/react`. The renderer configures `loader.config({ monaco })` and registers Vite-bundled web workers with `?worker` imports, so the app does not depend on CDN-hosted Monaco assets and remains compatible with packaged Electron builds.
