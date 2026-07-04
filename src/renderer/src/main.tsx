import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import './styles.css'

const workerLabels = new Map<string, MonacoWorkerConstructor>([
  ['css', cssWorker],
  ['scss', cssWorker],
  ['less', cssWorker],
  ['html', htmlWorker],
  ['handlebars', htmlWorker],
  ['razor', htmlWorker],
  ['json', jsonWorker],
  ['typescript', tsWorker],
  ['javascript', tsWorker]
])

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    const WorkerConstructor = workerLabels.get(label) ?? editorWorker
    return new WorkerConstructor()
  }
}

loader.config({ monaco })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
