import { useCallback, useLayoutEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'dbdesk-theme'

function readInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // localStorage may be unavailable; fall through to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export interface ThemeController {
  theme: Theme
  toggle: () => void
}

/**
 * Track the active light/dark theme, mirror it onto `data-theme` for the CSS
 * token overrides, and persist the user's choice.
 */
export function useTheme(): ThemeController {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Persist and flip from the event handler with a concrete value. A functional
  // updater would be double-invoked under StrictMode, cancelling the toggle and
  // running the side effect twice.
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persistence is best-effort.
    }
    setTheme(next)
  }, [theme])

  return { theme, toggle }
}
