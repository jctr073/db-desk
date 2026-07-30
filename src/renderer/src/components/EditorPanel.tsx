import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'

import type { AgentEditorSelectionItem, AgentResultItem } from '../../../shared/agent'
import type { DatabaseIntrospection } from '../../../shared/db'
import { fileKindFromName, isPreviewableFile, monacoLanguageForFile } from '../../../shared/files'
import type { FileKind } from '../../../shared/files'
import { statementAtOffset } from '../../../shared/sql'
import { ensureSqlLanguageFeatures } from '../sql/completions'
import type { Theme } from '../theme'
import { CloseIcon } from './icons'
import { ResultsPanel } from './ResultsPanel'
import { FilePreview } from './FilePreview'
import { SaveExemplarDialog } from './SaveExemplarDialog'
import { SqlEditor } from './SqlEditor'
import type { QueryRunner, QueryTarget } from './useQueryRunner'
import type { EditorBridge } from './editorBridge'
import {
  externalBufferId,
  externalFileName,
  externalPathFromId,
  isExternalBufferId
} from '../files/externalId'
import type { FileState, QueryFile } from '../files/useFileState'
import type { WatchedFilesState } from '../files/useWatchedFiles'
import { EditorEmptyState } from './editor/EditorEmptyState'
import { ExternalConflictDialog } from './editor/ExternalConflictDialog'
import type { SaveConflict } from './editor/ExternalConflictDialog'
import { ActionsMenu, EditorTabStrip, NewFileMenu, TabContextMenu } from './editor/EditorTabStrip'
import type { FileGroup, TabMenu } from './editor/EditorTabStrip'
import { ProposalOverlay } from './editor/ProposalOverlay'
import type { EditorProposal } from './editor/ProposalOverlay'
import { SaveChangesDialog } from './editor/SaveChangesDialog'
import type { PendingClose } from './editor/SaveChangesDialog'
import { useEditorBridge } from './editor/useEditorBridge'
import { useFileBuffers } from './editor/useFileBuffers'

const DEFAULT_LIMIT = 500

interface EditorPanelProps {
  theme: Theme
  targets: QueryTarget[]
  /** The app's single globally-active connection, or null when offline. */
  activeConnId: string | null
  /** Connection id → display name, for labelling connection tabs. */
  connNames: Record<string, string>
  /** Introspection cache: connection id → database name → schema. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  ensureSchema: (connId: string, database: string) => void
  files: FileState
  /** Watched-folder files: the open set becomes the external tab group. */
  watched: WatchedFilesState
  runner: QueryRunner
  /** Registered on mount so the AI agent can read/insert editor SQL. */
  bridge: MutableRefObject<EditorBridge | null>
  /** Report the active result's summary + target up to the app status bar. */
  onQueryStatus?: (text: string, target: string) => void
  /** Attach a context chip (editor selection, result data) to the AI thread. */
  onAddAgentContext?: (item: AgentEditorSelectionItem | AgentResultItem) => void
  /** Attach result context AND pre-fill the agent composer (Fix with AI). */
  onAskAgent?: (prompt: string, item: AgentResultItem) => void
}

function groupKeyOf(connId: string, database: string | null): string {
  return `${connId ?? ''}\u0000${database ?? ''}`
}

/**
 * The (connection, database) a group's queries run against. Groups made at
 * connection level (no database) fall back to that connection's primary
 * database; with no group open at all, to the app's primary target.
 */
function resolveTarget(group: FileGroup | null, targets: QueryTarget[]): QueryTarget | null {
  const fallback = targets.find((t) => t.primary) ?? targets[0] ?? null
  if (!group) return fallback
  const conn = targets.filter((t) => t.connId === group.connId)
  if (conn.length === 0) return null // connection offline
  if (group.database) {
    return conn.find((t) => t.database === group.database) ?? null
  }
  return conn.find((t) => t.primary) ?? conn[0]
}

export function EditorPanel({
  theme,
  targets,
  activeConnId,
  connNames,
  schemas,
  ensureSchema,
  files,
  watched,
  runner,
  bridge,
  onQueryStatus,
  onAddAgentContext,
  onAskAgent
}: EditorPanelProps): ReactElement {
  const [limit, setLimit] = useState<number | null>(DEFAULT_LIMIT)
  const [resultsPct, setResultsPct] = useState(50)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [newFileMenuOpen, setNewFileMenuOpen] = useState(false)
  const [previewingFileId, setPreviewingFileId] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null)
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [savingBeforeClose, setSavingBeforeClose] = useState(false)
  /** Captured SQL for the "Save as exemplar" dialog; null = closed. */
  const [exemplarSql, setExemplarSql] = useState<string | null>(null)
  /** Agent-proposed buffer replacement awaiting Accept/Reject; null = none. */
  const [proposal, setProposal] = useState<EditorProposal | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const actionsBtnRef = useRef<HTMLButtonElement | null>(null)
  const newFileBtnRef = useRef<HTMLButtonElement | null>(null)
  const cancelRenameRef = useRef(false)

  const activeFileIdRef = useRef<string | null>(null)

  const groups = useMemo(() => {
    const map = new Map<string, FileGroup>()
    for (const file of files.files) {
      if (!files.openFileIds.has(file.id)) continue
      // Legacy connection-less files are re-homed on load (App.adoptOrphans);
      // until that lands they get no tab of their own.
      if (!file.connId) continue
      // Scope to the app's single active connection — other connections'
      // files hide until re-activated, they don't close.
      if (file.connId !== activeConnId) continue
      const key = groupKeyOf(file.connId, file.database)
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          connId: file.connId,
          database: file.database,
          files: [],
          previews: []
        }
        map.set(key, group)
      }
      group.files.push(file)
    }
    for (const tab of runner.tabs) {
      if (tab.source !== 'preview') continue
      if (tab.target.connId !== activeConnId) continue
      const key = groupKeyOf(tab.target.connId, tab.target.database)
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          connId: tab.target.connId,
          database: tab.target.database,
          files: [],
          previews: []
        }
        map.set(key, group)
      }
      group.previews.push(tab)
    }
    return [...map.values()]
  }, [files.files, files.openFileIds, runner.tabs, activeConnId])

  const activeResultTab = runner.tabs.find((tab) => tab.id === runner.activeTabId) ?? null
  const activePreview = activeResultTab?.source === 'preview' ? activeResultTab : null
  const activePreviewGroup = activePreview
    ? groups.find(
        (group) =>
          group.connId === activePreview.target.connId &&
          group.database === activePreview.target.database
      )
    : null

  const activeGroup =
    activePreviewGroup ??
    (files.selectedFileId
      ? groups.find((g) => g.files.some((f) => f.id === files.selectedFileId))
      : null) ??
    groups[0] ??
    null

  // Open watched-folder files form their own connection-independent tab
  // group; the selected one takes over the editor from any internal file.
  const externalOpenFiles = useMemo(
    () => [...watched.openPaths].map((path) => ({ path, name: externalFileName(path) })),
    [watched.openPaths]
  )
  const activeExternalPath =
    watched.selectedPath && watched.openPaths.has(watched.selectedPath)
      ? watched.selectedPath
      : null

  // External files have no pinned connection: they run against the app's
  // active context (the resolveTarget(null, …) fallback), by design.
  const target = resolveTarget(activeExternalPath ? null : activeGroup, targets)
  const selectedFile = files.selectedFileId
    ? files.files.find((f) => f.id === files.selectedFileId)
    : null
  // A stale selection from another connection never reaches Monaco.
  const activeFile = selectedFile && selectedFile.connId === activeConnId ? selectedFile : null
  /** The buffer behind Monaco: an internal file id or an ext:<path> id. */
  const activeFileId = activeExternalPath
    ? externalBufferId(activeExternalPath)
    : (activeFile?.id ?? null)
  activeFileIdRef.current = activeFileId
  const activeName = activeExternalPath
    ? externalFileName(activeExternalPath)
    : (activeFile?.name ?? null)
  const activeFileKind = fileKindFromName(activeName ?? 'query.sql')
  const activeLanguage = monacoLanguageForFile(activeName ?? 'query.sql')
  const isSqlFile = activeFileKind === 'sql'
  const canPreview = !!activeName && isPreviewableFile(activeName)
  const isFilePreview = canPreview && previewingFileId === activeFileId

  // External-file save/conflict machinery: load-time mtimes per path, the
  // conflict dialog, paths that changed on disk under a dirty buffer, and
  // errors from watched IPC (shown in the same bar as file-store errors).
  const externalMtimesRef = useRef(new Map<string, number>())
  const overwriteMtimeRef = useRef<number | null>(null)
  const [saveConflict, setSaveConflict] = useState<SaveConflict | null>(null)
  const [conflictBusy, setConflictBusy] = useState(false)
  const [changedOnDisk, setChangedOnDisk] = useState<ReadonlySet<string>>(new Set())
  const [externalError, setExternalError] = useState<string | null>(null)
  const [extTabMenu, setExtTabMenu] = useState<{ path: string; x: number; y: number } | null>(null)

  const readFileContent = useCallback(async (id: string): Promise<string> => {
    if (!isExternalBufferId(id)) return window.dbDesk.files.read(id)
    const path = externalPathFromId(id)
    try {
      const { content, mtimeMs } = await window.dbDesk.watched.read(path)
      externalMtimesRef.current.set(path, mtimeMs)
      return content
    } catch (error) {
      setExternalError(
        `Failed to open ${externalFileName(path)}: ${error instanceof Error ? error.message : String(error)}`
      )
      return ''
    }
  }, [])

  const saveFileContent = useCallback(
    async (id: string, content: string): Promise<boolean> => {
      if (!isExternalBufferId(id)) return files.saveFile(id, content)
      const path = externalPathFromId(id)
      const override = overwriteMtimeRef.current
      overwriteMtimeRef.current = null
      try {
        const expected = override ?? externalMtimesRef.current.get(path) ?? 0
        const result = await window.dbDesk.watched.write(path, content, expected)
        if (result.status === 'conflict') {
          setSaveConflict({ path, name: externalFileName(path), diskMtimeMs: result.mtimeMs })
          return false
        }
        externalMtimesRef.current.set(path, result.mtimeMs)
        setChangedOnDisk((prev) => {
          if (!prev.has(path)) return prev
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return true
      } catch (error) {
        setExternalError(
          `Failed to save ${externalFileName(path)}: ${error instanceof Error ? error.message : String(error)}`
        )
        return false
      }
    },
    [files]
  )

  // Per-file buffers, dirty tracking, save, and the proposal-apply path.
  const {
    buffersRef,
    suppressChangeRef,
    pendingApplyRef,
    dirtyIds,
    setDirtyIds,
    setEditorValue,
    applyProposal,
    saveFileById
  } = useFileBuffers({
    files,
    editorRef,
    activeFileId,
    activeFileIdRef,
    readFileContent,
    saveFileContent
  })

  const activeContent = activeFileId ? (buffersRef.current.get(activeFileId) ?? '') : ''

  /** Replace an external buffer with the on-disk version, discarding edits. */
  const reloadExternal = useCallback(
    async (path: string): Promise<void> => {
      try {
        const { content, mtimeMs } = await window.dbDesk.watched.read(path)
        externalMtimesRef.current.set(path, mtimeMs)
        const id = externalBufferId(path)
        buffersRef.current.set(id, content)
        if (activeFileIdRef.current === id) setEditorValue(content)
        setDirtyIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setChangedOnDisk((prev) => {
          if (!prev.has(path)) return prev
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      } catch (error) {
        setExternalError(
          `Failed to reload ${externalFileName(path)}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    [buffersRef, activeFileIdRef, setEditorValue, setDirtyIds]
  )

  // React to files changing on disk while open: clean buffers reload
  // silently, dirty ones get a non-blocking banner instead.
  useEffect(() => {
    for (const file of watched.files) {
      if (!watched.openPaths.has(file.path)) continue
      const loaded = externalMtimesRef.current.get(file.path)
      if (loaded === undefined || file.mtimeMs <= loaded) continue
      if (dirtyIds.has(externalBufferId(file.path))) {
        setChangedOnDisk((prev) => (prev.has(file.path) ? prev : new Set(prev).add(file.path)))
      } else {
        void reloadExternal(file.path)
      }
    }
  }, [watched.files, watched.openPaths, dirtyIds, reloadExternal])

  const queryTabs = runner.tabs.filter(
    (tab) => tab.source !== 'preview' && tab.target.connId === activeConnId
  )

  const leavePreview = useCallback(() => {
    if (!activePreview) return
    const fallback = queryTabs[queryTabs.length - 1]
    runner.setActiveTab(fallback?.id ?? null)
  }, [activePreview, queryTabs, runner])

  const selectFile = useCallback(
    (id: string) => {
      files.selectFile(id)
      leavePreview()
    },
    [files, leavePreview]
  )

  // A stale file selection from another connection is never left standing:
  // fall back to the first visible file once the active connection changes.
  useEffect(() => {
    const id = files.selectedFileId
    if (!id) return
    const selected = files.files.find((f) => f.id === id)
    if (!selected || selected.connId === activeConnId) return
    const firstVisible = groups[0]?.files[0]
    if (firstVisible) files.selectFile(firstVisible.id)
  }, [files, activeConnId, groups])

  // The imperative handle the AI agent panel calls into, plus the mirror
  // refs its once-registered listeners (and ours below) read at call time.
  const { activeFileNameRef, activeIsSqlRef } = useEditorBridge({
    bridge,
    editorRef,
    activeFileIdRef,
    buffersRef,
    pendingApplyRef,
    applyProposal,
    setProposal,
    activeFileName: activeName,
    isSqlFile,
    proposalHome: activeGroup
      ? { connId: activeGroup.connId, database: activeGroup.database }
      : target
        ? { connId: target.connId, database: target.database }
        : null,
    createFile: files.createFile
  })

  // Completion reads the active target's schema through this ref so the
  // provider (registered once) always sees the latest introspection.
  const activeSchema =
    target && isSqlFile ? (schemas[target.connId]?.[target.database] ?? null) : null
  const schemaRef = useRef<DatabaseIntrospection | null>(null)
  schemaRef.current = activeSchema

  // Databases a tab points at may not have been expanded in the tree yet;
  // introspect them so completions have something to offer.
  useEffect(() => {
    if (target && isSqlFile) ensureSchema(target.connId, target.database)
  }, [target, isSqlFile, ensureSchema])

  const runCurrent = useCallback(() => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model || !target || !isSqlFile) return
    const selection = ed.getSelection()
    let sql: string | null
    if (selection && !selection.isEmpty()) {
      sql = model.getValueInRange(selection)
    } else {
      const position = ed.getPosition()
      const offset = position ? model.getOffsetAt(position) : 0
      sql = statementAtOffset(model.getValue(), offset)?.text ?? null
    }
    if (!sql?.trim()) return
    runner.run(sql.trim(), target, limit)
  }, [target, limit, runner, isSqlFile])

  const runRef = useRef(runCurrent)
  useEffect(() => {
    runRef.current = runCurrent
  })

  /** Capture the query at the cursor (or selection, or whole buffer) to save. */
  const openExemplar = useCallback(() => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model) return
    const selection = ed.getSelection()
    let sql: string | null
    if (selection && !selection.isEmpty()) {
      sql = model.getValueInRange(selection)
    } else {
      const position = ed.getPosition()
      const offset = position ? model.getOffsetAt(position) : 0
      sql = statementAtOffset(model.getValue(), offset)?.text ?? null
    }
    if (!sql?.trim()) sql = model.getValue()
    setExemplarSql(sql.trim())
  }, [])

  // Cmd+S is registered once on mount; route it through a ref so it always
  // saves the currently selected file.
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => {
    saveRef.current = () => void saveFileById(activeFileIdRef.current)
  }, [saveFileById])

  /** "Add Selection to AI Chat": snapshot the selection as a context chip. */
  const addSelectionToAgent = useCallback(() => {
    if (!activeIsSqlRef.current) return
    const ed = editorRef.current
    const model = ed?.getModel()
    const selection = ed?.getSelection()
    if (!model || !selection || selection.isEmpty()) return
    const sql = model.getValueInRange(selection)
    if (!sql.trim()) return
    onAddAgentContext?.({
      kind: 'editor-selection',
      id: crypto.randomUUID(),
      fileName: activeFileNameRef.current,
      sql,
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber
    })
  }, [onAddAgentContext, activeIsSqlRef, activeFileNameRef])
  const addSelectionRef = useRef(addSelectionToAgent)
  useEffect(() => {
    addSelectionRef.current = addSelectionToAgent
  })

  /** "Add Query to AI Chat": snapshot the whole editor as a context chip. */
  const addQueryToAgent = useCallback(() => {
    if (!activeIsSqlRef.current) return
    const model = editorRef.current?.getModel()
    if (!model) return
    const sql = model.getValue()
    if (!sql.trim()) return
    onAddAgentContext?.({
      kind: 'editor-selection',
      id: crypto.randomUUID(),
      fileName: activeFileNameRef.current,
      sql,
      startLine: 1,
      endLine: model.getLineCount()
    })
  }, [onAddAgentContext, activeIsSqlRef, activeFileNameRef])
  const addQueryRef = useRef(addQueryToAgent)
  useEffect(() => {
    addQueryRef.current = addQueryToAgent
  })

  const acceptProposal = useCallback(() => {
    if (!proposal) return
    applyProposal(proposal.fileId, proposal.sql)
    setProposal(null)
  }, [proposal, applyProposal])

  const rejectProposal = useCallback(() => {
    setProposal(null)
    editorRef.current?.focus()
  }, [])

  const handleMount = useCallback<OnMount>(
    (ed, monaco) => {
      editorRef.current = ed
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current())
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
      ed.addAction({
        id: 'db-desk.add-selection-to-agent',
        label: 'Add Selection to AI Chat',
        contextMenuGroupId: '9_dbdesk',
        contextMenuOrder: 1,
        precondition: 'editorHasSelection',
        run: () => addSelectionRef.current()
      })
      ed.addAction({
        id: 'db-desk.add-query-to-agent',
        label: 'Add Query to AI Chat',
        contextMenuGroupId: '9_dbdesk',
        contextMenuOrder: 2,
        run: () => addQueryRef.current()
      })
      ed.onDidChangeModelContent(() => {
        if (suppressChangeRef.current) return
        const id = activeFileIdRef.current
        if (!id) return
        buffersRef.current.set(id, ed.getValue())
        setDirtyIds((prev) => {
          if (prev.has(id)) return prev
          return new Set(prev).add(id)
        })
      })
      // A file may have been selected before Monaco finished mounting.
      const pendingId = activeFileIdRef.current
      if (pendingId) {
        const buffered = buffersRef.current.get(pendingId)
        if (buffered !== undefined) {
          suppressChangeRef.current = true
          ed.setValue(buffered)
          suppressChangeRef.current = false
        }
      }
      ensureSqlLanguageFeatures(monaco, () => schemaRef.current)
    },
    [buffersRef, suppressChangeRef, setDirtyIds]
  )

  const finishClose = useCallback(
    (closing: PendingClose) => {
      const bufferIds = [
        ...closing.fileIds,
        ...closing.externalPaths.map((path) => externalBufferId(path))
      ]
      for (const id of bufferIds) buffersRef.current.delete(id)
      setDirtyIds((prev) => {
        const next = new Set(prev)
        for (const id of bufferIds) next.delete(id)
        return next
      })
      // A pending proposal for a closing file has nothing left to apply to.
      setProposal((prev) => (prev && closing.fileIds.includes(prev.fileId) ? null : prev))
      files.closeFiles(closing.fileIds)
      watched.closeFiles(closing.externalPaths)
      setChangedOnDisk((prev) => {
        if (closing.externalPaths.every((path) => !prev.has(path))) return prev
        const next = new Set(prev)
        for (const path of closing.externalPaths) next.delete(path)
        return next
      })
      runner.closeTabs(closing.resultTabIds)
      setTabMenu((menu) => (menu && closing.fileIds.includes(menu.fileId) ? null : menu))
      setPendingClose(null)
    },
    [files, watched, runner, buffersRef, setDirtyIds]
  )

  const requestClose = useCallback(
    (
      fileIds: string[],
      resultTabIds: string[],
      label: string,
      groupKey: string | null = null,
      externalPaths: string[] = []
    ) => {
      const closingIds = new Set(fileIds)
      const dirtyInternal = files.files.filter(
        (file) => closingIds.has(file.id) && dirtyIds.has(file.id)
      )
      const dirtyExternal = externalPaths
        .filter((path) => dirtyIds.has(externalBufferId(path)))
        .map((path) => ({ id: externalBufferId(path), name: externalFileName(path) }))
      const closing = {
        label,
        fileIds,
        externalPaths,
        resultTabIds,
        dirtyFiles: [...dirtyInternal, ...dirtyExternal],
        groupKey
      }
      if (closing.dirtyFiles.length === 0) finishClose(closing)
      else setPendingClose(closing)
    },
    [dirtyIds, files.files, finishClose]
  )

  const closeFile = useCallback(
    (file: QueryFile) => requestClose([file.id], [], file.name),
    [requestClose]
  )

  const closeExternal = useCallback(
    (path: string) => requestClose([], [], externalFileName(path), null, [path]),
    [requestClose]
  )

  const saveAndClose = useCallback(async () => {
    if (!pendingClose || savingBeforeClose) return
    setSavingBeforeClose(true)
    for (const file of pendingClose.dirtyFiles) {
      if (!(await saveFileById(file.id))) {
        setSavingBeforeClose(false)
        return
      }
    }
    setSavingBeforeClose(false)
    finishClose(pendingClose)
  }, [finishClose, pendingClose, saveFileById, savingBeforeClose])

  const selectExternal = useCallback(
    (path: string) => {
      watched.openFile(path)
      leavePreview()
    },
    [watched, leavePreview]
  )

  const resolveConflictOverwrite = useCallback(async () => {
    if (!saveConflict || conflictBusy) return
    setConflictBusy(true)
    overwriteMtimeRef.current = saveConflict.diskMtimeMs
    const saved = await saveFileById(externalBufferId(saveConflict.path))
    setConflictBusy(false)
    if (saved) setSaveConflict(null)
  }, [saveConflict, conflictBusy, saveFileById])

  const resolveConflictReload = useCallback(async () => {
    if (!saveConflict || conflictBusy) return
    setConflictBusy(true)
    await reloadExternal(saveConflict.path)
    setConflictBusy(false)
    setSaveConflict(null)
  }, [saveConflict, conflictBusy, reloadExternal])

  const openTabMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, file: QueryFile) => {
      event.preventDefault()
      selectFile(file.id)
      setTabMenu({ fileId: file.id, x: event.clientX, y: event.clientY })
    },
    [selectFile]
  )

  const startRename = useCallback((file: QueryFile) => {
    setTabMenu(null)
    cancelRenameRef.current = false
    setRenameDraft(file.name)
    setRenamingFileId(file.id)
  }, [])

  const commitRename = useCallback(() => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      return
    }
    if (!renamingFileId) return
    const id = renamingFileId
    const name = renameDraft
    setRenamingFileId(null)
    void files.renameFile(id, name)
  }, [files, renameDraft, renamingFileId])

  const cancelRename = useCallback(() => {
    cancelRenameRef.current = true
    setRenamingFileId(null)
  }, [])

  const createFile = useCallback(
    (kind: FileKind) => {
      // Files always live on a connection; with none open there is nowhere to
      // put one (the New File button is disabled in that state).
      const home = activeGroup ?? target
      if (!home) return
      files.createFile(home.connId, home.database ?? null, kind)
      setNewFileMenuOpen(false)
      leavePreview()
    },
    [activeGroup, target, files, leavePreview]
  )

  const startResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const host = splitRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      const pct = ((rect.bottom - ev.clientY) / rect.height) * 100
      setResultsPct(Math.min(80, Math.max(15, pct)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  /** The diff review renders only over the file it targets. */
  const showProposal =
    proposal !== null && !activePreview && isSqlFile && activeFileId === proposal.fileId

  /** Nothing open: show the default screen instead of a blank Monaco surface. */
  const isEmpty = groups.length === 0 && externalOpenFiles.length === 0

  return (
    <section className="editor-panel">
      <EditorTabStrip
        groups={groups}
        externalFiles={externalOpenFiles}
        selectedExternalPath={activeExternalPath}
        onSelectExternal={selectExternal}
        onCloseExternal={closeExternal}
        onExternalContextMenu={(event, path) => {
          event.preventDefault()
          selectExternal(path)
          setExtTabMenu({ path, x: event.clientX, y: event.clientY })
        }}
        selectedFileId={activeExternalPath ? null : files.selectedFileId}
        activePreview={activePreview}
        dirtyIds={dirtyIds}
        renamingFileId={renamingFileId}
        renameDraft={renameDraft}
        onRenameDraftChange={setRenameDraft}
        onRenameCommit={commitRename}
        onRenameCancel={cancelRename}
        onSelectFile={selectFile}
        onTabContextMenu={openTabMenu}
        onCloseFile={closeFile}
        onSelectResultTab={runner.setActiveTab}
        onCloseResultTab={runner.closeTab}
        newFileBtnRef={newFileBtnRef}
        newFileMenuOpen={newFileMenuOpen}
        newFileDisabled={!activeGroup && !target}
        onToggleNewFileMenu={() => {
          setActionsOpen(false)
          setNewFileMenuOpen((open) => !open)
        }}
        target={target}
        isSqlFile={isSqlFile}
        onRun={runCurrent}
        isFilePreview={isFilePreview}
        onExitFilePreview={() => setPreviewingFileId(null)}
        onEnterFilePreview={() => setPreviewingFileId(activeFileId)}
        actionsBtnRef={actionsBtnRef}
        actionsOpen={actionsOpen}
        onToggleActions={() => {
          setNewFileMenuOpen(false)
          setActionsOpen((open) => !open)
        }}
      />
      {files.loadError && (
        <div className="load-error" role="alert">
          <span className="load-error__text">{files.loadError}</span>
          <button
            className="load-error__close"
            onClick={files.clearLoadError}
            title="Dismiss"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {externalError && (
        <div className="load-error" role="alert">
          <span className="load-error__text">{externalError}</span>
          <button
            className="load-error__close"
            onClick={() => setExternalError(null)}
            title="Dismiss"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {activeExternalPath && changedOnDisk.has(activeExternalPath) && (
        <div className="file-changed-bar" role="status">
          <span className="file-changed-bar__text">
            <strong>{externalFileName(activeExternalPath)}</strong> changed on disk while you have
            unsaved edits.
          </span>
          <button
            className="file-changed-bar__btn"
            type="button"
            onClick={() => void reloadExternal(activeExternalPath)}
          >
            Reload
          </button>
          <button
            className="file-changed-bar__btn"
            type="button"
            onClick={() =>
              setChangedOnDisk((prev) => {
                const next = new Set(prev)
                next.delete(activeExternalPath)
                return next
              })
            }
          >
            Keep mine
          </button>
        </div>
      )}
      {saveConflict && (
        <ExternalConflictDialog
          conflict={saveConflict}
          busy={conflictBusy}
          onOverwrite={() => void resolveConflictOverwrite()}
          onReload={() => void resolveConflictReload()}
          onCancel={() => setSaveConflict(null)}
        />
      )}
      {extTabMenu && (
        <div
          className="ctx-overlay"
          onMouseDown={() => setExtTabMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setExtTabMenu(null)
          }}
        >
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: extTabMenu.x, top: extTabMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="ctx-menu__item"
              type="button"
              role="menuitem"
              onClick={() => {
                void window.dbDesk.watched.reveal(extTabMenu.path)
                setExtTabMenu(null)
              }}
            >
              Reveal in Finder
            </button>
          </div>
        </div>
      )}
      {pendingClose && (
        <SaveChangesDialog
          pendingClose={pendingClose}
          saving={savingBeforeClose}
          onSave={() => void saveAndClose()}
          onDiscard={() => finishClose(pendingClose)}
          onCancel={() => setPendingClose(null)}
        />
      )}
      {tabMenu && (
        <TabContextMenu
          menu={tabMenu}
          onRename={() => {
            const file = files.files.find((candidate) => candidate.id === tabMenu.fileId)
            if (file) startRename(file)
          }}
          onClose={() => setTabMenu(null)}
        />
      )}
      {newFileMenuOpen && newFileBtnRef.current && (
        <NewFileMenu
          anchor={newFileBtnRef.current}
          onCreate={createFile}
          onClose={() => setNewFileMenuOpen(false)}
        />
      )}
      {!activePreview && actionsOpen && actionsBtnRef.current && (
        <ActionsMenu
          anchor={actionsBtnRef.current}
          isSqlFile={isSqlFile}
          saveDisabled={!activeFileId || !dirtyIds.has(activeFileId)}
          hasTarget={!!target}
          onSave={() => saveFileById(activeFileId)}
          onExemplar={openExemplar}
          onClose={() => setActionsOpen(false)}
        />
      )}
      {exemplarSql !== null && target && (
        <SaveExemplarDialog
          connId={target.connId}
          database={target.database}
          targetLabel={`${target.connName} / ${target.database}`}
          initialSql={exemplarSql}
          onClose={() => setExemplarSql(null)}
        />
      )}
      {activePreview ? (
        <ResultsPanel
          tabs={[activePreview]}
          activeTabId={activePreview.id}
          limit={100}
          onLimitChange={() => {}}
          onSelect={runner.setActiveTab}
          onClose={runner.closeTab}
          onCloseMany={runner.closeTabs}
          onCloseAll={runner.closeAll}
          onPin={runner.pin}
          onRerun={(id) => runner.rerun(id, 100)}
          showLimitControl={false}
          contentOnly
          onStatus={onQueryStatus}
          onAddAgentContext={onAddAgentContext}
          onAskAgent={onAskAgent}
        />
      ) : (
        <div className="editor-split" ref={splitRef}>
          <div className="editor-host">
            <SqlEditor theme={theme} language={activeLanguage} onMount={handleMount} />
            {isFilePreview && activeFileKind !== 'sql' && (
              <FilePreview kind={activeFileKind} content={activeContent} />
            )}
            <ProposalOverlay
              show={showProposal}
              proposal={proposal}
              theme={theme}
              activeFileName={activeFile?.name ?? null}
              activeContent={activeContent}
              onAccept={acceptProposal}
              onReject={rejectProposal}
            />
            {isEmpty && (
              <EditorEmptyState
                target={target}
                connNames={connNames}
                files={files}
                onOpenFile={selectFile}
              />
            )}
          </div>
          {isSqlFile && queryTabs.length > 0 && (
            <>
              <div className="split-divider" onPointerDown={startResize} role="separator" />
              <div className="results-host" style={{ flex: `0 0 ${resultsPct}%` }}>
                <ResultsPanel
                  tabs={queryTabs}
                  activeTabId={runner.activeTabId}
                  limit={limit}
                  onLimitChange={setLimit}
                  onSelect={runner.setActiveTab}
                  onClose={runner.closeTab}
                  onCloseMany={runner.closeTabs}
                  onCloseAll={() => runner.closeTabs(queryTabs.map((tab) => tab.id))}
                  onPin={runner.pin}
                  onRerun={(id) => runner.rerun(id, limit)}
                  onStatus={onQueryStatus}
                  onAddAgentContext={onAddAgentContext}
                  onAskAgent={onAskAgent}
                />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
