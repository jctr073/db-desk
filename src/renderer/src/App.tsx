import { SqlEditor } from './components/SqlEditor'
import type { ReactElement } from 'react'

export function App(): ReactElement {
  return (
    <main className="app-shell">
      <SqlEditor />
    </main>
  )
}

export default App
