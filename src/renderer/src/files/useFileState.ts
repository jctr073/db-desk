import { useCallback, useEffect, useState } from 'react'

export interface QueryFile {
  id: string
  name: string
  connId: string | null
  database: string | null
  createdAt: number
  updatedAt: number
}

export interface FileState {
  files: QueryFile[]
  openFileIds: ReadonlySet<string>
  selectedFileId: string | null
  loadError: string | null

  selectFile: (id: string) => void
  createFile: (connId: string | null, database: string | null) => void
  saveFile: (id: string, content: string) => Promise<boolean>
  renameFile: (id: string, name: string) => Promise<boolean>
  closeFiles: (ids: readonly string[]) => void
  deleteFile: (id: string) => void
  clearLoadError: () => void
}

export function closeOpenFiles(
  files: readonly QueryFile[],
  openFileIds: ReadonlySet<string>,
  selectedFileId: string | null,
  closingIds: readonly string[]
): { openFileIds: Set<string>; selectedFileId: string | null } {
  const closing = new Set(closingIds)
  const nextOpenFileIds = new Set(
    [...openFileIds].filter((candidate) => !closing.has(candidate))
  )
  return {
    openFileIds: nextOpenFileIds,
    selectedFileId:
      selectedFileId && closing.has(selectedFileId)
        ? (files.find((file) => nextOpenFileIds.has(file.id))?.id ?? null)
        : selectedFileId
  }
}

export function useFileState(): FileState {
  const [files, setFiles] = useState<QueryFile[]>([])
  const [openFileIds, setOpenFileIds] = useState<ReadonlySet<string>>(new Set())
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.dbDesk.files.list().then((loaded) => {
      if (cancelled) return
      setFiles(loaded)
      setOpenFileIds(new Set(loaded.map((file) => file.id)))
      setSelectedFileId((cur) => cur ?? loaded[0]?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectFile = useCallback((id: string) => {
    setOpenFileIds((prev) => new Set(prev).add(id))
    setSelectedFileId(id)
  }, [])

  const createFile = useCallback(
    async (connId: string | null, database: string | null) => {
      try {
        const newFile = await window.dbDesk.files.create(connId, database)
        setFiles((prev) => [...prev, newFile])
        setOpenFileIds((prev) => new Set(prev).add(newFile.id))
        setSelectedFileId(newFile.id)
      } catch (error) {
        setLoadError(
          `Failed to create file: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    []
  )

  const saveFile = useCallback(async (id: string, content: string) => {
    try {
      await window.dbDesk.files.save(id, content)
      setFiles((prev) =>
        prev.map((f) => (f.id === id ? { ...f, updatedAt: Date.now() } : f))
      )
      return true
    } catch (error) {
      setLoadError(
        `Failed to save file: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }, [])

  const renameFile = useCallback(async (id: string, name: string) => {
    try {
      const renamed = await window.dbDesk.files.rename(id, name)
      setFiles((prev) => prev.map((file) => (file.id === id ? renamed : file)))
      return true
    } catch (error) {
      setLoadError(
        `Failed to rename file: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }, [])

  const closeFiles = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return
      const next = closeOpenFiles(files, openFileIds, selectedFileId, ids)
      setOpenFileIds(next.openFileIds)
      setSelectedFileId(next.selectedFileId)
    },
    [files, openFileIds, selectedFileId]
  )

  const deleteFile = useCallback(
    async (id: string) => {
      try {
        await window.dbDesk.files.delete(id)
        setFiles((prev) => {
          const next = prev.filter((f) => f.id !== id)
          if (selectedFileId === id) {
            setSelectedFileId(
              next.find((file) => openFileIds.has(file.id))?.id ?? null
            )
          }
          return next
        })
        setOpenFileIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      } catch (error) {
        setLoadError(
          `Failed to delete file: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    [openFileIds, selectedFileId]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  return {
    files,
    openFileIds,
    selectedFileId,
    loadError,
    selectFile,
    createFile,
    saveFile,
    renameFile,
    closeFiles,
    deleteFile,
    clearLoadError
  }
}
