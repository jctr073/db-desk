import Editor from '@monaco-editor/react'
import type { Monaco, OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { ReactElement } from 'react'

import type { Theme } from '../theme'

const initialSql = 'SELECT * FROM users LIMIT 100;'

const DARK_THEME = 'db-desk-dark'

/**
 * Dark editor theme matching the app's Monokai Pro (Octagon) palette — keep in
 * sync with the design tokens in styles.css. Exported (with resolveTheme) so
 * the AI proposal DiffEditor renders with the same palette.
 */
export function defineThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    // Monaco's SQL grammar tags every token with a `.sql` postfix, and the
    // inherited vs-dark theme sets those `.sql` variants (e.g. operator.sql,
    // predefined.sql) — which are *more specific* than a bare `operator`, so
    // they win. We must override the `.sql` tokens explicitly, otherwise joins
    // render slate-gray and functions render magenta.
    rules: [
      { token: '', foreground: 'eaf2f1', background: '282a3a' },
      { token: 'keyword', foreground: 'ff657a' },
      { token: 'keyword.sql', foreground: 'ff657a' },
      // Joins (JOIN/LEFT/RIGHT/INNER/…) and logical/arithmetic operators are
      // tagged `operator.sql` — color them like keywords.
      { token: 'operator', foreground: 'ff657a' },
      { token: 'operator.sql', foreground: 'ff657a' },
      { token: 'string', foreground: 'ffd76d' },
      { token: 'string.sql', foreground: 'ffd76d' },
      // Numeric constants → purple.
      { token: 'number', foreground: 'c39ac9' },
      { token: 'number.sql', foreground: 'c39ac9' },
      { token: 'comment', foreground: '696d77', fontStyle: 'italic' },
      { token: 'comment.sql', foreground: '696d77', fontStyle: 'italic' },
      // Built-in functions (COUNT/SUM/COALESCE/…) → green.
      { token: 'predefined', foreground: 'bad761' },
      { token: 'predefined.sql', foreground: 'bad761' },
      { token: 'type', foreground: '9cd1bb' },
      { token: 'type.sql', foreground: '9cd1bb' },
      { token: 'identifier', foreground: 'eaf2f1' },
      { token: 'identifier.sql', foreground: 'eaf2f1' },
      { token: 'delimiter', foreground: 'b2b9bd' },
      { token: 'delimiter.sql', foreground: 'b2b9bd' }
    ],
    colors: {
      'editor.background': '#282a3a',
      'editor.foreground': '#eaf2f1',
      'editor.lineHighlightBackground': '#313444',
      'editor.selectionBackground': '#3f4257',
      'editor.inactiveSelectionBackground': '#343748',
      'editorCursor.foreground': '#eaf2f1',
      'editorLineNumber.foreground': '#535763',
      'editorLineNumber.activeForeground': '#a0a5ae',
      'editorIndentGuide.background1': '#313344',
      'editorIndentGuide.activeBackground1': '#3a3d4d',
      'editorWhitespace.foreground': '#3a3d4d',
      'editorWidget.background': '#1e1f2b',
      'editorWidget.border': '#3a3d4d',
      'editorSuggestWidget.background': '#1e1f2b',
      'editorSuggestWidget.border': '#3a3d4d',
      'editorSuggestWidget.selectedBackground': '#313344',
      'editorHoverWidget.background': '#1e1f2b',
      'editorHoverWidget.border': '#3a3d4d',
      'scrollbarSlider.background': '#3a3d4d99',
      'scrollbarSlider.hoverBackground': '#535763b3',
      'scrollbarSlider.activeBackground': '#535763'
    }
  })
}

const editorOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  // Keep the suggest widget visible when it overflows the editor panel.
  fixedOverflowWidgets: true,
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
  quickSuggestions: { other: true, comments: false, strings: false },
  scrollBeyondLastLine: false,
  suggest: {
    showWords: false
  },
  // Schema-aware completions replace Monaco's buffer-word suggestions.
  wordBasedSuggestions: 'off',
  wordWrap: 'on'
}

interface SqlEditorProps {
  theme?: Theme
  onMount?: OnMount
  language?: string
}

export function resolveTheme(theme?: Theme): string {
  if (theme) return theme === 'dark' ? DARK_THEME : 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK_THEME : 'light'
}

export function SqlEditor({ theme, onMount, language = 'sql' }: SqlEditorProps): ReactElement {
  return (
    <section className="sql-editor" aria-label="File editor">
      <Editor
        beforeMount={defineThemes}
        language={language}
        defaultValue={initialSql}
        height="100%"
        options={editorOptions}
        theme={resolveTheme(theme)}
        onMount={onMount}
      />
    </section>
  )
}
