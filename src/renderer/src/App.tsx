import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { agentContextKey } from '../../shared/agent'
import type {
  AgentContextItem,
  AgentDbObjectItem,
  AgentPromptIntent,
  AgentResultItem
} from '../../shared/agent'
import type { ColumnRef } from '../../shared/knowledge'
import { AgentPanel } from './components/AgentPanel'
import { EditorPanel } from './components/EditorPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { StatusBar } from './components/StatusBar'
import type { EditorBridge } from './components/editorBridge'
import { useQueryRunner } from './components/useQueryRunner'
import type { QueryTarget } from './components/useQueryRunner'
import { ConnectionPanel } from './connections/ConnectionPanel'
import { ManageObjectsDialog } from './connections/ManageObjectsDialog'
import { NewConnectionDialog } from './connections/NewConnectionDialog'
import { connAccents } from './connections/connColors'
import { useConnectionState } from './connections/useConnectionState'
import { useTheme } from './theme'
import { useFileState } from './files/useFileState'
import { knowledgeBadgeIds, schemaLinkBadgeIds } from './knowledge/treeBadges'
import {
  knowledgeTargetKeyOf,
  useKnowledgeIndexes,
  useKnowledgeState,
  useKnowledgeStructure
} from './knowledge/useKnowledgeState'
import type { KnowledgeNav } from './knowledge/useKnowledgeState'

const CONN_MIN = 200
const CONN_MAX = 560
const AGENT_MIN = 260
const AGENT_MAX = 640

/** Read a persisted panel width, clamped to its allowed range. */
function storedWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(max, Math.max(min, raw))
}

export function App(): ReactElement {
  const { theme, preference, setPreference } = useTheme()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const connections = useConnectionState()
  const files = useFileState()
  const runner = useQueryRunner()
  const editorBridge = useRef<EditorBridge | null>(null)
  const mainRowRef = useRef<HTMLDivElement | null>(null)

  const [connWidth, setConnWidth] = useState(() =>
    storedWidth('panel.connWidth', 302, CONN_MIN, CONN_MAX)
  )
  const [agentWidth, setAgentWidth] = useState(() =>
    storedWidth('panel.agentWidth', 322, AGENT_MIN, AGENT_MAX)
  )

  // Objects attached to the agent thread as context chips. Added from the
  // connections tree ("Add to Agent Thread") or the composer's picker.
  const [agentContext, setAgentContext] = useState<AgentContextItem[]>([])
  const addAgentContext = useCallback((item: AgentContextItem) => {
    setAgentContext((prev) =>
      prev.some((c) => agentContextKey(c) === agentContextKey(item)) ? prev : [...prev, item]
    )
  }, [])
  const removeAgentContext = useCallback((key: string) => {
    setAgentContext((prev) => prev.filter((c) => agentContextKey(c) !== key))
  }, [])

  // "Fix with AI" and friends: attach context, then prefill the composer.
  // seq makes each request one-shot; AgentPanel never replays a seen seq.
  const [agentSeed, setAgentSeed] = useState<{
    seq: number
    text: string
    intent: AgentPromptIntent
    target?: { connId: string; database: string }
  } | null>(null)
  const agentSeedSeq = useRef(0)
  const askAgent = useCallback(
    (prompt: string, item?: AgentResultItem) => {
      if (item) addAgentContext(item)
      setAgentSeed({
        seq: ++agentSeedSeq.current,
        text: prompt,
        intent: 'fix-query',
        target: item ? { connId: item.connId, database: item.database } : undefined
      })
    },
    [addAgentContext]
  )

  // Serve the agent's read_editor tool from the live editor bridge.
  useEffect(() => {
    return window.dbDesk.agent.onEditorRead(() => ({
      editor: editorBridge.current?.getActiveSql() ?? null,
      selection: editorBridge.current?.getSelection() ?? null
    }))
  }, [])

  // Background schema-revalidation status of the active connection, folded
  // to one status-bar segment: any database still validating wins, then any
  // error, then "up to date".
  const schemaSync = useMemo(() => {
    const id = connections.activeConnId
    if (!id) return null
    const entries = Object.entries(connections.schemaRefresh).filter(([key]) =>
      key.startsWith(`${id}/`)
    )
    if (entries.length === 0) return null
    const validating = entries.filter(([, s]) => s.state === 'validating')
    if (validating.length > 0) {
      return {
        text:
          validating.length > 1
            ? `Validating schema (${validating.length})…`
            : 'Validating schema…',
        state: 'validating' as const,
        title: undefined as string | undefined
      }
    }
    const failed = entries.find(([, s]) => s.state === 'error')
    if (failed) {
      return {
        text: 'Schema validation failed',
        state: 'error' as const,
        title: failed[1].error
      }
    }
    return {
      text: 'Schema up to date',
      state: 'ok' as const,
      title: undefined as string | undefined
    }
  }, [connections.schemaRefresh, connections.activeConnId])

  // The results panel feeds the app-wide status bar with the active result's
  // summary; the connection half comes from the unified active context.
  const [queryStatus, setQueryStatus] = useState({ text: '', target: '' })
  const onQueryStatus = useCallback((text: string, target: string) => {
    setQueryStatus((prev) =>
      prev.text === text && prev.target === target ? prev : { text, target }
    )
  }, [])

  useEffect(() => {
    localStorage.setItem('panel.connWidth', String(Math.round(connWidth)))
  }, [connWidth])
  useEffect(() => {
    localStorage.setItem('panel.agentWidth', String(Math.round(agentWidth)))
  }, [agentWidth])

  // Drag a vertical divider. `edge` is which side we measure from: the left
  // divider grows the connection panel from the row's left edge, the right
  // divider grows the agent panel from the row's right edge.
  const startResize = useCallback(
    (edge: 'left' | 'right') => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const host = mainRowRef.current
      if (!host) return
      const rect = host.getBoundingClientRect()
      const move = (ev: PointerEvent): void => {
        if (edge === 'left') {
          const w = ev.clientX - rect.left
          setConnWidth(Math.min(CONN_MAX, Math.max(CONN_MIN, w)))
        } else {
          const w = rect.right - ev.clientX
          setAgentWidth(Math.min(AGENT_MAX, Math.max(AGENT_MIN, w)))
        }
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove('is-col-resizing')
      }
      document.body.classList.add('is-col-resizing')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    []
  )

  /** Every (online connection, database) pair the SQL editor can run against. */
  const targets = useMemo(() => {
    const out: QueryTarget[] = []
    for (const conn of connections.tree) {
      if (conn.status !== 'online' || !conn.children) continue
      for (const db of conn.children) {
        if (db.kind !== 'database') continue
        out.push({
          connId: conn.id,
          connName: conn.label,
          database: db.label,
          primary: !db.lazy,
          connectionType: conn.connectionType
        })
      }
    }
    return out
  }, [connections.tree])

  /** Stable accent color per connection, in tree order (unified context UI). */
  const accents = useMemo(
    () => connAccents(connections.tree.map((node) => node.id)),
    [connections.tree]
  )

  // The unified active context: one connection drives the whole app. Every
  // panel is scoped to its targets; its accent color tints the chrome.
  const activeConnId = connections.activeConnId
  const activeTargets = useMemo(
    () => targets.filter((t) => t.connId === activeConnId),
    [targets, activeConnId]
  )
  const activeConnNode = activeConnId
    ? (connections.tree.find((node) => node.id === activeConnId) ?? null)
    : null
  /** The active connection + the database it was opened against. */
  const activeTarget: QueryTarget | null =
    activeTargets.find((t) => t.database === activeConnNode?.connectedDatabase) ??
    activeTargets.find((t) => t.primary) ??
    activeTargets[0] ??
    null
  const activeAccent = activeConnId ? accents.get(activeConnId) : undefined

  // Query files used to be creatable without a connection, which stranded them
  // in a group of their own. Re-home any leftovers on the active context.
  const adoptOrphans = files.adoptOrphans
  useEffect(() => {
    if (activeTarget) adoptOrphans(activeTarget.connId, activeTarget.database)
  }, [activeTarget, files.files, adoptOrphans])

  const openDataPreview = useCallback(
    (item: AgentDbObjectItem) => {
      if (item.kind === 'schema') return
      const target = targets.find(
        (candidate) => candidate.connId === item.connId && candidate.database === item.database
      )
      if (!target) return
      const quote = target.connectionType === 'databricks' ? '`' : '"'
      const quoted = (name: string): string =>
        `${quote}${name.replaceAll(quote, quote + quote)}${quote}`
      const relation = item.schema
        ? `${quoted(item.schema)}.${quoted(item.name)}`
        : quoted(item.name)
      runner.preview(`SELECT * FROM ${relation}`, item.name, target)
    },
    [runner, targets]
  )

  /** Connection id → display name, for labelling file groups. */
  const connNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const conn of connections.tree) out[conn.id] = conn.label
    return out
  }, [connections.tree])

  // Which (connection, database) the knowledge tab looks at. Follows the
  // unified context: always a database on the active connection.
  const [knTargetKey, setKnTargetKey] = useState<string | null>(null)
  useEffect(() => {
    if (
      knTargetKey &&
      activeTargets.some((t) => knowledgeTargetKeyOf(t.connId, t.database) === knTargetKey)
    ) {
      return
    }
    setKnTargetKey(
      activeTarget ? knowledgeTargetKeyOf(activeTarget.connId, activeTarget.database) : null
    )
  }, [activeTargets, activeTarget, knTargetKey])
  const knTarget =
    activeTargets.find((t) => knowledgeTargetKeyOf(t.connId, t.database) === knTargetKey) ?? null

  const knowledge = useKnowledgeState(knTarget?.connId ?? null, knTarget?.database ?? null)

  // "Show usages" / "Add annotation…" requests routed from the schema tree.
  // A one-shot: KnowledgePanel clears it once consumed (via onNavConsumed) so a
  // tab switch away and back can't replay the last action.
  const [knowledgeNav, setKnowledgeNav] = useState<KnowledgeNav | null>(null)
  const knNavSeq = useRef(0)
  const onKnowledgeAction = useCallback(
    (action: 'usages' | 'annotate', connId: string, database: string, ref: ColumnRef) => {
      setKnTargetKey(knowledgeTargetKeyOf(connId, database))
      setKnowledgeNav({ seq: ++knNavSeq.current, action, connId, database, ref })
    },
    []
  )
  const clearKnowledgeNav = useCallback(() => setKnowledgeNav(null), [])

  // "[kb:id]" citation chips in the agent transcript: point the knowledge tab
  // at the chat's target and open the cited record.
  const openKnowledgeRecord = useCallback((connId: string, database: string, recordId: string) => {
    setKnTargetKey(knowledgeTargetKeyOf(connId, database))
    setKnowledgeNav({
      seq: ++knNavSeq.current,
      action: 'record',
      connId,
      database,
      recordId
    })
  }, [])

  // Live usage indexes for every connected database, so the tree badges
  // knowledge across all of them (not just the tab's current target).
  const knowledgeTargets = useMemo(
    () => targets.map((t) => ({ connId: t.connId, database: t.database })),
    [targets]
  )
  const knowledgeIndexes = useKnowledgeIndexes(knowledgeTargets)

  // Every base and link, for the tree's schema submenu and link indicators.
  const knowledgeStructure = useKnowledgeStructure()

  /** Tree nodes with knowledge attached, for the dot badges (O(1) per node):
   * relations/columns referenced by records, plus schemas with a linked base. */
  const knowledgeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of targets) {
      const index = knowledgeIndexes.get(knowledgeTargetKeyOf(t.connId, t.database))
      if (!index) continue
      for (const id of knowledgeBadgeIds(connections.tree, t.connId, t.database, index)) {
        ids.add(id)
      }
    }
    for (const id of schemaLinkBadgeIds(connections.tree, knowledgeStructure.links)) {
      ids.add(id)
    }
    return ids
  }, [connections.tree, targets, knowledgeIndexes, knowledgeStructure.links])

  const rootId = connections.selected?.split('/')[0]
  const activeConn = rootId ? connections.tree.find((node) => node.id === rootId) : undefined
  const title = activeConn ? `DB Desk  —  ${activeConn.subtitle ?? activeConn.label}` : 'DB Desk'

  // Drive the native OS window title instead of a custom title bar row.
  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div
      className={`app${activeTarget ? ' has-active-conn' : ''}`}
      style={
        {
          '--conn-accent': activeAccent?.hex ?? 'var(--accent)',
          '--conn-accent-rgb': activeAccent?.rgb ?? 'var(--accent-rgb)'
        } as CSSProperties
      }
    >
      <div className="titlebar">
        <span className="titlebar__app">DB Desk</span>
        {activeTarget && (
          <div className="titlebar__center">
            <div
              className="titlebar-pill"
              title={`Active context — every panel targets ${activeTarget.connName} / ${activeTarget.database}`}
            >
              <span className="titlebar-pill__dot" />
              <span className="titlebar-pill__name">{activeTarget.connName}</span>
              <span className="titlebar-pill__sep">/</span>
              <span className="titlebar-pill__db">{activeTarget.database}</span>
              <span className="titlebar-pill__divider" />
              <span className="titlebar-pill__label">ACTIVE CONTEXT</span>
            </div>
          </div>
        )}
      </div>
      <div
        className="main-row"
        ref={mainRowRef}
        style={
          {
            '--conn-width': `${connWidth}px`,
            '--agent-width': `${agentWidth}px`
          } as CSSProperties
        }
      >
        <ConnectionPanel
          state={connections}
          accents={accents}
          onNewQueryFile={(connId, database) => {
            files.createFile(connId, database)
          }}
          onOpenDataPreview={openDataPreview}
          onAddToAgentThread={addAgentContext}
          onKnowledgeAction={onKnowledgeAction}
          knowledgeIds={knowledgeIds}
          knowledgeBases={knowledgeStructure.bases}
          knowledgeLinks={knowledgeStructure.links}
        />
        <div
          className="col-divider"
          onPointerDown={startResize('left')}
          role="separator"
          aria-orientation="vertical"
        />
        <EditorPanel
          theme={theme}
          targets={activeTargets}
          activeConnId={activeConnId}
          connNames={connNames}
          schemas={connections.schemas}
          ensureSchema={connections.ensureSchema}
          files={files}
          runner={runner}
          bridge={editorBridge}
          onQueryStatus={onQueryStatus}
          onAddAgentContext={addAgentContext}
          onAskAgent={askAgent}
        />
        <div
          className="col-divider"
          onPointerDown={startResize('right')}
          role="separator"
          aria-orientation="vertical"
        />
        <AgentPanel
          files={files}
          connNames={connNames}
          targets={activeTargets}
          activeTarget={activeTarget}
          editorBridge={editorBridge}
          onAgentQuery={runner.showResult}
          onAgentTurnEnd={runner.finalizeAiRun}
          context={agentContext}
          onAddContext={addAgentContext}
          onRemoveContext={removeAgentContext}
          schemas={connections.schemas}
          ensureSchema={connections.ensureSchema}
          knowledge={knowledge}
          knowledgeTargetKey={knTargetKey}
          onKnowledgeTargetChange={setKnTargetKey}
          knowledgeNav={knowledgeNav}
          onKnowledgeNavConsumed={clearKnowledgeNav}
          onOpenKnowledgeRecord={openKnowledgeRecord}
          seed={agentSeed}
        />
      </div>
      <StatusBar
        onOpenSettings={openSettings}
        connText={activeTarget ? `Connection · ${activeTarget.connName}` : ''}
        queryText={queryStatus.text}
        schemaText={schemaSync?.text ?? ''}
        schemaState={schemaSync?.state}
        schemaTitle={schemaSync?.title}
        queryTarget={
          queryStatus.target ||
          (activeTarget ? `${activeTarget.connName} / ${activeTarget.database}` : '')
        }
      />
      {settingsOpen && (
        <SettingsDialog
          themePreference={preference}
          onThemePreference={setPreference}
          onClose={closeSettings}
        />
      )}
      <NewConnectionDialog state={connections} />
      {connections.manageDialog &&
        (() => {
          const dialog = connections.manageDialog
          const conn = connections.tree.find((node) => node.id === dialog.connId)
          const connName = conn?.label ?? dialog.connId
          return (
            <ManageObjectsDialog
              subtitle={connName}
              catalogs={dialog.catalogs}
              initialConfig={dialog.config}
              schemaLists={dialog.schemaLists}
              schemaErrors={dialog.schemaErrors}
              initialExpanded={dialog.initialExpanded}
              error={dialog.error}
              onLoadSchemas={connections.loadManageCatalogSchemas}
              onSubmit={connections.saveManageSelection}
              onClose={connections.closeManageDialog}
            />
          )
        })()}
    </div>
  )
}

export default App
