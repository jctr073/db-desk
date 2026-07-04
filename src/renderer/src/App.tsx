import type { ReactElement } from 'react'

import { AgentPanel } from './components/AgentPanel'
import { EditorPanel } from './components/EditorPanel'
import { TitleBar } from './components/TitleBar'
import { ConnectionPanel } from './connections/ConnectionPanel'
import { NewConnectionDialog } from './connections/NewConnectionDialog'
import { useConnectionState } from './connections/useConnectionState'
import { useTheme } from './theme'

export function App(): ReactElement {
  const { theme, toggle } = useTheme()
  const connections = useConnectionState()

  const rootId = connections.selected?.split('/')[0]
  const activeConn = rootId ? connections.tree.find((node) => node.id === rootId) : undefined
  const title = activeConn ? `DB Desk  —  ${activeConn.subtitle ?? activeConn.label}` : 'DB Desk'

  return (
    <div className="app">
      <TitleBar theme={theme} onToggleTheme={toggle} title={title} />
      <div className="main-row">
        <ConnectionPanel state={connections} />
        <EditorPanel theme={theme} />
        <AgentPanel />
      </div>
      <NewConnectionDialog state={connections} />
    </div>
  )
}

export default App
