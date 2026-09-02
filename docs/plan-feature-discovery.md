# Plan: Feature discovery — registry, command palette, Discover, highlight mode, `/help`

DB Desk has grown a lot of functionality that lives behind gestures: context menus (Add
Selection to AI Chat, Save as exemplar…, right-click the grid), overflow menus (Close all
results), keyboard-only actions (Shift/⌘ grid selection, keyboard column resize), and
cog-menu toggles (Web browsing). The user guide (`docs/user-guide.md`, ~440 lines) is the
only place most of it is described. Today the renderer has **no** command palette, help
menu, shortcut overlay, onboarding, or usage tracking, and tooltips are raw `title`
attributes.

This plan adds five things, one phase each, each independently shippable:

| Phase | Deliverable                                                                           | Depends on |
| ----- | ------------------------------------------------------------------------------------- | ---------- |
| 1     | **Feature registry** + app-level command dispatch + **command palette (⌘K)**          | —          |
| 2     | **Help menu** (Electron menu bar), **shortcut overlay (⌘/)**, in-app **guide viewer** | 1          |
| 3     | **Spotlight** primitive, **Discover** browser with "Show me", usage tracking          | 1, 2       |
| 4     | **Highlight mode** (numbered beacons on every anchored control)                       | 3          |
| 5     | **`/help`** — ask the agent, grounded in the guide, with a `highlight_feature` tool   | 3          |

The one idea that makes all five cheap: **a single feature registry is the source of
truth.** The palette, shortcut overlay, Discover list, beacons, and the `/help` prompt all
read from it, so the UI, the docs, and the help system cannot drift apart. Build the
registry first and resist adding feature copy anywhere else.

Do one phase per branch/PR. Do not start a phase until the previous one is merged.

---

## 0. Decisions (do not re-litigate during implementation)

| Question                                                         | Decision                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where does the registry live?                                    | `src/shared/features.ts` — **pure data, no React, no DOM, no Electron imports.** Main needs it for the `/help` prompt; the renderer needs it for everything else; unit tests need it to be importable in node.                                                                                                                                                                       |
| Where do the _behaviours_ (what "Run query" actually does) live? | In the renderer only: a typed `Record<CommandId, () => void>` built in `App.tsx` (§2.3). Data and behaviour are split on purpose. TypeScript's `satisfies` makes forgetting a handler a compile error.                                                                                                                                                                               |
| How are UI elements linked to registry entries?                  | A `data-feature="<feature id>"` attribute on the DOM element. No refs plumbed through props. Spotlight / beacons find elements with `document.querySelector('[data-feature="…"]')`.                                                                                                                                                                                                  |
| Features that live in a menu the user must open first?           | Every entry has a **`location`** sentence ("Right-click the results grid") and an optional **`reveal`** command that opens the container (e.g. switch the right panel to Knowledge) before spotlighting. If the element still isn't in the DOM, Spotlight falls back to a centred card that shows `location`. **This is how hidden features get discovered**; never drop `location`. |
| Fuzzy search library?                                            | **No new dependencies.** A ~40-line scorer in `src/renderer/src/discovery/search.ts` (substring + word-prefix + subsequence), unit-tested.                                                                                                                                                                                                                                           |
| Where does per-user state (tips seen, features tried) persist?   | `settings.json` via the existing main-process settings store, as one opaque `discovery` object (§4.4). It survives profile resets that clear `localStorage`. Reads/writes go through one renderer module (`discovery/usage.ts`) so the storage can change later in one file.                                                                                                         |
| How does the app get the user guide text at runtime?             | `electron-builder.yml` **excludes `docs/**` and `*.md` from the bundle**, so it cannot be read from disk in a packaged app. Import it as a string: `import guideMd from '../../docs/user-guide.md?raw'` (Vite `?raw`, works in both the renderer and the main build under electron-vite). It is inlined into the compiled output.                                                    |
| Electron application menu                                        | `src/main/index.ts` currently sets **no** menu, so Electron's default menu supplies Edit › Copy/Paste etc. When we add a Help menu we must build the **whole** menu from role-based templates (`appMenu`, `editMenu`, `viewMenu`, `windowMenu`) plus our Help menu, otherwise ⌘C/⌘V stop working on macOS.                                                                           |
| Global shortcut handling                                         | One `window` keydown listener in **capture** phase (`useGlobalShortcuts`, §2.4) for ⌘K, ⌘/ and ⌘⇧/. Monaco swallows key events, so the _same_ chords are also registered on the editor with `editor.addCommand` (the pattern already used for ⌘S/⌘Enter in `EditorPanel.tsx` ≈ line 450). Do not add other global shortcuts in phase 1–5.                                            |
| Interactive multi-step tours / first-run wizard?                 | **Out of scope.** Discover + Spotlight covers it on demand.                                                                                                                                                                                                                                                                                                                          |
| Which model answers `/help`?                                     | The chat's currently selected model. No special-casing.                                                                                                                                                                                                                                                                                                                              |
| Does `/help` get SQL/schema/knowledge tools?                     | **No.** A help turn gets exactly one tool, `highlight_feature`, and no schema summary. It is cheap and cannot touch the database.                                                                                                                                                                                                                                                    |

---

## 1. Current-state map (read these before coding)

| File                                                    | Role today / what changes                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/App.tsx` (622 lines)                  | Composes the three columns + `StatusBar`, owns dialogs (`SettingsDialog`, `NewConnectionDialog`, …), `openSettings`, `askAgent` (seeds the composer via `agentSeed`), `openAgentPanel` (bumps `agentTabSeq`). All new command handlers are built here. |
| `src/renderer/src/components/editorBridge.ts`           | `EditorBridge` ref (`getActiveSql`, `getSelection`, `insertSql`, `proposeSql`) registered by the editor on mount so the agent can reach it. **Extend** it with editor/result commands (§2.2) instead of lifting state out of `EditorPanel`.            |
| `src/renderer/src/components/EditorPanel.tsx`           | Owns Monaco, the run/save handlers, the results tabs. Registers ⌘S/⌘Enter via `editor.addCommand` (~line 450).                                                                                                                                         |
| `src/renderer/src/components/editor/EditorTabStrip.tsx` | Toolbar with inline `<kbd>` hints (⌘⏎ run, ⌘S save, ⇧⌘F format).                                                                                                                                                                                       |
| `src/renderer/src/components/ResultsPanel.tsx`          | `onPin`, export menu, pinned tabs, overflow menu.                                                                                                                                                                                                      |
| `src/renderer/src/components/AgentPanel.tsx`            | Right column: `activeTab: 'files' \| 'agent' \| 'knowledge' \| 'skills'` (line 145), `seed` prefill (lines 334–339), manage-KB dialog, cog menu.                                                                                                       |
| `src/renderer/src/components/agent/Composer.tsx`        | Slash menu: `slashMatches` (regex `^/([a-z]*)$`), `runSlashCommand` (`clear`, `compact`).                                                                                                                                                              |
| `src/shared/agent.ts`                                   | `AGENT_SLASH_COMMANDS`, `AgentPromptIntent = 'chat' \| 'fix-query'`, `AgentSendRequest`, `AgentEvent` union (incl. `editor_proposal`).                                                                                                                 |
| `src/renderer/src/components/agent/useChatSession.ts`   | Renderer side of a turn; `case 'editor_proposal'` (line 262) is the model for handling a new `ui_action` event. `sendPrompt(prompt, target, forceRepo, intent, kbId)`.                                                                                 |
| `src/main/agent.ts`                                     | `runAgentTurn(req, send, opts)`: builds tools (line ≈328), system prompt, dispatches `tool_use` blocks by name (≈482–506).                                                                                                                             |
| `src/main/agent/tools.ts`, `executors.ts`, `prompt.ts`  | Declarative tool defs / executors / `buildSystemPrompt`. `execWriteEditor` (executors ≈364) is the model for a tool whose effect is an event to the renderer.                                                                                          |
| `src/shared/ipc.ts`                                     | Typed IPC contract: `IpcInvokeContract` (request/response) and `IpcPushContract` (main → renderer). Every new channel goes here first.                                                                                                                 |
| `src/preload/index.ts`                                  | `window.dbDesk.<ns>` bridges (`settings`, `agent`, …). `typedInvoke` / `typedOn`.                                                                                                                                                                      |
| `src/main/settings.ts`, `src/shared/settings.ts`        | `StoredSettings` (private, `settings.json` in userData, atomic write) and `AppSettingsInfo` (wire type).                                                                                                                                               |
| `src/main/index.ts`                                     | Creates the `BrowserWindow`; imports only `app, BrowserWindow, dialog, shell`. No `Menu`. `openExternalChecked(url)` at line 126.                                                                                                                      |
| `src/renderer/src/useEscapeKey.ts`                      | Window-level Escape hook used by every dialog/popover. Use it for the palette, overlay, Discover and Spotlight.                                                                                                                                        |
| `src/renderer/src/styles.css`                           | Tokens at top (`--panel`, `--panel-hi`, `--accent`, `--accent-soft`, `--border`, `--text-dim`, `--shadow`); `.dialog-overlay`/`.dialog` ≈2138; `.empty-state` ≈687; `.slash-pop` ≈4489; `.statusbar` ≈256.                                             |
| `test/unit/markdown.test.ts` → renderer markdown module | The existing Markdown renderer (used by `FilePreview`). Reused for the guide viewer; needs heading ids (§3.3).                                                                                                                                         |
| `docs/user-guide.md`                                    | Ground truth for feature copy. Heading slugs become registry `guide` anchors.                                                                                                                                                                          |

---

## 2. Phase 1 — Feature registry, command dispatch, command palette (⌘K)

Outcome: pressing ⌘K anywhere opens a palette listing every feature; typing filters it;
Enter runs the feature's command or, for features without a command, shows its
`location`. No spotlight yet.

### 2.1 `src/shared/features.ts` — the registry

```ts
export type FeatureCategory =
  | 'connections'
  | 'schema'
  | 'editor'
  | 'results'
  | 'agent'
  | 'knowledge'
  | 'files'
  | 'skills'
  | 'app'

/** Renderer-side behaviours the palette/Discover/Help menu can trigger. */
export const COMMAND_IDS = [
  'app.openSettings',
  'app.openPalette',
  'app.openShortcuts',
  'app.openGuide',
  'app.openDiscover',
  'app.toggleHighlight',
  'connections.new',
  'editor.newQuery',
  'editor.run',
  'editor.save',
  'editor.format',
  'results.pin',
  'results.export',
  'results.closeAll',
  'panel.showAgent',
  'panel.showKnowledge',
  'panel.showFiles',
  'panel.showSkills',
  'agent.newChat',
  'agent.focusComposer',
  'agent.askHelp',
  'knowledge.manage'
] as const
export type CommandId = (typeof COMMAND_IDS)[number]

export interface Feature {
  /** Stable id, dotted, lower-case. Also the default `data-feature` anchor. */
  id: string
  title: string
  /** One sentence, ≤ 120 chars, present tense, no trailing period. */
  description: string
  category: FeatureCategory
  /** Where it is in the UI, written for someone who has never seen it. Required. */
  location: string
  /** Display form only, e.g. '⌘⏎'. Not parsed. */
  shortcut?: string
  /** Heading slug in docs/user-guide.md, e.g. 'read-and-manage-results'. */
  guide: string
  /** Command the palette runs for this feature; omit for gesture-only features. */
  command?: CommandId
  /** Command that makes the anchored element visible (opens a tab/menu) before spotlighting. */
  reveal?: CommandId
  /** Override the data-feature selector value when one element hosts several features. */
  anchor?: string
  /** Free-text search boosters, e.g. ['tsv', 'csv'] for Export. */
  keywords?: string[]
}

export const FEATURES: readonly Feature[] = [/* §2.1.1 */]

export function featureById(id: string): Feature | undefined
export function slugifyHeading(text: string): string // GitHub-style: lower, strip punctuation, spaces→'-'
```

Rules for the implementer:

- `id` never changes once shipped (usage state is keyed by it).
- `location` is mandatory and must make sense with the element _not_ highlighted.
- `guide` must be a real heading slug in `docs/user-guide.md`; the unit test in §8 enforces it.
- Keep it flat — no nesting, no React.

#### 2.1.1 Initial registry contents

Transcribe these (descriptions may be tightened, ids and `guide` slugs must match). `cmd` =
`command`, `rv` = `reveal`.

| id                           | title                            | category    | location                                                              | shortcut | guide                                  | cmd / rv                            |
| ---------------------------- | -------------------------------- | ----------- | --------------------------------------------------------------------- | -------- | -------------------------------------- | ----------------------------------- |
| `connections.new`            | New connection                   | connections | "+" at the top of the Connections panel                               |          | `connect-to-a-database`                | cmd `connections.new`               |
| `connections.environment`    | Environment (dev/stage/prod)     | connections | Connection dialog › Environment; prod clamps the agent to Read & Run  |          | `saved-connections`                    |                                     |
| `schema.tree`                | Schema tree                      | schema      | Below the connection in the Connections panel                         |          | `browse-the-schema`                    |                                     |
| `schema.filter`              | Filter the schema tree           | schema      | Filter box above the tree                                             |          | `browse-the-schema`                    |                                     |
| `schema.dataPreview`         | Preview table data               | schema      | Right-click a table › Preview data                                    |          | `browse-the-schema`                    |                                     |
| `schema.addToAgent`          | Add schema object to AI chat     | schema      | Right-click a schema/table/view › Add to AI chat                      |          | `agent-context`                        | rv `panel.showAgent`                |
| `editor.newQuery`            | New query file                   | editor      | "+" in the editor tab strip, or a connection's context menu           |          | `work-with-files-and-the-editor`       | cmd `editor.newQuery`               |
| `editor.run`                 | Run SQL                          | editor      | Run button in the editor toolbar                                      | ⌘⏎       | `run-sql`                              | cmd `editor.run`                    |
| `editor.save`                | Save file                        | editor      | Editor toolbar                                                        | ⌘S       | `work-with-files-and-the-editor`       | cmd `editor.save`                   |
| `editor.format`              | Format SQL                       | editor      | Editor toolbar                                                        | ⇧⌘F      | `work-with-files-and-the-editor`       | cmd `editor.format`                 |
| `editor.rename`              | Rename a file                    | editor      | Right-click an editor tab › Rename                                    |          | `work-with-files-and-the-editor`       |                                     |
| `editor.preview`             | Render Markdown / JSON / text    | editor      | Eye control in the toolbar of a non-SQL file                          |          | `work-with-files-and-the-editor`       |                                     |
| `editor.addSelectionToAgent` | Add selection to AI chat         | editor      | Select SQL, right-click › Add Selection to AI Chat                    |          | `agent-context`                        | rv `panel.showAgent`                |
| `editor.undoAiChange`        | Undo an accepted AI change       | editor      | ⌘Z in the editor after accepting a diff                               | ⌘Z       | `review-generated-work`                |                                     |
| `results.limit`              | Row limit                        | results     | Limit control in the results toolbar (default 500)                    |          | `run-sql`                              |                                     |
| `results.pin`                | Pin a result                     | results     | Pin icon on the live result tab                                       |          | `read-and-manage-results`              | cmd `results.pin`                   |
| `results.closeAll`           | Close all results                | results     | Overflow (») menu at the right of the result tabs                     |          | `read-and-manage-results`              | cmd `results.closeAll`              |
| `results.select`             | Select rows, columns, ranges     | results     | Click a row number or column header; Shift for a range, ⌘ to toggle   |          | `read-and-manage-results`              |                                     |
| `results.resizeKeyboard`     | Resize columns with the keyboard | results     | Focus a column edge, then use ← →                                     |          | `read-and-manage-results`              |                                     |
| `results.addToAgent`         | Add results to AI chat           | results     | Right-click the grid › Add selection / result to AI chat              |          | `agent-context`                        | rv `panel.showAgent`                |
| `results.export`             | Export CSV / TSV / JSON          | results     | Export button in the results toolbar; selections constrain the export |          | `export-results`                       | cmd `results.export`                |
| `results.fixWithAi`          | Fix with AI                      | results     | Appears on a failed query's result tab                                |          | `review-generated-work`                |                                     |
| `results.saveExemplar`       | Save as exemplar                 | results     | Results toolbar › Save as exemplar…                                   |          | `run-sql`                              |                                     |
| `agent.modes`                | Agent access modes               | agent       | Mode picker at the top of the AI Agent tab                            |          | `access-modes`                         | rv `panel.showAgent`                |
| `agent.context`              | Context chips                    | agent       | "Add context" in the composer                                         |          | `agent-context`                        | rv `panel.showAgent`                |
| `agent.diffReview`           | Accept / reject AI edits         | agent       | Inline diff in the editor after the agent writes SQL                  | Esc      | `review-generated-work`                |                                     |
| `agent.loadFinalQuery`       | Load final query                 | agent       | Recap line at the end of a turn                                       |          | `review-generated-work`                |                                     |
| `agent.newChat`              | New chat / chat history          | agent       | Buttons in the AI Agent tab header                                    |          | `sessions-web-search-and-context-size` | cmd `agent.newChat`                 |
| `agent.compact`              | /compact and /clear              | agent       | Type "/" in the composer                                              |          | `sessions-web-search-and-context-size` | rv `agent.focusComposer`            |
| `agent.webSearch`            | Web browsing toggle              | agent       | Cog menu in the composer                                              |          | `sessions-web-search-and-context-size` | rv `panel.showAgent`                |
| `agent.mcp`                  | MCP servers                      | agent       | Cog menu › MCP servers                                                |          | `mcp-servers`                          | rv `panel.showAgent`                |
| `agent.help`                 | Ask DB Desk how to do something  | agent       | Type "/help" followed by a question in the composer                   |          | `use-the-ai-agent`                     | cmd `agent.askHelp` (phase 5)       |
| `knowledge.bases`            | Knowledge bases                  | knowledge   | Knowledge tab in the right panel                                      |          | `build-local-database-knowledge`       | rv `panel.showKnowledge`            |
| `knowledge.manage`           | Manage knowledge bases           | knowledge   | Knowledge tab › Manage                                                |          | `build-local-database-knowledge`       | cmd `knowledge.manage`              |
| `knowledge.attachCodebase`   | Attach and scan a codebase       | knowledge   | Manage Knowledge Bases › a base's code-path card                      |          | `attach-and-scan-a-codebase`           | cmd `knowledge.manage`              |
| `knowledge.monorepo`         | Map a monorepo to schemas        | knowledge   | Manage Knowledge Bases › Monorepo setup                               |          | `map-a-monorepo-to-its-schemas`        | cmd `knowledge.manage`              |
| `knowledge.backgroundScans`  | Background scan agents           | knowledge   | Agents segment in the status bar opens the tray                       |          | `attach-and-scan-a-codebase`           |                                     |
| `files.panel`                | SQL Files tab                    | files       | SQL Files tab in the right panel                                      |          | `work-with-files-and-the-editor`       | rv `panel.showFiles`                |
| `files.watchedFolders`       | Watched folders                  | files       | Settings › Files, then the Folders mode of the SQL Files tab          |          | `work-with-files-and-the-editor`       | cmd `app.openSettings`              |
| `skills.create`              | Create and run skills            | skills      | Skills tab in the right panel                                         |          | `create-and-run-skills`                | rv `panel.showSkills`               |
| `app.settings`               | Settings                         | app         | Gear at the left of the status bar                                    |          | `get-oriented`                         | cmd `app.openSettings`              |
| `app.resizePanels`           | Resize panels                    | app         | Drag either vertical divider; widths are remembered                   |          | `get-oriented`                         |                                     |
| `app.palette`                | Command palette                  | app         | ⌘K anywhere                                                           | ⌘K       | `get-oriented`                         | cmd `app.openPalette`               |
| `app.shortcuts`              | Keyboard shortcuts               | app         | Help › Keyboard Shortcuts                                             | ⌘/       | `get-oriented`                         | cmd `app.openShortcuts` (phase 2)   |
| `app.discover`               | Discover features                | app         | Help › Discover Features                                              |          | `get-oriented`                         | cmd `app.openDiscover` (phase 3)    |
| `app.highlight`              | Highlight mode                   | app         | Help › Highlight Features                                             | ⌘⇧/      | `get-oriented`                         | cmd `app.toggleHighlight` (phase 4) |

All `guide` slugs above exist in the guide today (the §8 test keeps it that way). Commands marked "phase N" are registered in `COMMAND_IDS` in
phase 1 but their handlers are no-ops that show a small notice until that phase lands.

### 2.2 Extend `EditorBridge` with editor/result commands

In `src/renderer/src/components/editorBridge.ts` add:

```ts
export interface EditorCommands {
  runActive: () => void            // same code path as the Run button / ⌘⏎
  saveActive: () => void
  formatActive: () => void
  newQuery: () => void             // same as the "+" in the tab strip
  pinActiveResult: () => void      // no-op if no live result
  openExportMenu: () => void       // opens the export popover as if clicked
  closeAllResults: () => void
  canRun: () => boolean            // for greying-out palette rows
}
export interface EditorBridge { …existing…; commands: EditorCommands }
```

`useEditorBridge.ts` fills `commands` from the handlers `EditorPanel` already has. For
`openExportMenu` / `pinActiveResult`, `ResultsPanel` exposes them through a small
`MutableRefObject<ResultsCommands | null>` prop that `EditorPanel` forwards into the
bridge. **Do not** refactor state upward; the ref pattern is the established way the agent
already reaches the editor.

### 2.3 `src/renderer/src/discovery/useCommands.ts` — the dispatch table

```ts
export type CommandHandlers = Record<CommandId, () => void>
export function useCommands(deps: {...}): { run: (id: CommandId) => void; enabled: (id: CommandId) => boolean }
```

Built once in `App.tsx` with `useMemo`, using `satisfies CommandHandlers` on the object
literal so a missing `CommandId` fails `npm run typecheck`. Handlers map to things App
already has:

| Command                                                        | Handler                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `app.openSettings`                                             | `openSettings()`                                                                                                 |
| `app.openPalette`                                              | `setPaletteOpen(true)`                                                                                           |
| `connections.new`                                              | the `useConnectionState` setter that flips `connections.dialogOpen` (the flag `NewConnectionDialog` renders on)  |
| `editor.*`, `results.*`                                        | `editorBridge.current?.commands.<fn>()`                                                                          |
| `panel.show*`                                                  | new `setAgentTab(tab)` prop on `AgentPanel` — generalise the existing one-shot `agentTabSeq` into `{ seq, tab }` |
| `agent.newChat`                                                | via a new one-shot request like `agentTabSeq` (`agentNewChatSeq`)                                                |
| `agent.focusComposer`                                          | `panel.showAgent` + focus request seq; `Composer` focuses its textarea when the seq changes                      |
| `knowledge.manage`                                             | `panel.showKnowledge` + a `manageSeq` one-shot that `AgentPanel` turns into `setManageOpen(true)`                |
| `agent.askHelp`                                                | phase 5; until then `panel.showAgent`                                                                            |
| `app.openShortcuts`, `app.openDiscover`, `app.toggleHighlight` | phase 2–4; until then no-op                                                                                      |

`run(id)` also calls `usage.markUsed(featureIdForCommand(id))` once phase 3 exists; in
phase 1 leave a `// phase 3: markUsed` comment.

The "one-shot seq" pattern is already used for `agentTabSeq` / `seed` — copy it rather than
inventing a new event bus.

### 2.4 `src/renderer/src/discovery/useGlobalShortcuts.ts`

- `window.addEventListener('keydown', handler, { capture: true })`.
- ⌘K → `run('app.openPalette')`; ⌘/ → `run('app.openShortcuts')`; ⌘⇧/ → `run('app.toggleHighlight')`.
- Ignore when a native `<input>`/`<textarea>` has focus **only** for keys that type
  characters; ⌘-chords are safe everywhere.
- `event.preventDefault()` + `stopPropagation()` on a match.
- In `EditorPanel.tsx` next to the existing ⌘S/⌘Enter registrations, add `editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyK, …)` (and ⌘/) that call the same `run()` — pass `run` into `EditorPanel` as an `onCommand` prop. Monaco owns focus inside the editor; without this the chord never reaches `window`.

### 2.5 `src/renderer/src/discovery/search.ts` (pure, tested)

```ts
export interface Searchable {
  id: string
  title: string
  description: string
  keywords?: string[]
  category: string
}
export function scoreMatch(query: string, item: Searchable): number // 0 = no match
export function searchFeatures<T extends Searchable>(query: string, items: T[], limit?: number): T[]
```

Scoring (higher wins): title starts with query 100; a title word starts with query 80;
title contains 60; keyword equals/starts 50; description contains 30; subsequence of
title 10. Case-insensitive, trim. Empty query returns items in registry order.

### 2.6 `src/renderer/src/components/CommandPalette.tsx`

- Overlay + centred panel, reuse `.dialog-overlay`; new `.palette*` classes (§7).
- Input at top, list below, max 12 rows visible, `↑ ↓ Enter Esc`, mouse hover selects.
- Row: category tag · title · description (dim) · shortcut `<kbd>` right-aligned.
- Rows for features **with** a `command`: Enter runs it and closes.
- Rows for gesture-only features: Enter closes the palette and shows a 4-second toast
  (`.palette-toast`) with `location`. (Phase 3 replaces the toast with Spotlight.)
- Disabled rows (`enabled(id) === false`, e.g. Run with no connection): rendered dim,
  Enter does nothing.
- Empty query: "Recently used" first (from phase 3 usage; empty until then), then all
  features grouped by category.
- Last row when there is a query: `Ask DB Desk: "<query>"` → phase 5; until then hide it.
- `useEscapeKey(open, close)`. Mount in `App.tsx` beside the other dialogs.

Files touched in phase 1: `src/shared/features.ts` (new), `discovery/{useCommands,useGlobalShortcuts,search}.ts` (new), `components/CommandPalette.tsx` (new), `editorBridge.ts`, `editor/useEditorBridge.ts`, `EditorPanel.tsx`, `ResultsPanel.tsx`, `AgentPanel.tsx` (tab/manage/newChat/focus one-shots), `App.tsx`, `styles.css`, tests (§8).

---

## 3. Phase 2 — Help menu, shortcut overlay (⌘/), guide viewer

Outcome: a real Help menu in the macOS menu bar; ⌘/ shows a shortcut sheet derived from
the registry; "User Guide" opens the bundled guide inside the app, scrolled to a section.

### 3.1 Application menu — `src/main/menu.ts` (new)

```ts
export function installApplicationMenu(send: (id: string) => void): void
```

`Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' },
{ role: 'viewMenu' }, { role: 'windowMenu' }, helpMenu])` then `Menu.setApplicationMenu`.
Call it from `app.whenReady` in `src/main/index.ts` after the window exists. Help items:

| Label              | Sends command         | Accelerator |
| ------------------ | --------------------- | ----------- |
| User Guide         | `app.openGuide`       |             |
| Keyboard Shortcuts | `app.openShortcuts`   | Cmd+/       |
| Command Palette…   | `app.openPalette`     | Cmd+K       |
| Discover Features… | `app.openDiscover`    |             |
| Highlight Features | `app.toggleHighlight` | Cmd+Shift+/ |
| — separator —      |                       |             |
| Ask DB Desk…       | `agent.askHelp`       |             |

Accelerators here are **display + fallback**; the renderer's capture listener normally
wins. Remove the `viewMenu` dev-tools items in packaged builds if they look wrong; leave
otherwise.

IPC: add to `IpcPushContract` in `src/shared/ipc.ts`:

```ts
'ui:command': [commandId: string]
```

Preload: `ui: Object.freeze({ onCommand: (cb: (id: string) => void) => typedOn('ui:command', cb) })`.
Renderer (`App.tsx`): subscribe once; validate `COMMAND_IDS.includes(id)` before `run(id)`
(main is trusted, but the check keeps the type narrow).

### 3.2 `src/renderer/src/components/ShortcutOverlay.tsx`

Reads `FEATURES.filter(f => f.shortcut)`, groups by category, renders a two-column sheet
of `title` + `<kbd>`. Same overlay/dialog chrome as the palette. Esc/click-outside closes.
Also refactor `EditorTabStrip.tsx`'s three hard-coded `<kbd>` hints to read
`featureById('editor.run').shortcut` etc., so the strip and the sheet cannot disagree.

### 3.3 Guide viewer — `src/renderer/src/components/GuideDialog.tsx`

- `import guideMd from '../../../../docs/user-guide.md?raw'` (adjust relative path; add a
  `declare module '*.md?raw'` in the renderer's `env.d.ts` if TS complains).
- Render with the existing Markdown renderer. **Add heading ids** to that renderer using
  `slugifyHeading` from `src/shared/features.ts` (same function the §8 test uses, so the
  slugs in the registry are guaranteed to match rendered ids).
- Props: `open`, `anchor?: string`, `onClose`. On open, `scrollIntoView` the heading whose
  id equals `anchor`.
- Links to `../README.md` etc. inside the guide: render as plain text or open externally
  via `window.dbDesk.shell.openExternal` if such a bridge exists; do not add one for this.
- Command `app.openGuide` opens it with no anchor; palette/Discover rows call
  `openGuide(feature.guide)`.

---

## 4. Phase 3 — Spotlight, Discover browser, usage tracking

Outcome: a "Discover" dialog lists every feature by category with a **Show me** button that
highlights the real control (or explains where it lives), a **Learn more** link into the
guide viewer, and a "tried" tick driven by real usage.

### 4.1 `src/renderer/src/discovery/Spotlight.tsx` — the primitive everyone else uses

```ts
export interface SpotlightRequest {
  featureId: string
  queue?: string[]
} // queue: ids to show after this one ("Next")
export function useSpotlight(): {
  show: (req: SpotlightRequest) => void
  hide: () => void
  current: string | null
}
```

Behaviour, in order:

1. Run `feature.reveal` (if any) through `commands.run`.
2. On the next 10 animation frames, look for `[data-feature="<anchor ?? id>"]`.
3. If found and it has a non-zero rect: render a fixed full-window layer with a cut-out
   (`box-shadow: 0 0 0 9999px rgba(0,0,0,.45)` on an absolutely-positioned rect with 6px
   padding and 6px radius) and a card near the element (below if room, else above) with
   `title`, `description`, `location`, **Learn more** (guide anchor), **Next** when a queue
   remains, **Done**. Reposition on `resize` and on any `scroll` (capture) event.
4. If not found: same card, centred, prefixed with "Where to find it:" and the `location`
   sentence. This is the expected path for context-menu features. Never show nothing.
5. Esc, clicking the dim layer, or Done hides it. The layer must not block the spotlit
   element (`pointer-events: none` on the cut-out rect; the backdrop uses
   `pointer-events: auto` only where it is dark — simplest: four backdrop rectangles
   around the hole rather than one with a shadow. Pick whichever the implementer finds
   simpler; correctness of clicks on the element matters more than the effect).
6. Mark the feature `seen` in usage (§4.4) when shown.

Provide the hook via a small React context (`DiscoveryProvider` in `App.tsx`) so
`CommandPalette`, `DiscoverDialog`, `HighlightMode` and `useChatSession` can all call
`show()` without prop-drilling.

### 4.2 Anchoring the UI — add `data-feature` attributes

Add `data-feature="<id>"` to the element that best represents each feature for which an
element exists. Minimum set for this phase (the rest fall back to `location`):

| Feature                                                                                      | Element                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `connections.new`                                                                            | the "+" button in `ConnectionPanel`                                        |
| `schema.filter`                                                                              | the filter input                                                           |
| `editor.newQuery`, `editor.run`, `editor.save`, `editor.format`, `editor.preview`            | the toolbar buttons in `EditorTabStrip`                                    |
| `results.limit`, `results.pin`, `results.export`, `results.saveExemplar`, `results.closeAll` | the results toolbar controls / overflow button                             |
| `results.select`, `results.addToAgent`                                                       | the grid root (`DataGrid`)                                                 |
| `agent.modes`, `agent.context`, `agent.webSearch`, `agent.mcp`, `agent.compact`              | mode picker, Add-context button, cog button (for both cog items), textarea |
| `agent.newChat`                                                                              | New chat button                                                            |
| `knowledge.manage`                                                                           | the Manage button in `KnowledgePanel`                                      |
| `knowledge.backgroundScans`                                                                  | the agents segment in `StatusBar`                                          |
| `files.panel`, `skills.create`, `knowledge.bases`                                            | the right-panel tab buttons                                                |
| `app.settings`                                                                               | the gear in `StatusBar`                                                    |
| `app.resizePanels`                                                                           | the left divider                                                           |

Rule: one element per feature; if two features share an element, set `anchor` on the
second to the first's id.

### 4.3 `src/renderer/src/components/DiscoverDialog.tsx`

- Left rail: categories with counts ("Results 9 · 4 tried"); right: cards for the selected
  category. Copy the rail/detail layout from `ManageKnowledgeDialog` (`.manage-kb*`).
- Card: title, description, `location` in dim text, shortcut `<kbd>` if any, buttons
  **Show me** (→ `spotlight.show({featureId})`; the dialog closes first so the element is
  visible) and **Learn more** (→ guide viewer at `guide`), and a tick when `usage.used[id]`
  or `usage.seen[id]`.
- Header: overall progress "23 of 46 tried" and a **Show me all in <category>** button →
  `spotlight.show({ featureId: first, queue: rest })`.
- Command `app.openDiscover` opens it. Palette empty-state footer gets a "Browse all
  features" row that opens it.

### 4.4 Usage tracking

Shared type in `src/shared/settings.ts`:

```ts
export interface DiscoveryState {
  /** feature id → { count, last (ms epoch) } for commands the user ran (any surface). */
  used: Record<string, { count: number; last: number }>
  /** feature ids spotlighted at least once. */
  seen: string[]
  /** last app version for which "what's new" was shown (reserved; unused for now). */
  seenVersion?: string
}
```

- `StoredSettings.discovery?: DiscoveryState` in `src/main/settings.ts`.
- IPC in `IpcInvokeContract`: `'settings:getDiscovery': { args: []; result: DiscoveryState }`,
  `'settings:setDiscovery': { args: [state: DiscoveryState]; result: void }`. Guard the
  incoming object in main with a small validator in `ipcGuards.ts` (shape + string ids +
  finite numbers; drop unknown ids not in `FEATURES`).
- Renderer `src/renderer/src/discovery/usage.ts`: loads once at startup, keeps an
  in-memory copy, `markUsed(id)`, `markSeen(id)`, debounced (1 s) `setDiscovery` write.
  Exposed through the same `DiscoveryProvider`.
- Instrument real usage, not just palette usage: call `markUsed` in the actual handlers
  for run/save/pin/export/newChat/manage (one line each in the places the buttons already
  call). This is what makes the Discover ticks honest.

---

## 5. Phase 4 — Highlight mode

Outcome: ⌘⇧/ (or Help › Highlight Features) draws a numbered beacon on every anchored,
visible control; clicking a beacon opens its Spotlight card; Esc exits. This is the
"hover over things and features show up" idea, built on phase 3 with almost no new logic.

`src/renderer/src/discovery/HighlightMode.tsx`:

- When active, collect `document.querySelectorAll('[data-feature]')`, keep those with a
  non-zero rect inside the viewport, dedupe by feature id, and render a fixed layer of
  beacons (`.beacon`, 18px circle, `--accent` fill, white number, positioned at the
  element's top-right corner). Recompute on `resize`, `scroll` (capture) and every 500 ms
  while active (cheap; there are < 50 anchors). No MutationObserver.
- Hover a beacon → tooltip with the title (`title` attr is enough). Click → `spotlight.show({featureId})`
  and keep highlight mode on underneath so the user can continue.
- A small banner at the top centre: "Highlight mode — click a beacon to learn about it · Esc
  to exit", with a **Show unanchored features** link that opens Discover, because gesture-only
  features (context menus) have no beacon by design.
- `useEscapeKey(active, exit)`. Toggle command `app.toggleHighlight`; palette row text
  flips between "Highlight features" and "Exit highlight mode".

---

## 6. Phase 5 — `/help`: ask the agent, grounded in the guide

Outcome: typing `/help how do I export the full result` in the composer (or Help › Ask DB
Desk…, or the palette's "Ask DB Desk" row) gets an answer written from the user guide and
the registry, and the agent can highlight the control it is talking about.

### 6.1 Shared types (`src/shared/agent.ts`)

- `AgentPromptIntent = 'chat' | 'fix-query' | 'help'`.
- Add `{ name: 'help', description: 'Ask how to do something in DB Desk' }` to `AGENT_SLASH_COMMANDS`.
- New `AgentEvent` member:

```ts
| { type: 'ui_action'; chatId: string; action: 'spotlight'; featureId: string }
```

### 6.2 Composer (`Composer.tsx`, `useChatSession.ts`)

- The slash menu regex stays; `/help` alone in the menu → `runSlashCommand('help')` sets
  `input` to `/help ` (with trailing space, cursor at end) and `setDraftIntent('help')`.
- In `send()` (useChatSession): if the input matches `^/help\s+(.+)$`, strip the prefix and
  call `sendPrompt(question, target, false, 'help')`. A bare `/help` sends the fixed
  question `"Give me a short overview of what I can do in DB Desk from where I am now."`.
- Show a small "Help" chip beside the target while `draftIntent === 'help'` so the user
  sees it will not touch the database. Reset the intent after send (already done for
  fix-query).
- `case 'ui_action'`: `if (evt.action === 'spotlight') spotlight.show({ featureId })` and
  append a transcript part `{ kind: 'notice', text: 'Highlighted: <title>' }`. Import
  `useSpotlight` from the provider; `useChatSession` already receives `editorBridge`, add
  `spotlight` the same way.
- Palette (§2.6): the "Ask DB Desk: <query>" row → `panel.showAgent` + seed the composer
  with `text: '/help ' + query, intent: 'help'` via the existing `agentSeed`. `agent.askHelp`
  command = the same with empty text.

### 6.3 Main process

`src/main/agent/help.ts` (new):

```ts
import guideMd from '../../../docs/user-guide.md?raw'
export const HIGHLIGHT_FEATURE_TOOL: Anthropic.Tool // input { featureId: string }
export function buildHelpSystemPrompt(): string
export function execHighlightFeature(
  req,
  block,
  send,
  budget: { left: number }
): Anthropic.ToolResultBlockParam
```

`buildHelpSystemPrompt()` returns, in this order:

1. Role: "You are the built-in help for DB Desk, a desktop database client. Answer only
   questions about using DB Desk. Be concrete: name the control and where it is. Keep
   answers under ~120 words unless the user asks for a tour. Never write SQL and never
   claim to have changed anything in the app."
2. Tool rule: "When you point the user at a specific control, call `highlight_feature`
   with its id so the app highlights it. At most 3 highlights per answer. Only use ids from
   the feature list."
3. `## Features` — one line per registry entry: `` `id` — title: description. Location: location. Shortcut: … ``
   (generated from `FEATURES`, so it never goes stale).
4. `## User guide` followed by `guideMd` verbatim.

`execHighlightFeature`: validate `featureId` with `featureById`; unknown → `is_error`
result "Unknown feature id; use one from the list."; over budget → error "Highlight limit
reached for this answer."; else `send({ type: 'tool_start', … sql: '' })`, `send({ type:
'ui_action', … })`, `send({ type: 'tool_result', ok: true, summary: 'highlighted <title>' })`
and return `"Highlighted <title> for the user."`.

`src/main/agent.ts` — in `runAgentTurn`, right after mode/dialect are resolved:

```ts
if (req.intent === 'help') {
  // No schema, no knowledge, no repo, no MCP, no editor tools. One tool.
  tools = [HIGHLIGHT_FEATURE_TOOL]
  system = buildHelpSystemPrompt()
  // skip schemaSummaryFor / repo lookups entirely (they are the expensive part)
}
```

Implement as an early branch that sets `tools`/`system` and skips the schema/repo/MCP
setup, then falls into the same streaming loop. In the `tool_use` dispatch chain add
`else if (block.name === 'highlight_feature') results.push(execHighlightFeature(...))`
with a per-turn `budget = { left: 3 }`. Help turns must not set `editorProposalSent` or
trigger the fix-query reminder.

`buildSystemPrompt` in `prompt.ts` is **not** modified; help has its own prompt builder.

### 6.4 Transcript

No new rendering. `tool_start`/`tool_result` for `highlight_feature` show like other tools
(name + summary). The intro copy in `ChatTranscript.tsx` (`chat__empty`) gains one more
sentence: "Type /help to ask how to do something in DB Desk."

---

## 7. CSS (`src/renderer/src/styles.css`)

New blocks, all using existing tokens (`--panel`, `--panel-hi`, `--border`, `--accent`,
`--accent-soft`, `--text-dim`, `--shadow`); no new hex values:

- `.palette`, `.palette__input`, `.palette__list`, `.palette__row` (+ `.is-active`, `.is-disabled`),
  `.palette__cat`, `.palette__kbd`, `.palette-toast`
- `.shortcuts`, `.shortcuts__group`, `.shortcuts__row`
- `.guide` (scrollable markdown body inside `.dialog`, max-width 720px)
- `.spotlight-backdrop`, `.spotlight-hole`, `.spotlight-card`
- `.discover`, `.discover__rail`, `.discover__card`, `.discover__progress`
- `.beacon`, `.beacon-layer`, `.highlight-banner`

Keep `<kbd>` styling identical to the one already used in `EditorTabStrip`.

---

## 8. Tests & verification

Unit tests (`npm run test:unit`; put files in `test/unit/`):

| Test file                     | Asserts                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features.test.ts` (phase 1)  | ids unique; every `command`/`reveal` ∈ `COMMAND_IDS`; every `guide` slug exists among headings of `docs/user-guide.md` (read the file with `fs`, slugify with `slugifyHeading`); `location` non-empty; shortcuts unique; every `anchor` refers to an existing id. |
| `discoverySearch.test.ts` (1) | scoring order (title-prefix > word-prefix > contains > keyword > description); empty query preserves order; case-insensitive.                                                                                                                                     |
| `ipcGuards.test.ts` (3)       | `DiscoveryState` validator drops unknown ids and non-finite counts.                                                                                                                                                                                               |
| `helpPrompt.test.ts` (5)      | prompt contains every feature id; contains a known guide heading; `execHighlightFeature` errors on unknown id and on the 4th call; emits `ui_action` with the id on success.                                                                                      |
| `agentTurn`-style test (5)    | a request with `intent: 'help'` builds exactly one tool (`highlight_feature`) — factor the tool-list assembly out of `runAgentTurn` into a pure `toolsForTurn(req, mode, …)` if needed to make this testable without hitting the network.                         |

Manual verification per phase with the `verify` skill (build + launch + drive via CDP):

1. ⌘K from the editor (Monaco focused), from the tree, from the composer; run "Pin a result"; Esc closes.
2. Help menu present and ⌘C/⌘V still work in the composer; ⌘/ sheet lists ⌘⏎; guide opens scrolled to "Export results".
3. Discover › Results › Export › Show me highlights the Export button; "Add results to AI chat" (no anchor) shows the centred "Where to find it" card; tick appears after clicking Pin for real.
4. ⌘⇧/ shows beacons; clicking one opens the card; Esc exits; hidden features link goes to Discover.
5. `/help how do I export the full result` answers from the guide and highlights `results.export`; the turn issues no `run_sql`; a bogus feature id from the model returns a tool error, not a crash.

Run `npm run typecheck` and `npm run lint` before every PR.

---

## 9. Suggested order inside each phase

Each phase is one PR. Inside a phase, do the pure/shared code first (it is testable without
the app), then main, then renderer, then CSS, then the `verify` pass:

- Phase 1: `features.ts` + tests → `search.ts` + tests → bridge/commands → shortcuts → palette → App wiring.
- Phase 2: `menu.ts` + IPC → shortcut overlay → markdown heading ids → guide dialog.
- Phase 3: `DiscoveryState` + IPC + guard → `usage.ts` → `Spotlight` → `data-feature` sweep → Discover dialog → instrument `markUsed`.
- Phase 4: `HighlightMode` only.
- Phase 5: shared types → `help.ts` + tests → `agent.ts` branch → composer/session → palette row → transcript copy.

---

## 10. Out of scope (do not build)

- Multi-step guided tours, first-run wizards, "what's new" on version bump (the
  `seenVersion` field is reserved so it can be added later without a migration).
- Behaviour-triggered hints ("you ran the same query three times, try pinning") — a later
  phase once usage data exists.
- Any telemetry that leaves the machine.
- A generic Tooltip component or rewriting existing `title` attributes.
- Making `/help` answer database questions — it is deliberately walled off from SQL and schema.
