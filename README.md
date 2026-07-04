# DB Desk

Minimal Electron + TypeScript + React + Vite + Monaco Editor foundation for a Mac desktop database client.

This bootstrap step intentionally does not include database connections, schema browsing, query execution, authentication, persistence, or AI features.

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
    index.ts
  preload/
    index.ts
  renderer/
    index.html
    src/
      main.tsx
      App.tsx
      components/
        SqlEditor.tsx
```

## Monaco Notes

Monaco is loaded from the local `monaco-editor` package through `@monaco-editor/react`. The renderer configures `loader.config({ monaco })` and registers Vite-bundled web workers with `?worker` imports, so the app does not depend on CDN-hosted Monaco assets and remains compatible with packaged Electron builds.
