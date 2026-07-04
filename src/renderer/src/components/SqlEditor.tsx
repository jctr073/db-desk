import Editor from '@monaco-editor/react'
import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { ReactElement } from 'react'

import type { Theme } from '../theme'

const initialSql = 'SELECT * FROM users LIMIT 100;'

const editorOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: 13,
  minimap: {
    enabled: false
  },
  padding: {
    top: 14,
    bottom: 14
  },
  scrollBeyondLastLine: false,
  wordWrap: 'on'
}

interface SqlEditorProps {
  theme?: Theme
  onMount?: OnMount
}

function resolveTheme(theme?: Theme): 'light' | 'vs-dark' {
  if (theme) return theme === 'dark' ? 'vs-dark' : 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'vs-dark'
    : 'light'
}

export function SqlEditor({ theme, onMount }: SqlEditorProps): ReactElement {
  return (
    <section className="sql-editor" aria-label="SQL editor">
      <Editor
        defaultLanguage="sql"
        defaultValue={initialSql}
        height="100%"
        options={editorOptions}
        theme={resolveTheme(theme)}
        onMount={onMount}
      />
    </section>
  )
}
