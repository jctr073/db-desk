import type { ReactElement } from 'react'

import type { Theme } from '../theme'
import { MoonIcon, SunIcon } from './icons'

interface StatusBarProps {
  theme: Theme
  onToggleTheme: () => void
  /** Connection the active editor tab runs against, e.g. "Connection · wcap_dev". */
  connText: string
  /** Active query result summary, e.g. "SELECT · 3 rows · 22 ms". */
  queryText: string
  /** Target of the active query, e.g. "wcap_dev / wcap". */
  queryTarget: string
}

export function StatusBar({
  theme,
  onToggleTheme,
  connText,
  queryText,
  queryTarget
}: StatusBarProps): ReactElement {
  return (
    <div className="statusbar">
      <button
        className="statusbar__btn"
        onClick={onToggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        type="button"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      {connText && <span className="statusbar__sel">{connText}</span>}
      {connText && queryText && (
        <span className="statusbar__divider" aria-hidden="true" />
      )}
      {queryText && <span className="statusbar__query">{queryText}</span>}
      <span className="statusbar__spacer" />
      {queryTarget && <span className="statusbar__target">{queryTarget}</span>}
    </div>
  )
}
