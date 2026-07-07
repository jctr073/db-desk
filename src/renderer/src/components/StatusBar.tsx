import type { ReactElement } from 'react'

import type { Theme } from '../theme'
import { MoonIcon, SunIcon } from './icons'

interface StatusBarProps {
  theme: Theme
  onToggleTheme: () => void
  /** Selected connection-tree node, e.g. "Connection · wcap_dev". */
  connText: string
  /** Visible object count for the connections tree, e.g. "28 items". */
  connCount: string
  /** Active query result summary, e.g. "SELECT · 3 rows · 22 ms". */
  queryText: string
  /** Target of the active query, e.g. "wcap_dev / wcap". */
  queryTarget: string
}

export function StatusBar({
  theme,
  onToggleTheme,
  connText,
  connCount,
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
      {connCount && <span className="statusbar__count">{connCount}</span>}
      {queryText && <span className="statusbar__divider" aria-hidden="true" />}
      {queryText && <span className="statusbar__query">{queryText}</span>}
      <span className="statusbar__spacer" />
      {queryTarget && <span className="statusbar__target">{queryTarget}</span>}
    </div>
  )
}
