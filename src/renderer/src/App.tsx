import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { agentContextKey } from '../../shared/agent'
import type { AgentContextItem } from '../../shared/agent'
import type { ColumnRef } from '../../shared/knowledge'
import { AgentPanel } from './components/AgentPanel'
import { EditorPanel } from './components/EditorPanel'
import { StatusBar } from './components/StatusBar'
import type { EditorBridge } from './components/editorBridge'
import { useQueryRunner } from './components/useQueryRunner'
import type { QueryTarget } from './components/useQueryRunner'
import { ConnectionPanel } from './connections/ConnectionPanel'
import { NewConnectionDialog } from './connections/NewConnectionDialog'
import { useConnectionState } from './connections/useConnectionState'
import { useTheme } from './theme'
import { useFileState } from './files/useFileState'
import { knowledgeBadgeIds } from './knowledge/treeBadges'
import {
  knowledgeTargetKeyOf,
  useKnowledgeIndexes,
  useKnowledgeState
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
  const { theme, toggle } = useTheme()
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
      prev.some((c) => agentContextKey(c) === agentContextKey(item))
        ? prev
        : [...prev, item]
    )
  }, [])
  const removeAgentContext = useCallback((key: string) => {
    setAgentContext((prev) => prev.filter((c) => agentContextKey(c) !== key))
  }, [])

  // The editor panel feeds the app-wide status bar: the connection its
  // active tab runs against, and the active result's summary.
  const [activeTarget, setActiveTarget] = useState<QueryTarget | null>(null)
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

  // Query files used to be creatable without a connection, which stranded them
  // in a group of their own. Re-home any leftovers on the first live target.
  const adoptOrphans = files.adoptOrphans
  useEffect(() => {
    const target = targets.find((t) => t.primary) ?? targets[0]
    if (target) adoptOrphans(target.connId, target.database)
  }, [targets, files.files, adoptOrphans])

  const openDataPreview = useCallback(
    (item: AgentContextItem) => {
      if (item.kind === 'schema') return
      const target = targets.find(
        (candidate) =>
          candidate.connId === item.connId &&
          candidate.database === item.database
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

  // Which (connection, database) the knowledge tab looks at. Owned here so
  // the connections tree can show knowledge badges for the same target.
  const [knTargetKey, setKnTargetKey] = useState<string | null>(null)
  useEffect(() => {
    if (
      knTargetKey &&
      targets.some((t) => knowledgeTargetKeyOf(t.connId, t.database) === knTargetKey)
    ) {
      return
    }
    const fallback = targets.find((t) => t.primary) ?? targets[0]
    setKnTargetKey(
      fallback ? knowledgeTargetKeyOf(fallback.connId, fallback.database) : null
    )
  }, [targets, knTargetKey])
  const knTarget =
    targets.find(
      (t) => knowledgeTargetKeyOf(t.connId, t.database) === knTargetKey
    ) ?? null

  const knowledge = useKnowledgeState(
    knTarget?.connId ?? null,
    knTarget?.database ?? null
  )

  // "Show usages" / "Add annotation…" requests routed from the schema tree.
  // A one-shot: KnowledgePanel clears it once consumed (via onNavConsumed) so a
  // tab switch away and back can't replay the last action.
  const [knowledgeNav, setKnowledgeNav] = useState<KnowledgeNav | null>(null)
  const knNavSeq = useRef(0)
  const onKnowledgeAction = useCallback(
    (
      action: 'usages' | 'annotate',
      connId: string,
      database: string,
      ref: ColumnRef
    ) => {
      setKnTargetKey(knowledgeTargetKeyOf(connId, database))
      setKnowledgeNav({ seq: ++knNavSeq.current, action, connId, database, ref })
    },
    []
  )
  const clearKnowledgeNav = useCallback(() => setKnowledgeNav(null), [])

  // "[kb:id]" citation chips in the agent transcript: point the knowledge tab
  // at the chat's target and open the cited record.
  const openKnowledgeRecord = useCallback(
    (connId: string, database: string, recordId: string) => {
      setKnTargetKey(knowledgeTargetKeyOf(connId, database))
      setKnowledgeNav({
        seq: ++knNavSeq.current,
        action: 'record',
        connId,
        database,
        recordId
      })
    },
    []
  )

  // Live usage indexes for every connected database, so the tree badges
  // knowledge across all of them (not just the tab's current target).
  const knowledgeTargets = useMemo(
    () => targets.map((t) => ({ connId: t.connId, database: t.database })),
    [targets]
  )
  const knowledgeIndexes = useKnowledgeIndexes(knowledgeTargets)

  /** Tree nodes with knowledge attached, for the dot badges (O(1) per node). */
  const knowledgeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of targets) {
      const index = knowledgeIndexes.get(knowledgeTargetKeyOf(t.connId, t.database))
      if (!index) continue
      for (const id of knowledgeBadgeIds(connections.tree, t.connId, t.database, index)) {
        ids.add(id)
      }
    }
    return ids
  }, [connections.tree, targets, knowledgeIndexes])

  const rootId = connections.selected?.split('/')[0]
  const activeConn = rootId
    ? connections.tree.find((node) => node.id === rootId)
    : undefined
  const title = activeConn
    ? `DB Desk  —  ${activeConn.subtitle ?? activeConn.label}`
    : 'DB Desk'

  // Drive the native OS window title instead of a custom title bar row.
  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div className="app">
      <div className="titlebar">DB Desk</div>
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
          onNewQueryFile={(connId, database) => {
            files.createFile(connId, database)
          }}
          onOpenDataPreview={openDataPreview}
          onAddToAgentThread={addAgentContext}
          onKnowledgeAction={onKnowledgeAction}
          knowledgeIds={knowledgeIds}
        />
        <div
          className="col-divider"
          onPointerDown={startResize('left')}
          role="separator"
          aria-orientation="vertical"
        />
        <EditorPanel
          theme={theme}
          targets={targets}
          connNames={connNames}
          schemas={connections.schemas}
          ensureSchema={connections.ensureSchema}
          files={files}
          runner={runner}
          bridge={editorBridge}
          onQueryStatus={onQueryStatus}
          onTargetChange={setActiveTarget}
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
          targets={targets}
          editorBridge={editorBridge}
          onAgentQuery={runner.showResult}
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
        />
      </div>
      <StatusBar
        theme={theme}
        onToggleTheme={toggle}
        connText={activeTarget ? `Connection · ${activeTarget.connName}` : ''}
        queryText={queryStatus.text}
        queryTarget={queryStatus.target}
      />
      <NewConnectionDialog state={connections} />
    </div>
  )
}

export default App
