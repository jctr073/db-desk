import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'

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

export function App(): ReactElement {
  const { theme, toggle } = useTheme()
  const connections = useConnectionState()
  const files = useFileState()
  const runner = useQueryRunner()
  const editorBridge = useRef<EditorBridge | null>(null)

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
      <div className="main-row">
        <ConnectionPanel
          state={connections}
          onNewQueryFile={(connId, database) => {
            files.createFile(connId, database)
          }}
        />
        <EditorPanel
          theme={theme}
          targets={targets}
          schemas={connections.schemas}
          ensureSchema={connections.ensureSchema}
          files={files}
          runner={runner}
          bridge={editorBridge}
        />
        <AgentPanel
          files={files}
          connNames={connNames}
          targets={targets}
          editorBridge={editorBridge}
          onAgentQuery={runner.showResult}
        />
      </div>
      <StatusBar theme={theme} onToggleTheme={toggle} />
      <NewConnectionDialog state={connections} />
    </div>
  )
}

export default App
