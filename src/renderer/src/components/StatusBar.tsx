import type { ReactElement } from 'react'

import type { Theme } from '../theme'
import { MoonIcon, SunIcon } from './icons'

interface StatusBarProps {
  theme: Theme
  onToggleTheme: () => void
}

export function StatusBar({ theme, onToggleTheme }: StatusBarProps): ReactElement {
  return (
    <div className="statusbar">
      <div className="statusbar__spacer" />
      <button
        className="statusbar__btn"
        onClick={onToggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        type="button"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  )
}
