---
name: verify
description: Build, launch, and drive DB Desk (Electron) to verify renderer changes end-to-end via CDP.
---

# Verifying DB Desk changes

DB Desk is an electron-vite app. Verify renderer changes by launching it
with a CDP port and driving the real UI — no test suite exists.

## Launch

```bash
npx electron-vite dev -- --remote-debugging-port=9223 &   # background
sleep 6 && curl -s http://127.0.0.1:9223/json             # page target appears
```

**Gotcha:** `pkill -f "electron-vite dev"` does NOT kill the Electron app
itself. Orphaned instances keep port 9223 and their main process keeps DB
pools alive, which makes reconnects fail with `Connection "..." already
exists` and makes CDP talk to the wrong (stale) instance. Before relaunching:
`pgrep -fl "Electron . --remote-debugging-port"` and `kill -9` the app PIDs.

Vite HMR of a hook file can leave old+new module instances alive with split
module-level state (counters, seqs). After editing renderer code, restart the
app (or fully reload AND reconnect) before trusting observed behavior.

## Drive

No `window.monaco` global and Monaco 0.55 uses an EditContext `ime-text-area`,
so scripting the editor text is unreliable — the saved query file content runs
fine for most flows. Drive everything else with `Runtime.evaluate` over the
CDP websocket (Node ≥22 has native WebSocket; no deps needed): find elements,
`.click()` them (React onClick fires on untrusted clicks), screenshot with
`Page.captureScreenshot`.

Flow to get query results:

1. Local Postgres must be up (`nc -z localhost 5436` for the wcap_dev conn).
2. Connect: dispatch `contextmenu` on the saved-connection tree row, click the
   `.ctx-menu__item` labeled "Connect", wait ~4s (Run button enables).
3. Run: click the toolbar button with text "Run"; wait until
   `.results-tab.is-active .results-tab__btn[title^="Pin"]` appears (query
   finished), click it to pin so the next Run opens a new tab.

## Known pre-existing quirks

- Reloading the renderer (`location.reload()`) desyncs it from the main
  process: main keeps the connection, renderer shows disconnected, and
  reconnecting opens the Edit Connection dialog stuck on
  `Connection "..." already exists`. Full app restart required.
