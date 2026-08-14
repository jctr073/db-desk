# Plan: Manage Knowledge Bases mapping view + background scan agents

Implements the final design handoff (`Manage Knowledge Bases - Final.dc.html`, claude.ai/design
project `45c4dc6f-926e-477f-a7f5-8fe067a85fc2`). Three deliverables, in the design's own terms:

1. **1d — Manage Knowledge Bases, mapping view.** The dialog presents each base as a mapping
   from one code path to the schemas it owns: left rail of mappings grouped by repo, detail pane
   with a code-path card → arrow → schemas card, live scan state, and owner-labelled actions.
2. **1e — Status-bar agents segment.** A new segment reporting how many background agents are
   running (idle / running / failed states), which toggles…
3. **1f — Agents tray.** A popover anchored to that segment managing running, queued, and
   finished background scan runs.

Plus: `TargetedScanDialog` becomes a unified **scan dialog** (scope control, focus textarea,
"run in background" toggle), and a new **main-process background scan runner** so scans no
longer occupy the chat.

Branch: work on `kb_mgr` (already checked out). Do not touch unrelated files.

---

## 0. Decisions on the handoff's open questions

These are defaults chosen to keep v1 small; each is trivially changeable later. Do not
re-litigate them during implementation.

| Question | Decision |
|---|---|
| How many background agents at once? | Global limit of **2 running**; further requests queue. One extra rule: at most **one job per base** active (queued or running) — starting a second scan for the same base is rejected with a message. |
| Does a background scan write into the chat transcript? | **No.** Background scans run headless in main with their own synthetic chat id; the tray is their only surface. The foreground path (background toggle off) still sends a normal chat turn exactly as today. |
| Does history persist across restarts? | **Session only** (in-memory in main, capped at 20 finished runs). |
| Multi-schema "+1" in the rail — full list on hover? | Yes, via a plain `title` tooltip listing all schemas. No custom hover UI. |
| Does "Detach" stay a separate sub-dialog? | **Yes** — `DetachCodebaseDialog` unchanged, launched from the code-path card's *Detach…* button. Rename / Unlink / Delete move to the ••• menu in the knowledge footer. |

Progress semantics (design shows "42%" and "128 of 300 files"): a scan agent reads
selectively, so an honest `filesRead/filesTotal` would crawl. Percent is a **display
heuristic** (see §2.4) — monotonic, capped at 95 until the run finishes. Counters
(`filesRead`, `recordsWritten`, elapsed) are real.

---

## 1. Current-state map (read these before coding)

| File | Role today |
|---|---|
| `src/renderer/src/components/ManageKnowledgeDialog.tsx` (837 lines) | The dialog being restructured. Keep all its callbacks, sub-dialogs (`BaseNameDialog`, `LinkBaseDialog`, `MonorepoSetupDialog`, `DetachCodebaseDialog`, `ConfirmBaseDialog`), and its link/schema toggle logic (`schemaRows`, `toggleSchema`, `createAndLinkBase`, …) — only the layout and action placement change. |
| `src/renderer/src/components/StatusBar.tsx` | 26px bar; segments: cog, conn dot+name, query text, schema-sync, spacer, target. New agents segment goes after schema-sync, before the spacer. |
| `src/renderer/src/components/TargetedScanDialog.tsx` | Becomes the unified scan dialog. |
| `src/renderer/src/components/AgentPanel.tsx` | Owns the manage dialog, `scanBase` / `targetedScanBase` (foreground scan = `sendPrompt(...)` with `kbId` pinned), `useRepoLinks`, skills (`SCAN_CODEBASE_SKILL_ID`, `TARGETED_SCAN_SKILL_ID`). |
| `src/renderer/src/components/agent/useChatSession.ts` | `sendPrompt(prompt, target, forceRepo, intent, kbId)`; per-chat `busy`. Also the session's current `model`, `effort`, `effectiveMode` — snapshot these when enqueueing a background scan. |
| `src/main/agent.ts` | `runAgentTurn(req, send)` (private), per-chat state in `chats` map keyed by `chatId`, `stopChat` (private), `registerAgentHandlers`. A turn with a distinct `chatId` runs concurrently with the chat — this is what makes background scans possible without touching the streaming loop. |
| `src/main/agent/knowledge.ts` | `execSaveKnowledge` emits `tool_result` with summary `saved <kind>` / `updated <kind>`; `resolveActiveKbId` validates a supplied kbId is linked to the target. |
| `src/main/repo.ts` | `getRepoRoot(kbId)` returns the **effective** root (repoRoot/subPath joined, validated), `listRepoFiles(root)` (walker, 1 000-result cap), `getRepoCommit`. |
| `src/main/knowledge.ts` | `linksForTarget`, `listBases`, `groupsForTarget`, base persistence. |
| `src/shared/ipc.ts` | The typed IPC contract — every new channel goes here first. |
| `src/preload/index.ts` | `window.dbDesk.<ns>` bridges; add an `agents` namespace. |
| `src/renderer/src/styles.css` | Design tokens at the top (`--panel`, `--accent`, `--teal`, …) match the handoff's palette exactly. `.statusbar*` at ~252, `.dialog*` at ~2134, `.manage-kb*` at ~2469, `.dtabs` segmented control at ~2237, `.spinner`/`.spinner--xs` at ~1702, keyframes `dbspin` at ~126. |
| `src/renderer/src/useEscapeKey.ts` | Window-level (bubble-phase) Escape hook used by all dialogs. The tray must NOT use it (see §3.3). |

Token mapping from the handoff (§4 of the design): every hex in the mock already exists as a
CSS variable except the card fill `#262836` — add it (§6.1). **Never hard-code hexes**; the
light theme swaps the same token names.

---

## 2. Phase A — main-process background scan runner

### 2.1 Shared types — new file `src/shared/backgroundAgents.ts`

Structured-clone friendly, no electron/node imports (same rules as the other shared modules).

```ts
import type { AgentEffort, AgentMode } from './agent'

export type BackgroundScanKind = 'full' | 'targeted'
export type BackgroundAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One background scan run, as pushed to the renderer (tray + status bar). */
export interface BackgroundAgentJob {
  /** `bga-${Date.now()}-${rand}` (house id pattern). */
  id: string
  kind: BackgroundScanKind
  kbId: string
  /** Base display name, snapshotted at enqueue (renames don't retitle history). */
  baseName: string
  /** Effective scanned root (repoRoot/subPath already joined), display only. */
  repoRoot: string
  subPath: string | null
  target: { connId: string; connName: string; database: string }
  /** Schema scopes of the base's links to the target, for "prod / billing" labels. */
  schemas: string[]
  /** Focus text for targeted scans; null for full scans. */
  focus: string | null
  status: BackgroundAgentStatus
  /** Files the walker counted under the effective root (capped at 1000), or null before start. */
  filesTotal: number | null
  /** read_repo_file calls on distinct paths so far. */
  filesRead: number
  /** Successful save_knowledge calls so far. */
  recordsWritten: number
  /** 0–100 display heuristic; 100 only when done. */
  percent: number
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

/** Renderer → main request to enqueue a scan. The prompt is built renderer-side
 * from the (possibly user-edited) skill, exactly like the foreground path. */
export interface BackgroundScanRequest {
  kbId: string
  kind: BackgroundScanKind
  focus: string | null
  prompt: string
  connId: string
  connName: string
  database: string
  model: string
  effort: AgentEffort | null
  mode: AgentMode
}

export type BackgroundScanStartResult = { ok: true; jobId: string } | { ok: false; error: string }

/** Payload of the `agents:changed` push. */
export interface BackgroundAgentsState {
  jobs: BackgroundAgentJob[]
  queuePaused: boolean
}

export const MAX_RUNNING_AGENTS = 2
export const AGENT_HISTORY_CAP = 20

/** Display-progress heuristic: a scan reads a fraction of the repo, so scale
 * against an expected read count, not filesTotal. Monotonic; capped at 95. */
export function scanPercent(
  kind: BackgroundScanKind,
  filesRead: number,
  filesTotal: number | null
): number {
  const total = filesTotal ?? 200
  const expected =
    kind === 'full'
      ? Math.min(120, Math.max(20, Math.round(total * 0.3)))
      : Math.min(40, Math.max(8, Math.round(total * 0.15)))
  return Math.min(95, Math.round((100 * filesRead) / expected))
}

/** Fold jobs into the status-bar segment state. `sinceTrayOpened`: jobs that
 * failed before the user last opened the tray stop shouting (design: failure
 * is sticky until the tray is opened). */
export function foldAgentSegment(
  jobs: BackgroundAgentJob[],
  lastTrayOpenedAt: number
): { state: 'idle' | 'running' | 'failed'; label: string; percent: number } {
  const failed = jobs.filter(
    (j) => j.status === 'failed' && (j.finishedAt ?? 0) > lastTrayOpenedAt
  )
  if (failed.length > 0) {
    return {
      state: 'failed',
      label: `${failed.length} agent${failed.length === 1 ? '' : 's'} failed`,
      percent: 0
    }
  }
  const running = jobs.filter((j) => j.status === 'running')
  const active = running.length + jobs.filter((j) => j.status === 'queued').length
  if (active > 0) {
    const pool = running.length > 0 ? running : jobs.filter((j) => j.status === 'queued')
    const percent = Math.round(pool.reduce((s, j) => s + j.percent, 0) / pool.length)
    return {
      state: 'running',
      label: `${active} agent${active === 1 ? '' : 's'} · ${percent}%`,
      percent
    }
  }
  return { state: 'idle', label: 'No agents', percent: 0 }
}
```

`scanPercent` and `foldAgentSegment` are pure on purpose — unit-test them (§7).

### 2.2 `src/main/agent.ts` — three small refactors, no behavior change

1. **Export the turn loop with options.** Change the signature to
   `export async function runAgentTurn(req: AgentSendRequest, send: Sender, opts?: { editorTools?: boolean }): Promise<void>`
   (default `editorTools: true`). When `editorTools === false`, omit `WRITE_EDITOR_TOOL` and
   `READ_EDITOR_TOOL` from the `tools` array (both branches of the read-only/metadata ternary
   at `src/main/agent.ts:316`) — a headless scan must not propose editor diffs or ping the
   renderer for editor state. Everything else (clamping, knowledge tools, repo tools) stays.
2. **Export `stopChat(chatId)`** (currently private at `src/main/agent.ts:643`).
3. **Add and export `disposeChat(chatId)`**: `stopChat(chatId); chats.delete(chatId)` —
   like `agent:reset` but *without* clearing the schema caches (scans benefit from the cached
   summary, and disposing one scan must not blow the chat's cache).

### 2.3 New file `src/main/backgroundAgents.ts` — the runner

Owns the job table, queue, and lifecycle. Session-only state:

```ts
const jobs = new Map<string, BackgroundAgentJob>()      // insertion order = enqueue order
const requests = new Map<string, BackgroundScanRequest>() // snapshot kept for retry
let queuePaused = false
```

Registration: `export function registerBackgroundAgentHandlers(getWindow: () => BrowserWindow | null): void`
— called from wherever the other `register*Handlers` are called (`src/main/index.ts`; mirror
`registerAgentHandlers`' placement).

**Broadcast.** After *every* mutation (enqueue, start, progress tick, finish, cancel, remove,
retry, pause): `typedSend(getWindow(), 'agents:changed', { jobs: [...jobs.values()], queuePaused })`.
Throttle progress ticks to at most one push per 300 ms per job (a scan emits many tool events);
always push immediately on status transitions.

**`startScan(req: BackgroundScanRequest): BackgroundScanStartResult`** — validation, fail closed:

- `linksForTarget(req.connId, req.database)` must contain `req.kbId` (same trust model as
  `resolveActiveKbId`), else `{ ok: false, error: 'This base is not linked to the target.' }`.
- `getRepoRoot(req.kbId)` must be non-null, else `'No codebase attached.'`.
- No existing job for this `kbId` with status `queued`/`running`, else
  `'A scan for this base is already running or queued.'`.
- `req.kind === 'targeted'` requires non-empty `focus`.
- Build the job (`status: 'queued'`, `percent: 0`), look up `baseName`/`subPath` from
  `listBases()`, `schemas` from the base's links to the target; store the request snapshot;
  call `pump()`.

**`pump()`** — while `!queuePaused` and running-count `< MAX_RUNNING_AGENTS` and a queued job
exists (oldest first): transition it to `running` and fire `void runJob(job)`.

**`runJob(job)`**:

1. `job.startedAt = Date.now()`; count `filesTotal` via
   `const { files } = await listRepoFiles(root)` (`root = getRepoRoot(job.kbId)` re-resolved —
   if now null, fail the job with `'Codebase is no longer attached.'`). `filesTotal = files.length`
   (the 1 000-file cap is fine; it only feeds the heuristic).
2. Build the `AgentSendRequest`:
   ```ts
   const chatId = `bga:${job.id}`
   const req: AgentSendRequest = {
     chatId, prompt: snapshot.prompt, intent: 'chat',
     model: snapshot.model, effort: snapshot.effort, mode: snapshot.mode,
     webSearch: false, repo: true,
     target: { connId, connName, database, kbId: job.kbId },
     editor: null, editorSelection: null, context: []
   }
   ```
3. Run with an **intercepting Sender** that never forwards to the renderer's `agent:event`
   (the chat UI must not see scan traffic). Track `toolId → name` from `tool_start`, then:
   - `tool_start` with `name === 'read_repo_file'`: parse the path from the label
     (`sql` is `` `repo: read ${path}` `` — see `src/main/agent/executors.ts:602`), add to a
     per-run `Set<string>`; `job.filesRead = set.size`.
   - `tool_result` with `ok === true` whose toolId was a `save_knowledge` start:
     `job.recordsWritten++`. (The `knowledge:changed` push already refreshes open knowledge
     views — no extra plumbing.)
   - Recompute `job.percent = scanPercent(job.kind, job.filesRead, job.filesTotal)` and push
     (throttled).
   - `error`: record `job.error = message` (the turn also emits `done` afterwards in the
     abort path only — treat the first terminal event as authoritative: an `error` event marks
     the job `failed` even if no `done` follows).
4. `await runAgentTurn(req, interceptSender, { editorTools: false })`, then finalize from what
   the sender saw: `done` with `stopReason === 'aborted'` → `cancelled`; prior `error` event →
   `failed`; otherwise → `done` with `percent = 100`. Set `finishedAt`, `disposeChat(chatId)`,
   prune history beyond `AGENT_HISTORY_CAP` (oldest finished/failed/cancelled first), `pump()`.
   Wrap in try/catch: a thrown error (shouldn't happen — `runAgentTurn` catches) also lands in
   `failed`.

**Other handlers** (all in the typed contract, §2.5):

- `cancel(jobId)`: queued → mark `cancelled` (+`finishedAt`); running → `stopChat('bga:'+jobId)`
  (finalization in `runJob` does the rest).
- `remove(jobId)`: only when status is not `running` — delete from both maps.
- `retry(jobId)`: only `failed`/`cancelled` — reset the same job to
  `queued`, clear `error/startedAt/finishedAt/filesRead/recordsWritten/percent`, `pump()`.
  Re-validate the kb link + repo root like `startScan` (the base may be gone).
- `setQueuePaused(paused)`: set the flag; on unpause, `pump()`. Running jobs always finish.
- `list()`: return the current `BackgroundAgentsState` (for initial render).

### 2.4 Notes for the implementer

- Do NOT emit `agent:event` for scan chatIds. The chat's `useChatSession` filters by chatId so
  it would be inert anyway, but the events are wasted IPC and could collide with future chats.
- `execSaveKnowledge`'s summary strings (`saved <kind>` / `updated <kind>`) are not parsed —
  matching is by toolId → name, which is stable.
- The scan reuses the shared `schemaCache` — good: an open chat has usually warmed it.
- Concurrent scans of different bases may run against different databases; each turn resolves
  its own dialect/summary. Nothing shared is mutated per-turn except the `chats` map entry.

### 2.5 IPC + preload

`src/shared/ipc.ts` — add to `IpcInvokeContract`:

```ts
// --- Background agents ----------------------------------------------------
'agents:list': { args: []; result: BackgroundAgentsState }
'agents:startScan': { args: [req: BackgroundScanRequest]; result: BackgroundScanStartResult }
'agents:cancel': { args: [jobId: string]; result: void }
'agents:remove': { args: [jobId: string]; result: void }
'agents:retry': { args: [jobId: string]; result: void }
'agents:setQueuePaused': { args: [paused: boolean]; result: void }
```

and to `IpcPushContract`:

```ts
/** Background scan jobs changed (status, progress, or queue pause). */
'agents:changed': [state: BackgroundAgentsState]
```

`src/preload/index.ts` — new frozen namespace `agents` mirroring the house pattern
(`list`, `startScan`, `cancel`, `remove`, `retry`, `setQueuePaused`,
`onChanged(cb): () => void` via `typedOn('agents:changed', cb)`). Update the `DbDeskApi` type
where the preload exposes it (follow how `knowledge`/`agent` are declared).

---

## 3. Phase B — renderer: hook, status-bar segment, tray

### 3.1 New file `src/renderer/src/agents/useBackgroundAgents.ts`

```ts
export function useBackgroundAgents() {
  const [jobs, setJobs] = useState<BackgroundAgentJob[]>([])
  const [queuePaused, setQueuePaused] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  /** Failure stickiness: failed pill shows until the tray is opened after it. */
  const [lastTrayOpenedAt, setLastTrayOpenedAt] = useState(0)
  // useEffect: initial agents.list() + agents.onChanged subscription (mirror useRepoLinks).
  // toggleTray: setTrayOpen(o => !o); when opening, setLastTrayOpenedAt(Date.now()).
  // closeTray, cancel, remove, retry, setPaused → thin wrappers over window.dbDesk.agents.*
  // segment = useMemo(() => foldAgentSegment(jobs, lastTrayOpenedAt), [jobs, lastTrayOpenedAt])
  return { jobs, queuePaused, trayOpen, segment, toggleTray, closeTray, cancel, remove, retry, setPaused, startScan }
}
```

Called once in `App.tsx`; the value is passed down (StatusBar gets the segment, App renders the
tray, AgentPanel gets `jobs` + `startScan` for the manage dialog).

### 3.2 `StatusBar.tsx` — the agents segment (design 1e)

New props:

```ts
/** Background-agents segment; absent hides the segment entirely. */
agents?: {
  state: 'idle' | 'running' | 'failed'
  label: string          // "No agents" | "2 agents · 42%" | "1 agent failed"
  open: boolean          // tray open → chevron points down
  onToggle: () => void
}
```

Render between the schema segment and the spacer, preceded by a `statusbar__divider` (only
when something precedes it, matching the existing conditional-divider pattern). Markup:

- Always a real `<button type="button" className="statusbar__agents" …>` (hover =
  `--panel-hi`, like `.statusbar__btn`), `aria-label="Background agents"`,
  `title` = label.
- **idle**: `SearchIcon size={11}` + text `No agents`, color `--text-faint`, no pill.
- **running**: pill (18px tall, radius 5, `--accent-soft` bg, `--accent-strong` text, 600):
  spinner ring (`<span className="spinner spinner--xs" />` — it already renders an
  accent-topped ring via `dbspin`) + label + chevron (`ChevronUpIcon size={10}`, flipped to
  `ChevronDownIcon` when `open`).
- **failed**: pill with `rgba` of `--red` at .14 bg / `--red` text: 6px dot + label + chevron.
  Use `color-mix(in srgb, var(--red) 14%, transparent)` so the light theme works.

Singular/plural is handled by `foldAgentSegment`. Clicking calls `onToggle`.

### 3.3 New file `src/renderer/src/components/AgentsTray.tsx` (design 1f)

Rendered in `App.tsx` (app shell — it must survive dialogs closing), only when
`agents.trayOpen`.

**Positioning.** `position: fixed; bottom: 34px` (26px bar + 8px gap). Horizontal: the segment
button ref is measured on open (`getBoundingClientRect`) and on window resize:
`left = clamp(8, rect.left, window.innerWidth - 398 - 8)`. Simplest wiring: StatusBar forwards
the button element via a callback ref prop (`agents.setAnchor?(el)`) stored in the hook; or
App holds `anchorRef` and passes it to both. Either is fine — keep it to one mechanism.

**Chrome.** Width 398px, `--panel` bg, `1px --border`, radius 10, shadow
`0 26px 60px var(--shadow)`, `z-index` above the status bar but *below* `.dialog-overlay`
(50) — use 40 — so a modal opened on top still overlays it.

**Dismissal.**
- Outside click: a `pointerdown` listener on `document`; if the event target is outside the
  tray *and* outside the segment button, close.
- Escape: **capture-phase** listener — `document.addEventListener('keydown', h, true)` where
  `h` checks `key === 'Escape'`, calls `event.stopPropagation()`, and closes the tray. This is
  why the tray must NOT use `useEscapeKey` (bubble phase): with the manage dialog open under
  the tray, one Escape must close only the tray. (`useEscapeKey` listeners never see the
  stopped event because capture runs first on `document` before `window` bubble handlers.)

**Structure** (top to bottom, values from the mock):

1. Header row (padding 10px 12px, bottom border): title **Background agents** (12px/700),
   spacer, `Pause queue` / `Resume queue` ghost button (22px tall, 10.5px, 1px `--border`) →
   `setPaused(!queuePaused)`.
2. Tab row: reuse the `.dtabs` pattern (3px padding, `--panel-hi` track, active tab `--panel`
   bg): `Running · n` / `Queued · n` / `History`. Filtering:
   - **Running** (default): running rows, then queued rows, then a `FINISHED` uppercase
     label (10px/600, `--text-faint`) + the 5 most recent finished/failed rows.
   - **Queued**: queued only.
   - **History**: all finished/failed/cancelled, newest first.
3. Row list (padding 4px 10px 10px, column gap 6px, `overflow-y: auto`, max-height ~340px).
4. Footer strip (`--panel-hi`, top border, 9px 12px): hint
   *Agents keep running while dialogs are closed.* + link-button **Open agent panel**
   (accent-strong, 10.5px) → `onOpenAgentPanel()` (App switches the right panel to the
   AI Agent tab — wire a callback through props to `AgentPanel`'s `setActiveTab`; simplest is
   a one-shot seq prop like the existing `seed` pattern, or lift a small
   `revealAgentTab` callback from AgentPanel via a ref. Use the seq pattern —
   `agentTabSeq: number` prop on AgentPanel, effect switches tab on change).

**Rows** (one component, variant by status):

- *Running*: card (`--panel-card` bg — new token, §6.1 — 1px `--border`, radius 8). Body row:
  spinner ring 11px (accent for `kind==='full'`, teal for `'targeted'` — a `--teal`-topped
  spinner variant class), then a min-width-0 column:
  line 1: kind label (**Codebase scan** / **Targeted scan**, 12px/600) + base name
  (10.5px `--text-faint`); line 2 (mono 10px `--text-faint`, ellipsis):
  `~/src/…/path · database / schema1[, schema2…]` — display the job's `repoRoot` with the
  home dir abbreviated to `~` when it prefixes (pure string replace of a leading
  home prefix is main-side knowledge; simplest: main stores `repoRoot` verbatim and the
  renderer shows it ellipsized with full path in `title`; skip the `~` nicety);
  line 3 (10.5px `--text-dim`): for full scans `X of Y files · Z records written · Nm elapsed`;
  for targeted scans `“focus…” · X of Y files · Z records` (focus quoted, ellipsized).
  Right: ghost **Cancel** button → `cancel(id)`. Bottom edge: 3px progress rail
  (`--panel-hi` track, fill `job.percent%` in accent or teal by kind).
- *Queued*: dashed 1px `--border` border, radius 8, no fill. Hollow 9px circle, kind label +
  base name, sub-line *Queued — starts when a slot frees up*. Right: **Remove** →
  `remove(id)`.
- *Finished (done)*: 1px `--border-soft` border. 14px green check disc
  (`color-mix(in srgb, var(--green) 16%, transparent)` bg, `--green` check `CheckIcon size={9}`).
  Label: base name (or `subPath` for monorepo bases — show `subPath ?? baseName`); sub-line
  `+N records · 4m 12s · 2h ago` (duration = finishedAt−startedAt, "ago" coarse: m/h). Right:
  **View records** → see §3.4.
- *Failed*: border `color-mix(in srgb, var(--red) 35%, transparent)`, bg red at .07. Red ✕
  disc. Sub-line in `--red`: `Failed — <error> · 18m ago`. Right: **Retry** → `retry(id)`.
- *Cancelled*: render like finished but with a faint hollow circle and sub-line
  `Cancelled · …`; button **Remove**.

All row buttons: 22px tall, 10.5px, ghost (1px `--border`, `--text-dim`).

### 3.4 "View records" navigation

Extend `KnowledgeNav` (`src/renderer/src/knowledge/useKnowledgeState.ts:25`) with a variant:

```ts
| { seq: number; action: 'scan-run'; connId: string; database: string; kbId: string;
    since: number; until: number }
```

Flow: tray row → `onViewRecords(job)` (prop from App) → App sets
`setKnTargetKey(knowledgeTargetKeyOf(connId, database))`, bumps `knowledgeNav` with the
variant, and closes the tray. `AgentPanel`'s existing nav effect already reveals the
Knowledge tab. `KnowledgePanel` handles the new action: `state.setSelectedKbId(kbId)` and set
a transient run filter — show records where `source === 'agent'` and
`updatedAt >= since && updatedAt <= until + 60_000`. Render a dismissible chip above the list
(`Records from last scan · n` with a ✕) that clears the filter; any manual filter/tab change
also clears it. If `KnowledgePanel`'s internals make this costly, the fallback is
select-base-only (still ship the chip if at all possible — it's the design's stated behavior).

The tray needs `connName` for targets — jobs carry it.

### 3.5 App.tsx wiring summary

```
const bgAgents = useBackgroundAgents()
…
<AgentPanel … backgroundJobs={bgAgents.jobs} onStartBackgroundScan={…} agentTabSeq={…} />
<StatusBar … agents={{ state, label, open: bgAgents.trayOpen, onToggle: bgAgents.toggleTray }} />
{bgAgents.trayOpen && <AgentsTray state={bgAgents} onViewRecords={…} onOpenAgentPanel={…} anchor={…} />}
```

`onStartBackgroundScan` actually lives in AgentPanel (it owns skills + session settings), so
App only passes `bgAgents` down; see §4.2.

---

## 4. Phase C — the scan dialog (TargetedScanDialog → ScanDialog)

### 4.1 `src/renderer/src/components/TargetedScanDialog.tsx`

Rename the component to `ScanDialog` (keep the file, update imports; or rename the file to
`ScanDialog.tsx` — prefer the file rename, it's the honest name now). House dialog pattern
stays (overlay, header with `SearchIcon`, footer). New shape:

```ts
interface ScanDialogProps {
  targetLabel: string
  repoName: string | null
  /** Preselected scope. 'full' from "Scan…"; 'targeted' from a targeted entry point. */
  initialScope: BackgroundScanKind
  /** Why a foreground run can't happen now (agent busy / skills loading), or null. */
  foregroundBlockedReason: string | null
  onClose: () => void
  onStart: (opts: { kind: BackgroundScanKind; focus: string; background: boolean }) => void
}
```

Body, top to bottom:

1. Scope segmented control (`.dtabs` + `.dtab` house pattern): **Full scan** / **Targeted scan**.
2. When targeted: the existing `FOCUS` label + textarea (rows 4, autoFocus, same placeholder,
   Cmd/Ctrl+Enter submits) and the existing hint copy. When full: a short hint instead —
   *The agent surveys the whole attached codebase and records what it teaches about this
   database.*
3. Background toggle: a labelled checkbox row —
   label **Run in background**, sub-hint (11px `--text-faint`):
   *The scan runs as a background agent; watch it from the status bar.* Default **checked**.
   When unchecked and `foregroundBlockedReason` is set, disable the Start button and show the
   reason inline (the `url-hint` style).

Validation: targeted requires non-empty focus (existing error message). Footer: Cancel /
**Start Scan** (btn-primary).

### 4.2 `AgentPanel.tsx` wiring changes

- New props: `backgroundAgents: ReturnType<typeof useBackgroundAgents>` (or the narrowed
  subset `{ jobs, startScan }`), `agentTabSeq?: number` (one-shot tab reveal, §3.3).
- Replace the `{ kind: 'targeted-scan' }` sub-dialog with `{ kind: 'scan'; initialScope: BackgroundScanKind }`.
- New callback passed to the manage dialog:

```ts
const startScan = useCallback(
  (kbId: string, opts: { kind: BackgroundScanKind; focus: string; background: boolean }) => {
    if (!knowledgeTarget) return
    if (!opts.background) {
      // Foreground: exactly today's behavior.
      if (opts.kind === 'full') scanBase(kbId)
      else targetedScanBase(kbId, opts.focus)
      return
    }
    const prompt =
      opts.kind === 'full'
        ? applySkillArgs(skillById.get(SCAN_CODEBASE_SKILL_ID)?.prompt ?? REPO_SCAN_PROMPT, '')
        : (skillById.get(TARGETED_SCAN_SKILL_ID)?.prompt
            ? applySkillArgs(skillById.get(TARGETED_SCAN_SKILL_ID)!.prompt, opts.focus)
            : repoTargetedScanPrompt(opts.focus))
    void backgroundAgents.startScan({
      kbId, kind: opts.kind, focus: opts.kind === 'targeted' ? opts.focus : null, prompt,
      connId: knowledgeTarget.connId, connName: knowledgeTarget.connName,
      database: knowledgeTarget.database,
      model: session.model.id,
      effort: session.effort && session.model.efforts.includes(session.effort) ? session.effort : null,
      mode: session.effectiveMode
    }).then((res) => { if (!res.ok) /* surface res.error in the manage dialog error slot */ })
  }, […])
```

  Surfacing errors: pass the result back — cleanest is for the manage dialog to own the call:
  give `ManageKnowledgeDialog` an `onStartScan` prop returning `Promise<BackgroundScanStartResult | null>`
  (null = foreground path taken) and let it set its existing `error` state on `!ok`.
- **`scanDisabledReason` split.** Background runs are not blocked by chat busyness. Pass two
  props to the manage dialog: `foregroundBlockedReason` (today's string: skills loading /
  agent busy) and keep "Attach a codebase first" derived inside the dialog as now. The scan
  *button* is disabled only by missing codebase; the dialog's background toggle handles the
  foreground-blocked case (§4.1). Skills still loading blocks *both* paths (prompt text isn't
  ready): keep a `scanBlockedReason` for that case only.

---

## 5. Phase D — ManageKnowledgeDialog mapping view (design 1d)

The largest change. Keep every existing callback and sub-dialog; restructure the body. Dialog
width: **780px** (`.manage-kb-dialog` from 720). Body `min-height: 404px`.

### 5.1 New props

```ts
/** All background jobs; the dialog filters by base + target. */
jobs: BackgroundAgentJob[]
/** Opens the scan dialog for a base (owned by AgentPanel like today's sub-dialog,
 *  or kept internal — keep it internal: the ScanDialog stays a sub-dialog here). */
onStartScan: (kbId: string, opts: { kind: BackgroundScanKind; focus: string; background: boolean })
  => Promise<BackgroundScanStartResult | null>
onCancelJob: (jobId: string) => void
onRetryJob: (jobId: string) => void
/** schema name → relation count (tables+views+matviews), for "34 tables" chips. */
schemaTableCounts: Record<string, number>
/** Blocks both scan paths (skills loading); busy-agent only blocks foreground. */
scanBlockedReason: string | null
foregroundBlockedReason: string | null
```

`schemaTableCounts` is built in AgentPanel from `schemas[connId]?.[database]`
(`intro.schemas.map(s => [s.name, s.tables.length + s.views.length + s.matviews.length])`).

Derived per base, used by rail + detail:

```ts
const jobsForBase = (kbId) => jobs.filter(j => j.kbId === kbId
  && j.target.connId === target.connId && j.target.database === target.database)
const activeJob   = // status 'running' first, else 'queued', else null
const lastJob     = // most recent finished/failed by finishedAt
const neverScanned = (g) => !!repoRoot(g) && !g.records.some(r => r.source === 'agent')
  && !activeJob(g.base.id)
```

### 5.2 Left rail (230px, `--panel-hi` bg, 1px `--border` right seam)

Replace `.manage-kb__list`. Extract the section builder into a pure function in a new file
`src/renderer/src/components/manageKb.ts` so it's unit-testable:

```ts
export interface RailItem {
  kind: 'base'
  group: KnowledgeTargetGroup
  /** Display name: base name, or subPath remainder for clustered monorepo rows. */
  label: string
  /** "→ billing" / "→ hs_accounts_customer +1"; full list for the title tooltip. */
  mappingLabel: string
  mappingTitle: string
  monorepo: boolean
  neverScanned: boolean
}
export interface RailUnmappedItem {
  kind: 'unmapped'
  label: string
  /** "mapped in wcap_dev" | "no code path" */
  sublabel: string
  title: string
}
export interface RailSection {
  /** "Mapped to prod" | "hs-monorepo · go/" | "Unmapped · 3" */
  header: string
  items: Array<RailItem | RailUnmappedItem>
}
export function buildRailSections(args: {
  groups: KnowledgeTargetGroup[]
  allBases: … /* not needed if unmapped derives from links */
  links: KnowledgeLink[]
  connNames: Record<string, string>
  target: { connId: string; database: string }
  schemaOptions: string[]
  repoStatuses: Record<string, RepoStatus>
  neverScannedIds: Set<string>
}): RailSection[]
```

Rules (extending today's `listSections` clustering at `ManageKnowledgeDialog.tsx:300`):

1. **`Mapped to <database>`** — all solo (non-clustered) linked bases, original order.
   Omit the section when empty.
2. **One section per monorepo cluster** (same `repoRoot` on >1 linked base):
   header `<repoRootName(root)>` plus, when every cluster member's `subPath` shares the same
   first path segment, ` · <segment>/`; each row's `label` is the `subPath` with that shared
   `<segment>/` prefix stripped (else the full `subPath`), falling back to the base name when
   `subPath` is null.
3. **`Unmapped · n`** — two item kinds, in this order:
   - *Mapped elsewhere*: bases sharing a clustered `repoRoot` from (2) but with **no** link to
     this target. Find them via `links`: for each such base (need the full base list — the
     dialog doesn't have it; derive instead from `links` + `groups`? The base names/subPaths of
     unlinked bases aren't in `groups`. Add one more prop: `allBases: KnowledgeBaseSummary[]`,
     loaded in AgentPanel via `window.dbDesk.knowledge.listBases()` on dialog open and kept
     fresh on `knowledge:structureChanged` — extend `useRepoLinks` to also expose `bases` the
     same way it exposes `links`.) Label = `subPath ?? name`; sublabel
     `mapped in <database>` from the base's first link (prefix with `<connName> / ` when the
     link's connId differs from the target's).
   - *No code path*: each schema in `schemaOptions` with no link from any base in `groups`;
     sublabel `no code path`.
   Omit the section when empty.

Row rendering (`.manage-kb__rail-item`): a `<button>` (base rows) or inert `<div>` (unmapped),
28-ish px tall, 8px 9px padding, radius 7:

- 3×22px status bar span: `--teal` for monorepo rows, `--accent` when selected, `--border`
  otherwise (selected wins).
- Selected row: 1px `--accent` border + `--panel` bg (mock: `#222430` on the `#313344` rail).
- Name 12.5px/600; second line 10.5px `--text-faint`: the `mappingLabel`
  (`→ schema1` with ` +n` overflow; `title` carries the full list). When `neverScanned`:
  second line amber (`--amber`) reading `→ <schemas> · never scanned`.
- Live scan indicator, right-aligned, when the base has an active job:
  `<span class="…scan">● scan</span>` — 5px accent dot + `scan`, 10px accent text (mock).
  For a queued job use `--text-faint` and the word `queued`.
- Section headers: 10px/600 uppercase, `.04em` tracking, `--text-faint`, margins per mock
  (first `2px 0 5px`, later `12px 0 5px`, 9px horizontal padding).

Rail footer (below the scrollable items, 9px padding, 1px top border): full-width primary
button **New mapping…** (28px, radius 6, accent bg, white text, `PlusThinIcon`). Clicking
opens a small anchored menu (simple absolutely-positioned popover inside the dialog, closed on
outside click/Escape via the existing sub-dialog state — add `{ kind: 'new-menu' }` or a local
`useState`) with three items reusing today's handlers verbatim:
`New base…` → `{kind:'new'}`, `Link existing base…` → `openLinkDialog()`,
`Set up monorepo…` → `{kind:'monorepo'}`.

Empty state (no groups): keep today's `.manage-kb__list-empty` copy inside the rail.

### 5.3 Detail pane (right side, padding 15px 18px 18px)

Top → bottom for the selected base:

**(a) Scan state banner** — exactly one of:

- **Running** (active running job): accent banner — 1px
  `color-mix(in srgb, var(--accent) 45%, transparent)` border, `--accent-soft`-ish bg
  (`rgba(107,138,253,.1)` in mock → `color-mix(… 10%…)`), radius 9, padding 9px 12px:
  12px spinner ring, then **Background scan running · {percent}%** (12px/600) over
  `{filesRead} of {filesTotal} files · {recordsWritten} records written · started {n}m ago`
  (10.5px `--text-dim`), right ghost **Cancel** (24px) → `onCancelJob`. Directly below:
  3px progress rail (track `--panel-hi`, accent fill at `percent%`), 1px side margins.
- **Queued**: same geometry, dashed `--border` border, hollow dot, title
  **Scan queued** · sub *Starts when a slot frees up* · button **Remove** → (remove via
  `onCancelJob`? No—) add `onRemoveJob(jobId)` prop or reuse cancel (cancel on a queued job
  marks it cancelled; Remove then happens in the tray). Use **Cancel** here too — one verb,
  one handler; the tray is where Remove lives.
- **Failed** (last job failed, no active job): `--red` themed banner (border red@35%, bg
  red@7%): ✕ disc, **Scan failed**, sub = `job.error` (ellipsized, full in `title`), right
  **Retry** → `onRetryJob`.
- **Never scanned** (`neverScanned` && codebase attached): muted row (1px `--border`, no
  tint): **Not scanned yet** (12px/600 `--text-dim`), sub
  *Run a scan to teach the agent this codebase.*, right **btn-primary Scan…** → opens the
  ScanDialog with `initialScope: 'full'` (disabled with `scanBlockedReason` as title when
  set).
- Otherwise: no banner.

**(b) Mapping grid** — `display:grid; grid-template-columns: 1fr 34px 1fr; margin-top:16px`.

*Code path card* (`.manage-kb__card`: 1px `--border`, radius 9, `--panel-card` bg):

- Card header (8px 11px, 1px `--border-soft` bottom): uppercase 10px/600 `--text-dim`
  label **Code path**.
- Body (11px padding): `FolderIcon size={13}` (accent-strong) + repo display name 13px/600
  (`repoRootName(repoRoot)`; for a subPath base show the subPath leaf). Mono 10.5px
  `--text-dim` path block (`repoRoot`, wrapped, full path in `title`). Chip row (19px chips,
  radius 4, `--panel-hi` bg, 10px): commit chip (mono, from `status?.commit`, omit when null)
  + scope chip (`whole repo` or the `subPath`). Button row (24px ghost buttons):
  **Change…** → existing `attach()` (title strings unchanged from today), **Detach…** →
  `{kind:'detach'}` (disabled when no root).
- **No codebase** state: body is a dashed drop-target-looking button (dashed 1px `--border`,
  radius 7, centered, `--text-dim`): `+ Attach codebase…` → `attach()`. Keep today's
  monorepo sub-path note (`manage-kb__repo-sub` copy) under the path when `subPath` is set.

*Arrow column*: two 1px vertical `--border` lines with a centered `→` (13px, accent-strong).
Pure CSS/flex per the mock.

*Schemas card* (same card chrome):

- Header row: uppercase label **Schemas in {database}**, spacer, ghost chip-button
  **Edit links…** (20px) → toggles the link editor (below).
- Body (11px padding, wrap, 6px gap): one chip per linked schema (24px, radius 6,
  `--accent-soft` bg, `color-mix(… var(--accent) 45% …)` border, 11.5px `--text`):
  `schema` + count suffix (10px accent-strong) `{n} tables` from `schemaTableCounts`
  (omit the suffix when the schema isn't in the introspection — the existing "missing" case).
  Legacy database-wide link renders one chip `entire database` (faint) — keep the existing
  unlink semantics. Then a dashed `+ add schema` chip (24px, dashed `--border`, `--text-faint`)
  → also opens the link editor.
- Coverage sentence (10.5px `--text-faint`, full row):
  *Records written here answer questions about the {a, b} schema{s} only. {k} other schema{s}
  in {database} {are/is} covered by other bases.* — second sentence only when `k > 0`, where
  `k` = schemas of `schemaOptions` linked by *other* groups.
- **Link editor**: reuse today's `schemaRows` + `toggleSchema` machinery *unchanged* —
  render the existing checkbox list (`.manage-kb__schemas`, incl. pending disable and the
  "(not in schema)" flag) in a collapsible section that replaces the chip body while open
  (header button toggles `Edit links… ⌄` / `Done`). No popover needed; in-card expansion is
  simpler and Escape-safe. The last-link guard (`confirm-unlink` reroute) stays as is.

**(c) Knowledge footer row** — `margin-top:16px; padding-top:13px; border-top: 1px solid
--border-soft; display:flex; gap:8px; align-items:center`:

- Left column: uppercase label **Knowledge**; sub-line 11px `--text-faint`:
  `{n} record{s}`, then when this session's `lastJob` succeeded ` · last scan added
  {recordsWritten}`, then ` · ` link-button **view in panel** (accent on hover) → `onClose()`
  after `onSelectBase(kbId)` (the dialog already syncs selection; closing reveals the panel).
- **Scan again…** button (28px, `--panel-hi` bg, 1px `--border`, `SearchIcon size={12}`):
  label is **Scan…** when `neverScanned` (banner variant already offers it, keep both).
  Opens ScanDialog `{ kind: 'scan', initialScope: 'full' }`. Disabled (with reason in title)
  when no codebase (`Attach a codebase first`) or `scanBlockedReason`.
- ••• kebab (28×28, `KebabIcon`): anchored menu with **Rename…** → `{kind:'rename'}`,
  **Unlink from this database…** → `{kind:'confirm-unlink'}`, **Delete base…** (red) →
  `{kind:'confirm-delete'}`. Same popover mechanics as the New mapping menu.

**(d) Empty detail** (no selection): keep today's `.manage-kb__detail-empty` copy.

### 5.4 Dialog footer

Replace the error/Close footer contents: left slot = existing error display when set, else
the hint (11px `--text-faint`): *Rename, unlink and delete live in the ••• menu of the
mapping.* Right: **Close** (unchanged semantics, disabled while attaching).

### 5.5 ScanDialog as sub-dialog

`SubDialog` union: replace `{ kind: 'targeted-scan' }` with
`{ kind: 'scan'; initialScope: BackgroundScanKind }`. Render `ScanDialog` with
`foregroundBlockedReason`, and on `onStart` call `onStartScan(selectedKbId, opts)`; if the
result is `{ ok: false }`, set the dialog `error`; on success close the sub-dialog (keep the
manage dialog open — the rail's live `scan` dot and the banner confirm the launch; this
differs from the foreground path, which still closes the whole manage dialog to reveal the
chat, as `scanBase` does today).

---

## 6. CSS work (`src/renderer/src/styles.css`)

### 6.1 Tokens

Add to `:root`: `--panel-card: #262836;` and to `:root[data-theme='light']`:
`--panel-card: #f6f7f9;` (between `--panel` and `--panel-hi`, per the handoff's note "card
fill (new, between panel and panel-hi)").

### 6.2 New blocks

Add three commented sections in house style (`/* --- */` banner comments):

1. **Status bar agents segment** (`.statusbar__agents`, `.statusbar__agents-pill`,
   `.statusbar__agents-pill--failed`) — geometry per §3.2; hover like `.statusbar__btn`.
2. **Agents tray** (`.agents-tray`, `__header`, `__tabs` (or reuse `.dtabs` classes directly
   in the JSX — prefer reuse), `__list`, `__row` + `--queued/--done/--failed` variants,
   `__row-rail`, `__row-rail-fill` (+ `--teal`), `__finished-label`, `__footer`,
   `.spinner--teal` (border-top-color `--teal`)).
3. **Manage dialog mapping view** — new classes per §5 (`.manage-kb__rail*`,
   `.manage-kb__banner*`, `.manage-kb__grid`, `.manage-kb__card*`, `.manage-kb__chip*`,
   `.manage-kb__arrow`, `.manage-kb__kfooter*`, `.manage-kb__menu*`).

### 6.3 Retire

Remove rules that lose their last consumer after the restructure — expected:
`.manage-kb__list-actions`, `.manage-kb__action`, `.manage-kb__row-actions`,
`.manage-kb__btn` (if fully replaced by card/ghost buttons — check `grep -n` before deleting;
`ConfirmBaseDialog` and other dialogs use `btn-cancel`/`btn-danger`, not these),
`.manage-kb__item*`, `.manage-kb__group-header`, `.manage-kb__section-title` (if the detail no
longer uses sections). Keep `.manage-kb__schemas`, `.manage-kb__schema-row`,
`.manage-kb__schema-name`, `.manage-kb__schema-missing` (reused by the link editor), and
`.manage-kb__confirm-body`, `.manage-kb__repo-sub`.

Radii/typography reference (from handoff §4): modal 12, cards/popovers 9–10, controls 6–7,
chips 4–5; 10px uppercase labels use `letter-spacing:.04em`; paths/commits in `ui-monospace`.

---

## 7. Copy — verbatim strings from the design

Use exactly these (the handoff marks copy as normative):

- Rail: `Mapped to {database}`, `Unmapped · {n}`, `never scanned`, `mapped in {database}`,
  `no code path`, `New mapping…`
- Cards: `Code path`, `Schemas in {database}`, `Edit links…`, `+ add schema`, `whole repo`,
  `Change…`, `Detach…`,
  `Records written here answer questions about the {schema} schema only.`
- Banner: `Background scan running · {n}%`,
  `{x} of {y} files · {z} records written · started {t} ago`, `Cancel`
- Footer: `Knowledge`, `{n} records · last scan added {k} · view in panel`, `Scan again…`,
  `Rename, unlink and delete live in the ••• menu of the mapping.`
- Status bar: `No agents`, `{n} agents · {p}%` (singular `1 agent`), `{n} agent{s} failed`
- Tray: `Background agents`, `Pause queue`, `Running · {n}`, `Queued · {n}`, `History`,
  `Codebase scan`, `Targeted scan`, `Queued — starts when a slot frees up`, `Remove`,
  `+{n} records · {dur} · {ago} ago`, `View records`, `Failed — {error} · {ago} ago`,
  `Retry`, `Agents keep running while dialogs are closed.`, `Open agent panel`

---

## 8. Tests & verification

Unit (vitest, `npm run test:unit`; colocate `*.test.ts` beside sources as the repo does):

1. `src/shared/backgroundAgents.test.ts` — `scanPercent` (monotonic, caps, targeted vs full,
   null total), `foldAgentSegment` (idle/running/failed precedence, stickiness cutoff,
   singular/plural, queued-only percent).
2. `src/main/backgroundAgents` queue logic — factor the pure transition core (enqueue → pump
   promotion, MAX_RUNNING respected, pause blocks promotion but not completion, retry
   revalidation, per-base single-job rule, history cap pruning) so it's testable without
   electron; follow the pattern of existing main-side tests if any, else keep the pure part in
   `src/shared/` or export helpers.
3. `src/renderer/src/components/manageKb.test.ts` — `buildRailSections`: solo section,
   monorepo cluster with shared-prefix header + label stripping, unmapped from
   other-database links, unmapped schemas, empty sections omitted.

Static: `npm run typecheck` and `npm run lint` must pass; `npm run test` for the full suite.

End-to-end: use the repo's **`verify` skill** (builds and drives the Electron app over CDP).
Script at minimum: open Manage Knowledge Bases on a connected target with a linked base and
attached codebase → confirm rail sections and detail cards render; launch a background scan
from the scan dialog → confirm the status-bar pill appears with the spinner and count, the
rail row shows the `scan` dot, the banner shows progress; open the tray → confirm the running
row, Cancel it → confirm `cancelled` in History and the pill returning to idle; Escape with
the manage dialog open under the tray closes only the tray.

---

## 9. Suggested execution order & parallelization

Sequential spine (each step compiles + tests green before the next):

1. **A** (`shared/backgroundAgents.ts`, `main/agent.ts` refactor, `main/backgroundAgents.ts`,
   IPC + preload) — no UI dependency; unit tests 1–2.
2. **B** (hook + StatusBar + AgentsTray + View-records nav) — depends on A.
3. **C** (ScanDialog + AgentPanel wiring) — depends on A (startScan), independent of B's tray.
4. **D** (ManageKnowledgeDialog restructure + CSS §6) — depends on A (jobs) and C
   (ScanDialog); the biggest diff, land last.

B and C touch disjoint files and can run as parallel sub-agents after A. D touches
`AgentPanel.tsx` too — rebase D's wiring after C merges. CSS for B/C/D can ride with each
phase (single-writer per section of `styles.css`; the three new blocks in §6.2 are disjoint).

Commit style: one commit per phase, message subjects like
`feat: background scan agents runner (main)`, `feat: status-bar agents segment and tray`,
`feat: unified scan dialog with background toggle`,
`feat: manage knowledge bases mapping view`.

---

## 10. Out of scope (do not build)

- Persisting job history across restarts.
- Chat-transcript mirroring of background scans.
- Per-base concurrency configuration or settings UI.
- Any Databricks-specific handling — the runner is engine-agnostic (mode clamp and dialect
  are already handled by `runAgentTurn`).
- Rewriting foreground scan behavior — it must keep working byte-for-byte
  (`scanBase`/`targetedScanBase` untouched apart from being called through the new dialog).
