import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { agentContextKey } from '../../shared/agent'
import type { AgentContextItem } from '../../shared/agent'
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

  // The two panels feed their footers into the single app-wide status bar.
  const [connStatus, setConnStatus] = useState({ sel: '', count: '' })
  const [queryStatus, setQueryStatus] = useState({ text: '', target: '' })
  const onConnStatus = useCallback((sel: string, count: string) => {
    setConnStatus((prev) =>
      prev.sel === sel && prev.count === count ? prev : { sel, count }
    )
  }, [])
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
          primary: !db.lazy
        })
      }
    }
    return out
  }, [connections.tree])

  /** Connection id → display name, for labelling file groups. */
  const connNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const conn of connections.tree) out[conn.id] = conn.label
    return out
  }, [connections.tree])

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
          onAddToAgentThread={addAgentContext}
          onStatus={onConnStatus}
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
          schemas={connections.schemas}
          ensureSchema={connections.ensureSchema}
          files={files}
          runner={runner}
          bridge={editorBridge}
          onQueryStatus={onQueryStatus}
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
        />
      </div>
      <StatusBar
        theme={theme}
        onToggleTheme={toggle}
        connText={connStatus.sel}
        connCount={connStatus.count}
        queryText={queryStatus.text}
        queryTarget={queryStatus.target}
      />
      <NewConnectionDialog state={connections} />
    </div>
  )
}

export default App
