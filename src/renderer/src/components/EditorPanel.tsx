import { DiffEditor } from '@monaco-editor/react'
import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'

import type {
  AgentEditorSelectionItem,
  AgentResultItem
} from '../../../shared/agent'
import type { DatabaseIntrospection } from '../../../shared/db'
import {
  fileKindFromName,
  isPreviewableFile,
  monacoLanguageForFile,
  supportedExtension
} from '../../../shared/files'
import type { FileKind } from '../../../shared/files'
import { statementAtOffset } from '../../../shared/sql'
import { ensureSqlLanguageFeatures } from '../sql/completions'
import type { Theme } from '../theme'
import {
  DatabaseIcon,
  EyeIcon,
  FormatIcon,
  KebabIcon,
  PlayIcon,
  PlusThinIcon,
  SaveIcon,
  SparkleIcon,
  SqlDocIcon,
  SqlFileIcon,
  CloseIcon
} from './icons'
import { ResultsPanel } from './ResultsPanel'
import { FilePreview } from './FilePreview'
import { SaveExemplarDialog } from './SaveExemplarDialog'
import { SqlEditor, defineThemes, resolveTheme } from './SqlEditor'
import type { QueryRunner, QueryTarget } from './useQueryRunner'
import type { ResultTab } from './useQueryRunner'
import type { EditorBridge } from './editorBridge'
import type { FileState, QueryFile } from '../files/useFileState'

const DEFAULT_LIMIT = 500

/** Inline (single-pane) read-only diff for reviewing an AI proposal. */
const PROPOSAL_DIFF_OPTIONS: editor.IDiffEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: 13,
  minimap: { enabled: false },
  originalEditable: false,
  readOnly: true,
  renderOverviewRuler: false,
  renderSideBySide: false,
  scrollBeyondLastLine: false,
  wordWrap: 'on'
}

/** Dot colors cycled per connection, in tree order (see connColors). */
const CONN_COLORS = [
  'var(--accent)',
  'var(--teal)',
  'var(--green)',
  'var(--amber)',
  'var(--red)'
]

interface EditorPanelProps {
  theme: Theme
  targets: QueryTarget[]
  /** Connection id → display name, for labelling connection tabs. */
  connNames: Record<string, string>
  /** Introspection cache: connection id → database name → schema. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  ensureSchema: (connId: string, database: string) => void
  files: FileState
  runner: QueryRunner
  /** Registered on mount so the AI agent can read/insert editor SQL. */
  bridge: MutableRefObject<EditorBridge | null>
  /** Report the active result's summary + target up to the app status bar. */
  onQueryStatus?: (text: string, target: string) => void
  /** Report the active connection tab's resolved target (for the status bar). */
  onTargetChange?: (target: QueryTarget | null) => void
  /** Attach a context chip (editor selection, result data) to the AI thread. */
  onAddAgentContext?: (item: AgentEditorSelectionItem | AgentResultItem) => void
  /** Attach result context AND pre-fill the agent composer (Fix with AI). */
  onAskAgent?: (prompt: string, item: AgentResultItem) => void
}

/** An agent-proposed replacement for one file's contents, awaiting review. */
interface EditorProposal {
  fileId: string
  sql: string
}

/** Open files bucketed by (connection, database) — one top-tier tab each. */
interface FileGroup {
  key: string
  connId: string
  database: string | null
  files: QueryFile[]
  previews: ResultTab[]
}

interface TabMenu {
  fileId: string
  x: number
  y: number
}

interface PendingClose {
  label: string
  fileIds: string[]
  resultTabIds: string[]
  dirtyFiles: QueryFile[]
  groupKey: string | null
}

function groupKeyOf(connId: string, database: string | null): string {
  return `${connId ?? ''}\u0000${database ?? ''}`
}

/**
 * The (connection, database) a group's queries run against. Groups made at
 * connection level (no database) fall back to that connection's primary
 * database; with no group open at all, to the app's primary target.
 */
function resolveTarget(
  group: FileGroup | null,
  targets: QueryTarget[]
): QueryTarget | null {
  const fallback = targets.find((t) => t.primary) ?? targets[0] ?? null
  if (!group) return fallback
  const conn = targets.filter((t) => t.connId === group.connId)
  if (conn.length === 0) return null // connection offline
  if (group.database) {
    return conn.find((t) => t.database === group.database) ?? null
  }
  return conn.find((t) => t.primary) ?? conn[0]
}

/** Fixed-position style dropping a menu below its button, right-aligned. */
function menuPosition(button: HTMLButtonElement): {
  top: number
  right: number
} {
  const rect = button.getBoundingClientRect()
  return { top: rect.bottom + 6, right: window.innerWidth - rect.right }
}

export function EditorPanel({
  theme,
  targets,
  connNames,
  schemas,
  ensureSchema,
  files,
  runner,
  bridge,
  onQueryStatus,
  onTargetChange,
  onAddAgentContext,
  onAskAgent
}: EditorPanelProps): ReactElement {
  const [limit, setLimit] = useState<number | null>(DEFAULT_LIMIT)
  const [resultsPct, setResultsPct] = useState(50)
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set())
  const [actionsOpen, setActionsOpen] = useState(false)
  const [newFileMenuOpen, setNewFileMenuOpen] = useState(false)
  const [previewingFileId, setPreviewingFileId] = useState<string | null>(null)
  const [, setBufferRevision] = useState(0)
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null)
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [savingBeforeClose, setSavingBeforeClose] = useState(false)
  /** Captured SQL for the "Save as exemplar" dialog; null = closed. */
  const [exemplarSql, setExemplarSql] = useState<string | null>(null)
  /** Agent-proposed buffer replacement awaiting Accept/Reject; null = none. */
  const [proposal, setProposal] = useState<EditorProposal | null>(null)
  /** SQL to apply to the next freshly-loaded file (created for a proposal). */
  const pendingApplyRef = useRef<string | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const actionsBtnRef = useRef<HTMLButtonElement | null>(null)
  const newFileBtnRef = useRef<HTMLButtonElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const cancelRenameRef = useRef(false)

  // Per-file buffers so switching tabs preserves unsaved edits.
  const buffersRef = useRef(new Map<string, string>())
  const activeFileIdRef = useRef<string | null>(null)
  activeFileIdRef.current = files.selectedFileId
  // Distinguishes programmatic setValue (tab switch) from user typing.
  const suppressChangeRef = useRef(false)

  const groups = useMemo(() => {
    const map = new Map<string, FileGroup>()
    for (const file of files.files) {
      if (!files.openFileIds.has(file.id)) continue
      // Legacy connection-less files are re-homed on load (App.adoptOrphans);
      // until that lands they get no tab of their own.
      if (!file.connId) continue
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
  }, [files.files, files.openFileIds, runner.tabs])

  const activeResultTab =
    runner.tabs.find((tab) => tab.id === runner.activeTabId) ?? null
  const activePreview =
    activeResultTab?.source === 'preview' ? activeResultTab : null
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

  const target = resolveTarget(activeGroup, targets)
  const activeFile = files.selectedFileId
    ? files.files.find((f) => f.id === files.selectedFileId)
    : null
  const activeFileKind = fileKindFromName(activeFile?.name ?? 'query.sql')
  const activeLanguage = monacoLanguageForFile(activeFile?.name ?? 'query.sql')
  const isSqlFile = activeFileKind === 'sql'
  const canPreview = !!activeFile && isPreviewableFile(activeFile.name)
  const isFilePreview = canPreview && previewingFileId === files.selectedFileId
  const activeContent = activeFile
    ? (buffersRef.current.get(activeFile.id) ?? '')
    : ''

  /** Display name for a group's connection tab. */
  const groupName = useCallback(
    (group: FileGroup): string => connNames[group.connId] ?? group.connId,
    [connNames]
  )

  const queryTabs = runner.tabs.filter((tab) => tab.source !== 'preview')

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
    [files.selectFile, leavePreview]
  )

  // Switching back to a connection tab restores the file that was open there.
  const lastFileByGroup = useRef(new Map<string, string>())
  useEffect(() => {
    if (files.selectedFileId && activeGroup) {
      lastFileByGroup.current.set(activeGroup.key, files.selectedFileId)
    }
  }, [files.selectedFileId, activeGroup])

  const selectGroup = useCallback(
    (group: FileGroup) => {
      const remembered = lastFileByGroup.current.get(group.key)
      const file =
        group.files.find((f) => f.id === remembered) ?? group.files[0]
      if (file) {
        selectFile(file.id)
      } else if (group.previews[0]) {
        runner.setActiveTab(group.previews[0].id)
      }
    },
    [selectFile, runner]
  )

  /** Connection id → tab dot color, assigned in connection (tree) order. */
  const connColors = useMemo(() => {
    const out = new Map<string, string>()
    for (const t of targets) {
      if (!out.has(t.connId)) {
        out.set(t.connId, CONN_COLORS[out.size % CONN_COLORS.length])
      }
    }
    return out
  }, [targets])

  useEffect(() => {
    onTargetChange?.(activePreview?.target ?? target)
  }, [activePreview?.target, target, onTargetChange])
  // The panel never unmounts in practice, but don't leave a stale target up.
  useEffect(() => () => onTargetChange?.(null), [onTargetChange])

  const activeFileNameRef = useRef<string | null>(null)
  activeFileNameRef.current = activeFile?.name ?? null
  const activeIsSqlRef = useRef(true)
  activeIsSqlRef.current = isSqlFile

  // Where proposeSql creates a query file when no SQL tab is open: the active
  // group's home, else the app's primary target. Null with no connection.
  const proposalHomeRef = useRef<{
    connId: string
    database: string | null
  } | null>(null)
  proposalHomeRef.current = activeGroup
    ? { connId: activeGroup.connId, database: activeGroup.database }
    : target
      ? { connId: target.connId, database: target.database }
      : null
  const createFileRef = useRef(files.createFile)
  createFileRef.current = files.createFile

  /**
   * Replace one file's contents with agent-proposed SQL. Routed through
   * executeEdits when that file is live in Monaco — undo-friendly, and the
   * change listener marks it dirty — else written straight to its buffer
   * (the editor may be unmounted behind a data preview).
   */
  const applyProposal = useCallback((fileId: string, text: string) => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (
      activeFileIdRef.current === fileId &&
      ed &&
      model &&
      !model.isDisposed()
    ) {
      ed.executeEdits('ai-agent', [
        { range: model.getFullModelRange(), text, forceMoveMarkers: true }
      ])
      ed.focus()
      return
    }
    buffersRef.current.set(fileId, text)
    setDirtyIds((prev) => (prev.has(fileId) ? prev : new Set(prev).add(fileId)))
    setBufferRevision((revision) => revision + 1)
  }, [])

  // Everything is read through refs at call time, so registering once is safe
  // (applyProposal is stable).
  useEffect(() => {
    bridge.current = {
      getActiveSql: () => ({
        fileName: activeIsSqlRef.current ? activeFileNameRef.current : null,
        sql: activeIsSqlRef.current ? (editorRef.current?.getValue() ?? '') : ''
      }),
      getSelection: () => {
        if (!activeIsSqlRef.current) return null
        const ed = editorRef.current
        const model = ed?.getModel()
        const selection = ed?.getSelection()
        if (!model || model.isDisposed() || !selection || selection.isEmpty()) {
          return null
        }
        return {
          fileName: activeFileNameRef.current,
          sql: model.getValueInRange(selection),
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber
        }
      },
      insertSql: (sql: string) => {
        if (!activeIsSqlRef.current) return
        const ed = editorRef.current
        const model = ed?.getModel()
        if (!ed || !model) return
        const selection = ed.getSelection()
        const end = model.getFullModelRange()
        const range = selection ?? {
          startLineNumber: end.endLineNumber,
          startColumn: end.endColumn,
          endLineNumber: end.endLineNumber,
          endColumn: end.endColumn
        }
        const text = sql.endsWith('\n') ? sql : `${sql}\n`
        ed.executeEdits('ai-agent', [{ range, text, forceMoveMarkers: true }])
        ed.focus()
      },
      proposeSql: (sql: string) => {
        const text = sql.endsWith('\n') ? sql : `${sql}\n`
        const fileId = activeFileIdRef.current
        if (activeIsSqlRef.current && fileId) {
          const current = buffersRef.current.get(fileId) ?? ''
          if (!current.trim()) {
            applyProposal(fileId, text)
            return 'applied'
          }
          setProposal({ fileId, sql: text })
          return 'pending'
        }
        // No SQL tab to write into: create a fresh query file on the active
        // connection and land the SQL there once its buffer loads.
        const home = proposalHomeRef.current
        if (!home) return 'unavailable'
        pendingApplyRef.current = text
        createFileRef.current(home.connId, home.database)
        return 'applied'
      }
    }
    return () => {
      bridge.current = null
    }
  }, [bridge, applyProposal])

  const setEditorValue = useCallback((value: string) => {
    const ed = editorRef.current
    if (!ed || ed.getValue() === value) return
    suppressChangeRef.current = true
    ed.setValue(value)
    suppressChangeRef.current = false
  }, [])

  // Swap the editor buffer when the selected file changes.
  useEffect(() => {
    const id = files.selectedFileId
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
    void window.dbDesk.files.read(id).then((content) => {
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
  }, [files.selectedFileId, setEditorValue])

  useEffect(() => {
    if (!actionsOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setActionsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actionsOpen])

  useEffect(() => {
    if (!newFileMenuOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setNewFileMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newFileMenuOpen])

  useEffect(() => {
    if (!tabMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTabMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabMenu])

  useEffect(() => {
    if (!pendingClose || savingBeforeClose) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPendingClose(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingClose, savingBeforeClose])

  useEffect(() => {
    const input = renameInputRef.current
    if (!renamingFileId || !input) return
    input.focus()
    const extensionStart = supportedExtension(input.value)
      ? input.value.length - supportedExtension(input.value)!.length
      : input.value.length
    input.setSelectionRange(0, extensionStart)
  }, [renamingFileId])

  // Completion reads the active target's schema through this ref so the
  // provider (registered once) always sees the latest introspection.
  const activeSchema =
    target && isSqlFile
      ? (schemas[target.connId]?.[target.database] ?? null)
      : null
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

  const saveFileById = useCallback(
    async (id: string | null): Promise<boolean> => {
      if (!id) return false
      const content = buffersRef.current.get(id)
      if (content === undefined) return false
      const saved = await files.saveFile(id, content)
      if (!saved) return false
      setDirtyIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      return true
    },
    [files.saveFile]
  )

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
  }, [onAddAgentContext])
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
  }, [onAddAgentContext])
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

  const handleMount = useCallback<OnMount>((ed, monaco) => {
    editorRef.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      runRef.current()
    )
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current()
    )
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
  }, [])

  const finishClose = useCallback(
    (closing: PendingClose) => {
      for (const id of closing.fileIds) buffersRef.current.delete(id)
      setDirtyIds((prev) => {
        const next = new Set(prev)
        for (const id of closing.fileIds) next.delete(id)
        return next
      })
      // A pending proposal for a closing file has nothing left to apply to.
      setProposal((prev) =>
        prev && closing.fileIds.includes(prev.fileId) ? null : prev
      )
      files.closeFiles(closing.fileIds)
      runner.closeTabs(closing.resultTabIds)
      if (closing.groupKey) lastFileByGroup.current.delete(closing.groupKey)
      setTabMenu((menu) =>
        menu && closing.fileIds.includes(menu.fileId) ? null : menu
      )
      setPendingClose(null)
    },
    [files.closeFiles, runner]
  )

  const requestClose = useCallback(
    (
      fileIds: string[],
      resultTabIds: string[],
      label: string,
      groupKey: string | null = null
    ) => {
      const closingIds = new Set(fileIds)
      const dirtyFiles = files.files.filter(
        (file) => closingIds.has(file.id) && dirtyIds.has(file.id)
      )
      const closing = {
        label,
        fileIds,
        resultTabIds,
        dirtyFiles,
        groupKey
      }
      if (dirtyFiles.length === 0) finishClose(closing)
      else setPendingClose(closing)
    },
    [dirtyIds, files.files, finishClose]
  )

  const closeFile = useCallback(
    (file: QueryFile) => requestClose([file.id], [], file.name),
    [requestClose]
  )

  const closeGroup = useCallback(
    (group: FileGroup) => {
      const groupTarget = resolveTarget(group, targets)
      const resultTabIds = runner.tabs
        .filter(
          (tab) =>
            groupTarget !== null &&
            tab.target.connId === group.connId &&
            tab.target.database === groupTarget.database
        )
        .map((tab) => tab.id)
      requestClose(
        group.files.map((file) => file.id),
        resultTabIds,
        `${groupName(group)}${groupTarget ? ` / ${groupTarget.database}` : ''}`,
        group.key
      )
    },
    [groupName, requestClose, runner.tabs, targets]
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
  }, [files.renameFile, renameDraft, renamingFileId])

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
    [
      activeGroup?.connId,
      activeGroup?.database,
      target?.connId,
      target?.database,
      files.createFile,
      leavePreview
    ]
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
    proposal !== null &&
    !activePreview &&
    isSqlFile &&
    files.selectedFileId === proposal.fileId

  useEffect(() => {
    if (!showProposal) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') rejectProposal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showProposal, rejectProposal])

  // The DiffEditor wrapper disposes its TextModels before the widget resets
  // them, which throws on unmount. keepCurrent*Model makes the wrapper leave
  // the models alone; we capture them at mount and dispose them ourselves
  // once the overlay is gone.
  const diffModelsRef = useRef<editor.ITextModel[]>([])
  const handleDiffMount = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor): void => {
      const m = diffEditor.getModel()
      diffModelsRef.current = m ? [m.original, m.modified] : []
    },
    []
  )
  useEffect(() => {
    if (showProposal) return
    const models = diffModelsRef.current
    diffModelsRef.current = []
    for (const model of models) {
      if (!model.isDisposed()) model.dispose()
    }
  }, [showProposal])
  // Component teardown: release whatever the overlay still holds.
  useEffect(
    () => () => {
      for (const model of diffModelsRef.current) {
        if (!model.isDisposed()) model.dispose()
      }
    },
    []
  )

  const activeTabHint = activeGroup
    ? `${activeGroup.files.length + activeGroup.previews.length} open · ${groupName(activeGroup)}${
        target && activeGroup.connId ? ` / ${target.database}` : ''
      }`
    : ''

  /** Nothing open: show the default screen instead of a blank Monaco surface. */
  const isEmpty = groups.length === 0
  const closedFiles = useMemo(
    () =>
      isEmpty ? files.files.filter((f) => !files.openFileIds.has(f.id)) : [],
    [isEmpty, files.files, files.openFileIds]
  )

  return (
    <section className="editor-panel">
      <div className="editor-tabbar">
        <div
          className="editor-tabbar__tabs"
          role="tablist"
          aria-label="Query connections"
        >
          {groups.map((group) => {
            const isActive = group.key === activeGroup?.key
            const groupTarget = resolveTarget(group, targets)
            const color = connColors.get(group.connId) ?? 'var(--text-faint)'
            return (
              <div
                key={group.key}
                className={`conn-tab${isActive ? ' is-active' : ''}`}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={
                  groupTarget
                    ? `${groupName(group)} / ${groupTarget.database}`
                    : `${groupName(group)} (offline)`
                }
                onClick={() => selectGroup(group)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  selectGroup(group)
                }}
              >
                <span
                  className="conn-tab__dot"
                  style={{ background: color }}
                  aria-hidden
                />
                <span className="conn-tab__icon">
                  <DatabaseIcon size={13} />
                </span>
                <span className="conn-tab__name">{groupName(group)}</span>
                {group.database && (
                  <>
                    <span className="conn-tab__sep">/</span>
                    <span className="conn-tab__db">{group.database}</span>
                  </>
                )}
                <span className="conn-tab__count">
                  {group.files.length + group.previews.length}
                </span>
                <button
                  className="conn-tab__close"
                  type="button"
                  title={`Close ${groupName(group)}${groupTarget ? ` / ${groupTarget.database}` : ''}`}
                  aria-label={`Close ${groupName(group)}${groupTarget ? ` / ${groupTarget.database}` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeGroup(group)
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <CloseIcon />
                </button>
              </div>
            )
          })}
        </div>
        {!activePreview && (
          <>
            {isSqlFile ? (
              <button
                className="btn-run btn-run--bar"
                type="button"
                disabled={!target}
                title={
                  target
                    ? `Run statement at cursor (⌘⏎) — ${target.connName} / ${target.database}`
                    : 'Connect to a database to run queries'
                }
                onClick={runCurrent}
              >
                <PlayIcon />
                Run
                <span className="btn-run__kbd">⌘⏎</span>
              </button>
            ) : (
              <div className="editor-view-toggle" aria-label="File view">
                <button
                  className={!isFilePreview ? 'is-active' : ''}
                  type="button"
                  aria-pressed={!isFilePreview}
                  onClick={() => setPreviewingFileId(null)}
                >
                  Edit
                </button>
                <button
                  className={isFilePreview ? 'is-active' : ''}
                  type="button"
                  aria-pressed={isFilePreview}
                  onClick={() => setPreviewingFileId(activeFile?.id ?? null)}
                >
                  <EyeIcon size={13} />
                  Preview
                </button>
              </div>
            )}
            <button
              ref={actionsBtnRef}
              className={`btn-kebab${actionsOpen ? ' is-open' : ''}`}
              type="button"
              title="More actions"
              onClick={() => {
                setNewFileMenuOpen(false)
                setActionsOpen((open) => !open)
              }}
            >
              <KebabIcon />
            </button>
          </>
        )}
      </div>
      <div className="file-tabbar">
        {(activeGroup?.files ?? []).map((file) => (
          <div
            key={file.id}
            className={`editor-tab${!activePreview && files.selectedFileId === file.id ? ' is-active' : ''}`}
            onClick={() => selectFile(file.id)}
            onContextMenu={(event) => openTabMenu(event, file)}
            title={`${file.name} · ${file.connId ?? 'no connection'}/${file.database || '(connection level)'}`}
          >
            <SqlFileIcon />
            {renamingFileId === file.id ? (
              <input
                ref={renameInputRef}
                className="editor-tab__rename"
                value={renameDraft}
                aria-label={`Rename ${file.name}`}
                onChange={(event) => setRenameDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelRenameRef.current = true
                    setRenamingFileId(null)
                  }
                }}
              />
            ) : (
              file.name
            )}
            {dirtyIds.has(file.id) && (
              <span className="editor-tab__dot" title="Unsaved changes" />
            )}
            <button
              className="editor-tab__close"
              onClick={(e) => {
                e.stopPropagation()
                closeFile(file)
              }}
              title="Close tab"
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        {(activeGroup?.previews ?? []).map((tab) => (
          <div
            key={tab.id}
            className={`editor-tab${activePreview?.id === tab.id ? ' is-active' : ''}`}
            onClick={() => runner.setActiveTab(tab.id)}
            title={`${tab.title} · ${tab.target.connName}/${tab.target.database}`}
            role="tab"
            aria-selected={activePreview?.id === tab.id}
          >
            <DatabaseIcon size={13} />
            {tab.title}
            {tab.running && <span className="spinner spinner--xs" />}
            <button
              className="editor-tab__close"
              onClick={(event) => {
                event.stopPropagation()
                runner.closeTab(tab.id)
              }}
              title="Close data preview"
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <button
          ref={newFileBtnRef}
          className="icon-btn icon-btn--sm editor-tabbar__new"
          title={
            activeGroup || target
              ? 'New file'
              : 'Connect to a database to add a file'
          }
          aria-label="New file"
          aria-expanded={newFileMenuOpen}
          disabled={!activeGroup && !target}
          type="button"
          onClick={() => {
            setActionsOpen(false)
            setNewFileMenuOpen((open) => !open)
          }}
        >
          <PlusThinIcon />
        </button>
        <div className="editor-tabbar__spacer" />
        {activeTabHint && (
          <span className="file-tabbar__hint">{activeTabHint}</span>
        )}
      </div>
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
      {pendingClose && (
        <div className="dialog-overlay">
          <div
            className="dialog close-queries-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Save query changes"
          >
            <div className="dialog__header">
              <span className="dialog__icon">
                <SaveIcon />
              </span>
              <div className="dialog__titles">
                <div className="dialog__title">Save changes?</div>
                <div className="dialog__subtitle">{pendingClose.label}</div>
              </div>
            </div>
            <div className="dialog__body close-queries-dialog__body">
              {pendingClose.dirtyFiles.length === 1 ? (
                <p>
                  <strong>{pendingClose.dirtyFiles[0].name}</strong> has unsaved
                  changes. Save them before closing?
                </p>
              ) : (
                <>
                  <p>
                    {pendingClose.dirtyFiles.length} query tabs have unsaved
                    changes. Save them before closing?
                  </p>
                  <ul className="close-queries-dialog__files">
                    {pendingClose.dirtyFiles.map((file) => (
                      <li key={file.id}>{file.name}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className="dialog__footer">
              <button
                className="btn-cancel close-queries-dialog__discard"
                type="button"
                disabled={savingBeforeClose}
                onClick={() => finishClose(pendingClose)}
              >
                Don’t Save
              </button>
              <div className="test-msg" />
              <button
                className="btn-cancel"
                type="button"
                disabled={savingBeforeClose}
                onClick={() => setPendingClose(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                autoFocus
                disabled={savingBeforeClose}
                onClick={() => void saveAndClose()}
              >
                {savingBeforeClose && <span className="spinner" />}
                {savingBeforeClose
                  ? 'Saving…'
                  : pendingClose.dirtyFiles.length === 1
                    ? 'Save'
                    : 'Save All'}
              </button>
            </div>
          </div>
        </div>
      )}
      {tabMenu && (
        <div
          className="ctx-overlay"
          onMouseDown={() => setTabMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setTabMenu(null)
          }}
        >
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="ctx-menu__item"
              type="button"
              role="menuitem"
              onClick={() => {
                const file = files.files.find(
                  (candidate) => candidate.id === tabMenu.fileId
                )
                if (file) startRename(file)
              }}
            >
              Rename…
            </button>
          </div>
        </div>
      )}
      {newFileMenuOpen && newFileBtnRef.current && (
        <>
          <div
            className="ctx-overlay"
            onClick={() => setNewFileMenuOpen(false)}
          />
          <div
            className="ctx-menu new-file-menu"
            style={menuPosition(newFileBtnRef.current)}
            role="menu"
            aria-label="New file type"
          >
            {(
              [
                ['sql', 'SQL file', '.sql'],
                ['markdown', 'Markdown file', '.md'],
                ['json', 'JSON file', '.json'],
                ['text', 'Text file', '.txt']
              ] as const
            ).map(([kind, label, extension]) => (
              <button
                key={kind}
                className="ctx-menu__item new-file-menu__item"
                type="button"
                role="menuitem"
                onClick={() => createFile(kind)}
              >
                <SqlFileIcon size={13} />
                <span>{label}</span>
                <span className="new-file-menu__extension">{extension}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {!activePreview && actionsOpen && actionsBtnRef.current && (
        <>
          <div className="ctx-overlay" onClick={() => setActionsOpen(false)} />
          <div
            className="ctx-menu toolbar-menu"
            style={menuPosition(actionsBtnRef.current)}
            role="menu"
          >
            {isSqlFile && (
              <button
                className="toolbar-menu__item"
                type="button"
                role="menuitem"
                onClick={() => setActionsOpen(false)}
              >
                <FormatIcon />
                <span>Format SQL</span>
                <span className="toolbar-menu__kbd">⇧⌘F</span>
              </button>
            )}
            <button
              className="toolbar-menu__item"
              type="button"
              role="menuitem"
              disabled={
                !files.selectedFileId || !dirtyIds.has(files.selectedFileId)
              }
              onClick={() => {
                saveFileById(files.selectedFileId)
                setActionsOpen(false)
              }}
            >
              <SaveIcon />
              <span>Save file</span>
              <span className="toolbar-menu__kbd">⌘S</span>
            </button>
            {isSqlFile && (
              <button
                className="toolbar-menu__item"
                type="button"
                role="menuitem"
                disabled={!target}
                title={
                  target
                    ? 'Save the current query as a reusable exemplar'
                    : 'Connect to a database to save an exemplar'
                }
                onClick={() => {
                  setActionsOpen(false)
                  openExemplar()
                }}
              >
                <SparkleIcon />
                <span>Save as exemplar…</span>
              </button>
            )}
          </div>
        </>
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
            <SqlEditor
              theme={theme}
              language={activeLanguage}
              onMount={handleMount}
            />
            {isFilePreview && activeFileKind !== 'sql' && (
              <FilePreview kind={activeFileKind} content={activeContent} />
            )}
            {showProposal && proposal && (
              <div className="editor-proposal">
                <div className="editor-proposal__bar">
                  <SparkleIcon size={13} />
                  <span className="editor-proposal__title">
                    AI proposed changes
                    {activeFile ? ` — ${activeFile.name}` : ''}
                  </span>
                  <span className="editor-proposal__spacer" />
                  <button
                    className="btn-cancel"
                    type="button"
                    title="Keep the file as it is (Esc)"
                    onClick={rejectProposal}
                  >
                    Reject
                  </button>
                  <button
                    className="btn-primary"
                    type="button"
                    autoFocus
                    title="Replace the file contents with the proposal (undo with ⌘Z)"
                    onClick={acceptProposal}
                  >
                    Accept
                  </button>
                </div>
                <div className="editor-proposal__diff">
                  <DiffEditor
                    beforeMount={defineThemes}
                    onMount={handleDiffMount}
                    original={activeContent}
                    modified={proposal.sql}
                    language="sql"
                    theme={resolveTheme(theme)}
                    height="100%"
                    options={PROPOSAL_DIFF_OPTIONS}
                    keepCurrentOriginalModel
                    keepCurrentModifiedModel
                  />
                </div>
              </div>
            )}
            {isEmpty && (
              <div className="editor-empty">
                <div className="empty-state">
                  <div className="empty-state__icon">
                    <SqlDocIcon size={34} />
                  </div>
                  <div className="empty-state__title">No file open</div>
                  <div className="empty-state__text">
                    {target
                      ? `Start a new query against ${target.connName} / ${target.database}, or reopen a saved one.`
                      : 'Connect to a PostgreSQL database, then open a query to start writing SQL.'}
                  </div>
                  <button
                    className="btn-primary"
                    type="button"
                    disabled={!target}
                    title={
                      target ? undefined : 'Connect to a database to add a query'
                    }
                    onClick={() => {
                      if (!target) return
                      files.createFile(target.connId, target.database)
                    }}
                  >
                    <PlusThinIcon />
                    New Query
                  </button>
                  {closedFiles.length > 0 && (
                    <div className="editor-empty__recent">
                      <div className="editor-empty__recent-title">
                        Saved files
                      </div>
                      {closedFiles.map((file) => {
                        // Names are only unique per (connection, database), so
                        // the origin is what disambiguates rows here.
                        const origin = file.connId
                          ? `${connNames[file.connId] ?? file.connId}${
                              file.database ? ` / ${file.database}` : ''
                            }`
                          : ''
                        return (
                          <button
                            key={file.id}
                            className="editor-empty__file"
                            type="button"
                            title={`Open ${file.name} — ${origin}`}
                            onClick={() => selectFile(file.id)}
                          >
                            <SqlFileIcon size={13} />
                            <span className="editor-empty__file-name">
                              {file.name}
                            </span>
                            <span className="editor-empty__file-origin">
                              {origin}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {isSqlFile && queryTabs.length > 0 && (
            <>
              <div
                className="split-divider"
                onPointerDown={startResize}
                role="separator"
              />
              <div
                className="results-host"
                style={{ flex: `0 0 ${resultsPct}%` }}
              >
                <ResultsPanel
                  tabs={queryTabs}
                  activeTabId={runner.activeTabId}
                  limit={limit}
                  onLimitChange={setLimit}
                  onSelect={runner.setActiveTab}
                  onClose={runner.closeTab}
                  onCloseMany={runner.closeTabs}
                  onCloseAll={() =>
                    runner.closeTabs(queryTabs.map((tab) => tab.id))
                  }
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
