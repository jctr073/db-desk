import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'

import type { FileState } from '../../files/useFileState'

interface FileBuffersParams {
  files: FileState
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  /** The visible file, mirrored into a ref for the once-registered listeners. */
  activeFileId: string | null
  activeFileIdRef: MutableRefObject<string | null>
  /**
   * Content IO, injectable so external (watched-folder) buffers can route to
   * `watched:*` while internal ids keep the query store. Defaults to the
   * internal store. Must be identity-stable (useCallback in the panel).
   */
  readFileContent?: (id: string) => Promise<string>
  saveFileContent?: (id: string, content: string) => Promise<boolean>
}

/**
 * Per-file text buffers behind the single Monaco instance: unsaved edits
 * survive tab switches, dirty tracking, save, and the agent-proposal apply
 * path. Extracted verbatim from EditorPanel — the invariants live in the
 * comments below. The return type is inferred so it stays in sync.
 */
export function useFileBuffers({
  files,
  editorRef,
  activeFileId,
  activeFileIdRef,
  readFileContent,
  saveFileContent
}: FileBuffersParams) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set())
  // Bumped whenever a buffer changes outside Monaco (e.g. applyProposal on a
  // background file), so render-time reads of buffersRef see fresh content.
  const [, setBufferRevision] = useState(0)
  /** SQL to apply to the next freshly-loaded file (created for a proposal). */
  const pendingApplyRef = useRef<string | null>(null)

  // Per-file buffers so switching tabs preserves unsaved edits.
  const buffersRef = useRef(new Map<string, string>())
  // Distinguishes programmatic setValue (tab switch) from user typing.
  const suppressChangeRef = useRef(false)

  /**
   * Replace one file's contents with agent-proposed SQL. Routed through
   * executeEdits when that file is live in Monaco — undo-friendly, and the
   * change listener marks it dirty — else written straight to its buffer
   * (the editor may be unmounted behind a data preview).
   */
  const applyProposal = useCallback(
    (fileId: string, text: string) => {
      const ed = editorRef.current
      const model = ed?.getModel()
      if (activeFileIdRef.current === fileId && ed && model && !model.isDisposed()) {
        ed.executeEdits('ai-agent', [
          { range: model.getFullModelRange(), text, forceMoveMarkers: true }
        ])
        ed.focus()
        return
      }
      buffersRef.current.set(fileId, text)
      setDirtyIds((prev) => (prev.has(fileId) ? prev : new Set(prev).add(fileId)))
      setBufferRevision((revision) => revision + 1)
    },
    [editorRef, activeFileIdRef]
  )

  const setEditorValue = useCallback(
    (value: string) => {
      const ed = editorRef.current
      if (!ed || ed.getValue() === value) return
      suppressChangeRef.current = true
      ed.setValue(value)
      suppressChangeRef.current = false
    },
    [editorRef]
  )

  // Swap the editor buffer when the visible file changes. Keyed on the
  // active (visible) file, not the raw selection: a selection left on
  // another connection's file must never land its SQL in Monaco.
  useEffect(() => {
    const id = activeFileId
    if (!id) {
      setEditorValue('')
      return
    }
    const cached = buffersRef.current.get(id)
    if (cached !== undefined) {
      setEditorValue(cached)
      return
    }
    let cancelled = false
    const read = readFileContent ?? ((fileId: string) => window.dbDesk.files.read(fileId))
    void read(id).then((content) => {
      if (cancelled) return
      // A proposal that had to create this file lands as its initial
      // contents (unsaved, so the dirty dot shows it needs a ⌘S).
      const pending = pendingApplyRef.current
      pendingApplyRef.current = null
      const next = pending ?? content
      buffersRef.current.set(id, next)
      if (pending !== null) {
        setDirtyIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      }
      if (activeFileIdRef.current === id) {
        setEditorValue(next)
        setBufferRevision((revision) => revision + 1)
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeFileId, setEditorValue, activeFileIdRef, readFileContent])

  const saveFileById = useCallback(
    async (id: string | null): Promise<boolean> => {
      if (!id) return false
      const content = buffersRef.current.get(id)
      if (content === undefined) return false
      const save = saveFileContent ?? files.saveFile
      const saved = await save(id, content)
      if (!saved) return false
      setDirtyIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      return true
    },
    [files, saveFileContent]
  )

  return {
    buffersRef,
    suppressChangeRef,
    pendingApplyRef,
    dirtyIds,
    setDirtyIds,
    setEditorValue,
    applyProposal,
    saveFileById
  }
}
