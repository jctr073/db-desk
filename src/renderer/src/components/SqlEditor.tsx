import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { ReactElement } from 'react'

const initialSql = 'SELECT * FROM users LIMIT 100;'

const editorOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: 14,
  minimap: {
    enabled: false
  },
  padding: {
    top: 16,
    bottom: 16
  },
  scrollBeyondLastLine: false,
  wordWrap: 'on'
}

function getEditorTheme(): 'light' | 'vs-dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'vs-dark'
    : 'light'
}

export function SqlEditor(): ReactElement {
  return (
    <section className="sql-editor" aria-label="SQL editor smoke test">
      <Editor
        defaultLanguage="sql"
        defaultValue={initialSql}
        height="100%"
        options={editorOptions}
        theme={getEditorTheme()}
      />
    </section>
  )
}
