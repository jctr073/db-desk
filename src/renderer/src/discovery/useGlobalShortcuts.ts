import { useEffect, useRef } from 'react'

import type { CommandId } from '../../../shared/features'

const isMac = /Mac/.test(navigator.platform)

/**
 * App-wide keyboard shortcuts that must work no matter what has focus:
 * ⌘K opens the command palette, ⌘/ opens the shortcut sheet, ⌘⇧/ toggles
 * highlight mode. A single capture-phase `window` listener beats every
 * other handler (including Monaco's own, which is why `EditorPanel`
 * additionally registers the same chords with Monaco directly — see
 * plan §2.4).
 *
 * `run` is read through a ref so the listener is attached exactly once,
 * regardless of how often the caller's `run` identity changes.
 */
export function useGlobalShortcuts(run: (id: CommandId) => void): void {
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const chord = isMac ? event.metaKey : event.ctrlKey
      if (!chord || event.altKey) return

      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        runRef.current('app.openPalette')
        return
      }

      if (event.key === '/' || event.code === 'Slash') {
        event.preventDefault()
        event.stopPropagation()
        runRef.current(event.shiftKey ? 'app.toggleHighlight' : 'app.openShortcuts')
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])
}
