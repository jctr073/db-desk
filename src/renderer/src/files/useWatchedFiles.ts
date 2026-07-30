import { useCallback, useEffect, useState } from 'react'

import type { ExternalFile } from '../../../shared/files'
import type { WatchedFolder } from '../../../shared/settings'

/**
 * Renderer state for watched-folder (external) files: the live listing pushed
 * from main plus which files are open/selected in the editor. Open state is
 * keyed by absolute path and deliberately independent of the listing — a file
 * deleted on disk keeps its tab (and any unsaved edits) until closed, and a
 * ⌘S simply recreates it.
 */
export interface WatchedFilesState {
  /** The configured folders, for grouping/labelling the listing. */
  folders: WatchedFolder[]
  /** Every supported file under every watched folder, as last pushed. */
  files: ExternalFile[]
  /** Absolute paths open as editor tabs. */
  openPaths: ReadonlySet<string>
  /** The open path the editor shows, or null when an internal file is active. */
  selectedPath: string | null

  /** Open (or re-focus) a file as an editor tab. */
  openFile: (path: string) => void
  closeFiles: (paths: readonly string[]) => void
  /** Drop the external selection (an internal file became active). */
  clearSelection: () => void
}

export function useWatchedFiles(): WatchedFilesState {
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [files, setFiles] = useState<ExternalFile[]>([])
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.dbDesk.watched.list().then((listed) => {
      if (!cancelled) setFiles(listed)
    })
    const unsubscribe = window.dbDesk.watched.onChanged((listed) => setFiles(listed))
    // Folder add/remove lands as settings:changed; the listing itself follows
    // separately over watched:changed.
    const loadFolders = (): void => {
      void window.dbDesk.settings.get().then((info) => {
        if (!cancelled) setFolders(info.watchedFolders)
      })
    }
    loadFolders()
    const unsubscribeSettings = window.dbDesk.settings.onChanged(loadFolders)
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeSettings()
    }
  }, [])

  const openFile = useCallback((path: string) => {
    setOpenPaths((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
    setSelectedPath(path)
  }, [])

  const closeFiles = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 0) return
      const closing = new Set(paths)
      const next = new Set([...openPaths].filter((path) => !closing.has(path)))
      setOpenPaths(next)
      setSelectedPath((selected) =>
        selected && closing.has(selected) ? ([...next][0] ?? null) : selected
      )
    },
    [openPaths]
  )

  const clearSelection = useCallback(() => setSelectedPath(null), [])

  return { folders, files, openPaths, selectedPath, openFile, closeFiles, clearSelection }
}
