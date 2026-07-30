# Plan: Generalized Files panel (CSV/TSV, watched folders, agent context)

Status: implemented — all six phases landed on `file_extensions`, 2026-07-30
(commits a7f825a, 70feedf, e8f8462, ff733a7, 5ca7c89, dfd36a6)

## Goal

Turn the right-panel "SQL Files" tab into a general **Files** tab that:

1. Supports CSV and tab-delimited (TSV) files alongside SQL/Markdown/JSON/Text.
2. Has two modes: files **grouped by connection** (today's behavior) and **watched folders** — program-wide macOS directories whose supported files are available to any connection.
3. Opens watched-folder files in the editor (real files, edited in place).
4. Lets the user select rows in a CSV grid preview and right-click → add them to the AI agent's context.
5. Adds an "open in editor" option when exporting query results to CSV/TSV.

## Decisions (agreed 2026-07-30)

- **Storage model**: watched-folder files are *referenced in place* (absolute paths). The internal per-connection blob store (`userData/queries/<id>.sql`) is unchanged. Two coexisting file classes.
- **CSV UX**: Edit/Preview pattern, same as markdown — raw text in Monaco, toggle to a read-only grid with row selection.
- **Write-back**: watched files are editable; ⌘S writes to the original path, with an mtime conflict check (warn if the file changed on disk since load).
- **Export-open**: "Export and open" opens the exported file as an external-file editor tab in DB Desk.

---

## Phase 1 — Foundations: consolidate file kinds, add `csv` / `tsv`

The file-type list is currently duplicated in four places. Consolidate first so new kinds are a one-file change thereafter.

1. `src/shared/files.ts`
   - Add `'csv'` and `'tsv'` to `FILE_KINDS`; extensions `.csv` / `.tsv` (accept `.tab` as an alias for tsv); Monaco language `plaintext` for both.
   - Add a `FILE_KIND_META` table: `{ kind, label ('CSV file'), defaultExtension, newFileStem ('data'), monacoLanguage }` — single source of truth.
   - `isPreviewableFile()` already returns true for non-SQL kinds; verify csv/tsv flow through.
2. `src/renderer/src/components/editor/EditorTabStrip.tsx` — derive `NewFileMenu` entries from `FILE_KIND_META` instead of the hardcoded literal array (`:314-358`).
3. `src/main/files.ts` — derive the stem map in `getNextFileName` (`:111-116`) and the rename-validation error string (`:213`) from `FILE_KIND_META`.
4. Tests: extend existing `files`-related unit tests for the new kinds; rename accepts `.csv`/`.tsv`.

Result: "+" menu offers CSV/TSV; internal (connection-scoped) CSV files can be created, renamed, edited as text.

## Phase 2 — CSV grid preview + panel rename

1. **Extract the results grid.** Move `ResultGrid` (and `GridRow`) out of `ResultsPanel.tsx:165-420` into `components/grid/DataGrid.tsx`. Generalize its props from `QueryResult` to `{ columns: {name}[], rows: string[][], selection callbacks }`. `ResultsPanel` becomes a consumer; selection algebra in `resultGridSelection.ts` is already extracted and stays shared.
2. **CSV parsing.** Add `src/shared/delimited.ts`: a small RFC-4180-ish parser (`parseDelimited(text, delimiter)`) — quoted fields, embedded newlines, header row heuristic. Pure + unit-tested. We already have the serializer half in `resultExport.ts` (`delimitedCell`); keep them adjacent so quoting rules match.
3. **Grid preview.** In `FilePreview.tsx`, render csv/tsv kinds through `DataGrid` (parse the buffer, show a parse-error banner like the JSON preview does). Cap initial render (e.g. first 5,000 rows) with a "showing N of M rows" notice — the grid has no virtualization.
4. **Rename the tab.** `AgentPanel.tsx:497-503`: "SQL Files" → "Files". Update the empty-state copy and the `"N files on other connections"` strings in `FilesPanel.tsx` as needed.

Result: a CSV opens in Monaco, Preview toggle shows a selectable grid.

## Phase 3 — External files + watched folders

The core new subsystem. Pattern-match `main/repo.ts` (directory picker, path containment, ignore lists, byte caps).

1. **Settings.** `main/settings.ts` `StoredSettings`: add `watchedFolders?: { id: string; path: string; label: string }[]`. Expose in `AppSettingsInfo` (`shared/settings.ts`); mutations broadcast the existing `settings:changed` push. UI: the existing **Files** tab in `SettingsDialog.tsx` gains an "Add watched folder…" picker (`dialog.showOpenDialog` with `openDirectory`) and a removable list.
2. **Watcher subsystem.** New `src/main/watchedFolders.ts`:
   - Enumerate supported files per folder (extensions from `FILE_KIND_META`; reuse `IGNORED_DIRS` and `isSensitiveName` from `repo.ts`; shallow-recursive with a visit cap).
   - Watch with `fs.watch` (FSEvents-backed on macOS; recursive is supported on darwin) + debounce; on change, re-enumerate and push a new `watched:changed` event via `IpcPushContract` (`shared/ipc.ts:180-199`).
   - IPC: `watched:list`, `watched:read(path)` (containment-checked against configured roots, byte-capped), `watched:write(path, content, expectedMtimeMs)` — write fails with a typed conflict error if the on-disk mtime is newer than `expectedMtimeMs`.
3. **External file model.** `shared/files.ts`: add `ExternalFile { path, name, kind, mtimeMs, size, folderId }`. Renderer: extend `useFileState` (or a sibling `useWatchedFiles` hook) to hold the watched listing and subscribe to `watched:changed`.
4. **Panel modes.** `FilesPanel.tsx` gets a two-mode segmented control: **By connection** (existing list) and **Folders** (watched folders → their files, grouped per folder). Folder mode ignores `activeConnId` — these files are connection-independent by design, so they must bypass the orphan-adoption effect in `App.tsx:243-245` and the connection filters in `EditorPanel.tsx:120-125`.

## Phase 4 — Open, edit, and save external files

1. **Tab model.** Editor tabs currently derive from `files.files ∩ openFileIds` bucketed by `(connId, database)`. Add an "External" tab group for open external files (keyed by absolute path). Buffer handling reuses `useFileBuffers` with `path` as the buffer key; load via `watched:read`, capture `mtimeMs`.
2. **Save with conflict check.** ⌘S on an external buffer → `watched:write` with the load-time mtime. On conflict, show a dialog: *Overwrite / Reload from disk / Cancel*.
3. **External change while open.** On `watched:changed` for an open, non-dirty file: silently reload the buffer. If dirty: show a non-blocking banner ("File changed on disk — Reload / Keep mine").
4. **Affordances.** Tab context menu / panel row menu: "Reveal in Finder" (`shell.showItemInFolder`). Watched `.sql` files are runnable against the *active* connection (they have no pinned connection — the run bar uses the current context, mirroring how the unified connection context already drives everything).

## Phase 5 — CSV rows → agent context

1. In the CSV grid preview, wire `DataGrid`'s existing selection + context-menu hooks to a new action: **"Add selection to AI chat"** (and "Add file sample to AI chat" for no-selection).
2. Reuse `AgentResultItem` via `buildResultContextItem` (`shared/resultContext.ts` — caps of 50 rows / 200 chars per cell / 16k total already solved). Populate `title` with the file name, `sql` with a provenance note like `-- from file: sales.csv (rows 10–25)`, `connId`/`database` from the active context (nullable-friendliness to be verified — if the required fields fight us, add a thin `file-data` variant in `shared/agent.ts` + `prompt.ts` instead, but try reuse first).
3. Composer chip rendering (`Composer.tsx:383-440`) shows the file-derived item with a file icon; `agentContextKey` gets a stable key (path + row range).

## Phase 6 — Export → open in editor

1. `shared/export.ts` / `dataExport.ts`: `chooseExportDestination` gains an `openAfter` flag (or `writeExportDestination` returns the path to a follow-up handler before deleting the token — the token is single-use today, so the open must happen inside the write call or the lifetime must be extended).
2. On write with `openAfter`, main pushes an `export:written { path }` event; the renderer opens it as an external-file tab (Phase 4 machinery). If the destination is outside every watched folder, it opens as a one-off external tab (allowed for app-initiated paths; the containment check applies only to renderer-requested reads) — with a subtle prompt offering to add its folder to watched folders.
3. UI: the export dropdown in `ResultsPanel.tsx` gains a checkbox or split action: **"Export and open"**.

---

## Deferred / nice-to-have (not in this build)

- **Drag-and-drop** a file onto the window to open it as an external tab.
- **Editable CSV grid** (cell editing with write-back) — phase 2 of the CSV UX.
- **Query CSVs with SQL** (embedded DuckDB) — would make the Files panel a data workbench; large enough to be its own feature.
- **Add whole file to agent context** as a file reference the agent can read via a tool, rather than a snapshot.
- Virtualized grid for very large CSVs; streaming/paged `watched:read` for files beyond the byte cap.
- Databricks-specific behaviors: deferred as always; everything above is engine-agnostic or postgres-gated where it touches run/execute.

## Test plan

- Unit: `delimited.ts` parser round-trip against `resultExport.ts` serializer; `FILE_KIND_META` derivations; conflict-detection logic in `watchedFolders.ts`; context-item building from CSV selections.
- Integration: watched-folder enumerate/read/write IPC with containment and sensitive-name refusal (mirror `repo.ts` tests).
- E2E (verify skill): create CSV via "+", preview grid, select rows → add to chat; add watched folder, open file, edit, save, external-change conflict; export with "open" checked.

## Suggested sequencing / PRs

Each phase is a PR-sized chunk; 1→2 and 3→4 are ordered pairs, and 5/6 depend on 2/4 respectively. Phases 1–2 are low-risk and shippable alone (CSV support in the existing panel); 3–4 are the meaty new subsystem; 5–6 are small once their dependencies land.
