import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'

import type { DatabaseIntrospection } from '../../../shared/db'
import { statementAtOffset } from '../../../shared/sql'
import { ensureSqlLanguageFeatures } from '../sql/completions'
import type { Theme } from '../theme'
import {
  DatabaseIcon,
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
import { SaveExemplarDialog } from './SaveExemplarDialog'
import { SqlEditor } from './SqlEditor'
import type { QueryRunner, QueryTarget } from './useQueryRunner'
import type { ResultTab } from './useQueryRunner'
import type { EditorBridge } from './editorBridge'
import type { FileState, QueryFile } from '../files/useFileState'

const DEFAULT_LIMIT = 500

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
}

/** Open files bucketed by (connection, database) — one top-tier tab each. */
interface FileGroup {
  key: string
  connId: string | null
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

function groupKeyOf(connId: string | null, database: string | null): string {
  return `${connId ?? ''}\u0000${database ?? ''}`
}

/**
 * The (connection, database) a group's queries run against. Groups made at
 * connection level (no database) and scratch files (no connection) fall back
 * to the connection's — or the app's — primary target.
 */
function resolveTarget(
  group: FileGroup | null,
  targets: QueryTarget[]
): QueryTarget | null {
  const fallback = targets.find((t) => t.primary) ?? targets[0] ?? null
  if (!group || !group.connId) return fallback
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
  onTargetChange
}: EditorPanelProps): ReactElement {
  const [limit, setLimit] = useState<number | null>(DEFAULT_LIMIT)
  const [resultsPct, setResultsPct] = useState(50)
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set())
  const [actionsOpen, setActionsOpen] = useState(false)
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null)
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [savingBeforeClose, setSavingBeforeClose] = useState(false)
  /** Captured SQL for the "Save as exemplar" dialog; null = closed. */
  const [exemplarSql, setExemplarSql] = useState<string | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const actionsBtnRef = useRef<HTMLButtonElement | null>(null)
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

  /** Display name for a group's connection tab. */
  const groupName = useCallback(
    (group: FileGroup): string =>
      group.connId ? (connNames[group.connId] ?? group.connId) : 'Scratch',
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

  // Everything is read through refs at call time, so registering once is safe.
  useEffect(() => {
    bridge.current = {
      getActiveSql: () => ({
        fileName: activeFileNameRef.current,
        sql: editorRef.current?.getValue() ?? ''
      }),
      insertSql: (sql: string) => {
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
      }
    }
    return () => {
      bridge.current = null
    }
  }, [bridge])

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
      buffersRef.current.set(id, content)
      if (activeFileIdRef.current === id) setEditorValue(content)
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
    const extensionStart = input.value.toLocaleLowerCase().endsWith('.sql')
      ? input.value.length - 4
      : input.value.length
    input.setSelectionRange(0, extensionStart)
  }, [renamingFileId])

  // Completion reads the active target's schema through this ref so the
  // provider (registered once) always sees the latest introspection.
  const activeSchema = target
    ? (schemas[target.connId]?.[target.database] ?? null)
    : null
  const schemaRef = useRef<DatabaseIntrospection | null>(null)
  schemaRef.current = activeSchema

  // Databases a tab points at may not have been expanded in the tree yet;
  // introspect them so completions have something to offer.
  useEffect(() => {
    if (target) ensureSchema(target.connId, target.database)
  }, [target, ensureSchema])

  const runCurrent = useCallback(() => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model || !target) return
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
  }, [target, limit, runner])

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

  const handleMount = useCallback<OnMount>((ed, monaco) => {
    editorRef.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      runRef.current()
    )
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current()
    )
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
            group.connId !== null &&
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
            const color = group.connId
              ? (connColors.get(group.connId) ?? 'var(--text-faint)')
              : 'var(--text-faint)'
            return (
              <div
                key={group.key}
                className={`conn-tab${isActive ? ' is-active' : ''}`}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={
                  group.connId
                    ? groupTarget
                      ? `${groupName(group)} / ${groupTarget.database}`
                      : `${groupName(group)} (offline)`
                    : 'Files not tied to a connection'
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
            <button
              ref={actionsBtnRef}
              className={`btn-kebab${actionsOpen ? ' is-open' : ''}`}
              type="button"
              title="More actions"
              onClick={() => setActionsOpen((open) => !open)}
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
          className="icon-btn icon-btn--sm editor-tabbar__new"
          title={
            activeGroup?.connId
              ? `New query on ${groupName(activeGroup)}`
              : 'New query'
          }
          type="button"
          onClick={() => {
            files.createFile(
              activeGroup?.connId ?? null,
              activeGroup?.database ?? null
            )
            leavePreview()
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
      {!activePreview && actionsOpen && actionsBtnRef.current && (
        <>
          <div className="ctx-overlay" onClick={() => setActionsOpen(false)} />
          <div
            className="ctx-menu toolbar-menu"
            style={menuPosition(actionsBtnRef.current)}
            role="menu"
          >
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
        />
      ) : (
        <div className="editor-split" ref={splitRef}>
          <div className="editor-host">
            <SqlEditor theme={theme} onMount={handleMount} />
            {isEmpty && (
              <div className="editor-empty">
                <div className="empty-state">
                  <div className="empty-state__icon">
                    <SqlDocIcon size={34} />
                  </div>
                  <div className="empty-state__title">No query open</div>
                  <div className="empty-state__text">
                    {target
                      ? `Start a new query against ${target.connName} / ${target.database}, or reopen a saved one.`
                      : 'Connect to a PostgreSQL database, then open a query to start writing SQL.'}
                  </div>
                  <button
                    className="btn-primary"
                    type="button"
                    onClick={() =>
                      files.createFile(
                        target?.connId ?? null,
                        target?.database ?? null
                      )
                    }
                  >
                    <PlusThinIcon />
                    New Query
                  </button>
                  {closedFiles.length > 0 && (
                    <div className="editor-empty__recent">
                      <div className="editor-empty__recent-title">
                        Saved queries
                      </div>
                      {closedFiles.map((file) => {
                        // Names are only unique per (connection, database), so
                        // the origin is what disambiguates rows here.
                        const origin = file.connId
                          ? `${connNames[file.connId] ?? file.connId}${
                              file.database ? ` / ${file.database}` : ''
                            }`
                          : 'Scratch'
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
          {queryTabs.length > 0 && (
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
                />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
