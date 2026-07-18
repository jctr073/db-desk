import { useEffect, useRef } from 'react'

/**
 * Window-level Escape handling shared by menus, popovers and dialogs: while
 * `active` is true, an Escape keydown calls `onEscape`. The handler is read
 * through a ref, so call sites may pass inline closures without re-attaching
 * the listener on every render — only `active` flips subscribe/unsubscribe.
 */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape)
  useEffect(() => {
    onEscapeRef.current = onEscape
  })

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onEscapeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}
