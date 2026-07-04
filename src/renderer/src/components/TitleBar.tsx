import type { ReactElement } from 'react'

import type { Theme } from '../theme'
import { MoonIcon, SunIcon } from './icons'

interface TitleBarProps {
  theme: Theme
  onToggleTheme: () => void
  title: string
}

export function TitleBar({ theme, onToggleTheme, title }: TitleBarProps): ReactElement {
  return (
    <div className="titlebar">
      <div className="traffic-lights">
        <span className="traffic-light traffic-light--red" />
        <span className="traffic-light traffic-light--yellow" />
        <span className="traffic-light traffic-light--green" />
      </div>
      <div className="titlebar__title">{title}</div>
      <button
        className="icon-btn icon-btn--toggle"
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
