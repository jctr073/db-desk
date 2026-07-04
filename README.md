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
a right-click menu. Query execution and AI features are not yet wired up.

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
    db.ts                # PostgreSQL connection pooling + catalog introspection
    store.ts             # saved-connection persistence (safeStorage-encrypted)
  preload/
    index.ts             # typed window.dbDesk bridge (db + store)
  shared/
    db.ts                # wire types shared by main, preload, and renderer
  renderer/
    index.html
    src/
      main.tsx
      App.tsx              # shell: title bar + 3 panes + dialog
      theme.ts             # light/dark theme hook (persisted)
      styles.css           # design tokens + component styles
      components/
        TitleBar.tsx
        EditorPanel.tsx    # tab bar chrome + Monaco editor
        AgentPanel.tsx
        SqlEditor.tsx
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
