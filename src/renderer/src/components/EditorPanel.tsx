import type { ReactElement } from 'react'

import type { Theme } from '../theme'
import { PlayIcon, PlusThinIcon, SqlFileIcon } from './icons'
import { SqlEditor } from './SqlEditor'

interface EditorPanelProps {
  theme: Theme
}

export function EditorPanel({ theme }: EditorPanelProps): ReactElement {
  return (
    <section className="editor-panel">
      <div className="editor-tabbar">
        <div className="editor-tab">
          <SqlFileIcon />
          query-1.sql
          <span className="editor-tab__dot" title="Unsaved changes" />
        </div>
        <button className="icon-btn icon-btn--sm" title="New query" type="button">
          <PlusThinIcon />
        </button>
        <div className="editor-tabbar__spacer" />
        <button className="btn-run" type="button">
          <PlayIcon />
          Run
        </button>
        <button className="btn-format" type="button">
          Format
        </button>
      </div>
      <div className="editor-host">
        <SqlEditor theme={theme} />
      </div>
    </section>
  )
}
