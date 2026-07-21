# DB Desk

DB Desk is a macOS desktop database workspace for exploring PostgreSQL and
Databricks, writing and running SQL, inspecting results, and using an
AI-assisted workflow grounded in the connected schema. It combines a schema
browser, Monaco editor, result grid, persistent query files, local database
knowledge, reusable agent skills, MCP tools, and optional source-code context
in one Electron application.

- [User guide](docs/user-guide.md) — connections, queries, results, AI,
  knowledge, skills, and other day-to-day features
- [Technical architecture](docs/architecture.md) — runtime boundaries,
  dependencies, code structure, persistence, security, and testing

## Prerequisites

- macOS
- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) `20.19+` or `22.12+` and npm
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) only when
  running the integration tests

The Node.js minimum comes from the repository's Vite and electron-vite
toolchain. A current Node.js 22 release is the simplest choice.

## Run locally

```bash
git clone https://github.com/jctr073/db-desk.git
cd db-desk
npm ci
npm run dev
```

`npm ci` installs the exact dependency versions in `package-lock.json`. The
postinstall step also gives the development Electron bundle the DB Desk name
and icon on macOS.

The database features work without an AI provider key. To use the AI Agent,
provide an Anthropic API key either way:

- **In the app** — open Settings (gear in the status bar) → API Keys and
  paste a key; it is stored encrypted via the OS keychain.
- **Shell variable** — add the following to `~/.zshrc`:

  ```bash
  export CLAUDE_API_KEY="your-key"
  ```

  The variable name is configurable in Settings → API Keys.

DB Desk resolves the key per request, so the application does not need to be
restarted after the key is added.

## Build and preview

Compile the main process, preload bridge, and renderer into `out/`:

```bash
npm run build
```

The build command runs both TypeScript checks before producing the application
assets. Preview the compiled application with:

```bash
npm run preview
```

## Package the app and install it

Build the double-clickable application bundle (this compiles first, so a
separate `npm run build` is not required):

```bash
npm run package
```

The bundle lands at `dist/mac-arm64/DB Desk.app`. Install it into
`/Applications` (replacing any previous install — quit DB Desk first if it is
running):

```bash
npm run install:app
```

To also produce a shareable disk image at `dist/DB Desk-<version>-arm64.dmg`:

```bash
npm run package:dmg
```

The app is ad-hoc signed, not notarized: a locally built copy launches
normally, but a copy downloaded from elsewhere (e.g. the DMG fetched via a
browser) is quarantined by Gatekeeper and needs right-click → Open on first
launch.

## Tests

Run the fast, Docker-free unit suite:

```bash
npm run test:unit
```

Run the integration suite against the disposable PostgreSQL test database:

```bash
npm run test:integration
```

Run every test:

```bash
npm test
```

The integration setup starts and seeds PostgreSQL 17 on `localhost:55432`
automatically. The container remains available after the tests for inspection;
stop it with `npm run db:down`, or set `DBDESK_TEST_DOCKER_DOWN=1` to tear it
down automatically after the run.

## Useful commands

| Command                    | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `npm run dev`              | Start DB Desk in development mode with hot reload.          |
| `npm run build`            | Typecheck and compile production assets into `out/`.        |
| `npm run preview`          | Launch the compiled application. Run `build` first.         |
| `npm run package`          | Build and package `DB Desk.app` into `dist/mac-arm64/`.     |
| `npm run package:dmg`      | Same as `package`, plus a distributable DMG in `dist/`.     |
| `npm run install:app`      | Copy the packaged `DB Desk.app` into `/Applications`.       |
| `npm run typecheck`        | Typecheck the Electron and renderer TypeScript projects.    |
| `npm run lint`             | Check the repository with ESLint.                           |
| `npm run format`           | Format repository files with Prettier. This writes changes. |
| `npm run test:unit`        | Run the unit tests without Docker.                          |
| `npm run test:integration` | Run the live PostgreSQL integration tests.                  |
| `npm test`                 | Run the unit and integration projects.                      |
| `npm run db:up`            | Start and seed the disposable PostgreSQL test database.     |
| `npm run db:psql`          | Open `psql` in the running test container.                  |
| `npm run db:down`          | Stop the test database and discard its data.                |

Useful integration-test environment variables:

| Variable                    | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `DBDESK_TEST_PG_PORT`       | Override the default host port, `55432`.               |
| `DBDESK_TEST_PG_HOST`       | Use a different PostgreSQL host.                       |
| `DBDESK_TEST_NO_DOCKER=1`   | Use an already-running compatible PostgreSQL database. |
| `DBDESK_TEST_DOCKER_DOWN=1` | Remove the Docker test database after the suite.       |

## Learn more

See the [user guide](docs/user-guide.md) to start using DB Desk, or the
[technical architecture](docs/architecture.md) to understand and extend the
codebase.
