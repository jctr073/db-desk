import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

export type Theme = 'dark' | 'light'
/** What the user picked in Settings; 'system' follows the OS appearance. */
export type ThemePreference = Theme | 'system'

const STORAGE_KEY = 'dbdesk-theme'

function readInitialPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored
    }
  } catch {
    // localStorage may be unavailable; fall through to the system preference.
  }
  return 'system'
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

export interface ThemeController {
  /** The resolved light/dark theme currently applied. */
  theme: Theme
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

/**
 * Track the theme preference (light / dark / follow-the-OS), mirror the
 * resolved theme onto `data-theme` for the CSS token overrides, and persist
 * the user's choice.
 */
export function useTheme(): ThemeController {
  const [preference, setStoredPreference] = useState<ThemePreference>(
    readInitialPreference
  )
  const [osTheme, setOsTheme] = useState<Theme>(systemTheme)

  // Follow live OS appearance changes while the preference is 'system'.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!query) return
    const onChange = (): void => setOsTheme(query.matches ? 'light' : 'dark')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const theme = preference === 'system' ? osTheme : preference

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persistence is best-effort.
    }
    setStoredPreference(next)
  }, [])

  return { theme, preference, setPreference }
}
