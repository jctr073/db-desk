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
  selectedFileId: string | null
  loadError: string | null

  selectFile: (id: string) => void
  createFile: (connId: string | null, database: string | null) => void
  saveFile: (id: string, content: string) => void
  renameFile: (id: string, name: string) => Promise<boolean>
  deleteFile: (id: string) => void
  clearLoadError: () => void
}

export function useFileState(): FileState {
  const [files, setFiles] = useState<QueryFile[]>([])
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.dbDesk.files.list().then((loaded) => {
      if (cancelled) return
      setFiles(loaded)
      setSelectedFileId((cur) => cur ?? loaded[0]?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectFile = useCallback((id: string) => {
    setSelectedFileId(id)
  }, [])

  const createFile = useCallback(
    async (connId: string | null, database: string | null) => {
      try {
        const newFile = await window.dbDesk.files.create(connId, database)
        setFiles((prev) => [...prev, newFile])
        setSelectedFileId(newFile.id)
      } catch (error) {
        setLoadError(`Failed to create file: ${error instanceof Error ? error.message : String(error)}`)
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
    } catch (error) {
      setLoadError(`Failed to save file: ${error instanceof Error ? error.message : String(error)}`)
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

  const deleteFile = useCallback(async (id: string) => {
    try {
      await window.dbDesk.files.delete(id)
      setFiles((prev) => {
        const next = prev.filter((f) => f.id !== id)
        if (selectedFileId === id) {
          setSelectedFileId(next[0]?.id ?? null)
        }
        return next
      })
    } catch (error) {
      setLoadError(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [selectedFileId])

  const clearLoadError = useCallback(() => setLoadError(null), [])

  return {
    files,
    selectedFileId,
    loadError,
    selectFile,
    createFile,
    saveFile,
    renameFile,
    deleteFile,
    clearLoadError
  }
}
