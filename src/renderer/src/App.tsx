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

  return (
    <div className="app">
      <TitleBar
        theme={theme}
        onToggleTheme={toggle}
        title="DB Desk  —  app_production@localhost"
      />
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
