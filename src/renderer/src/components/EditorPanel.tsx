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
  SqlFileIcon,
  CloseIcon
} from './icons'
import { ResultsPanel } from './ResultsPanel'
import { SaveExemplarDialog } from './SaveExemplarDialog'
import { SqlEditor } from './SqlEditor'
import type { QueryRunner, QueryTarget } from './useQueryRunner'
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
}

interface TabMenu {
  fileId: string
  x: number
  y: number
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
      const key = groupKeyOf(file.connId, file.database)
      let group = map.get(key)
      if (!group) {
        group = { key, connId: file.connId, database: file.database, files: [] }
        map.set(key, group)
      }
      group.files.push(file)
    }
    return [...map.values()]
  }, [files.files])

  const activeGroup =
    (files.selectedFileId
      ? groups.find((g) => g.files.some((f) => f.id === files.selectedFileId))
      : null) ??
    groups[0] ??
    null

  const target = resolveTarget(activeGroup, targets)
  const activeFile = files.selectedFileId
    ? files.files.find((f) => f.id === files.selectedFileId)
    : null

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
      const file = group.files.find((f) => f.id === remembered) ?? group.files[0]
      if (file) files.selectFile(file.id)
    },
    [files.selectFile]
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
    onTargetChange?.(target)
  }, [target, onTargetChange])
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
    if (!id) return
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
    (id: string | null) => {
      if (!id) return
      const content = buffersRef.current.get(id)
      if (content === undefined) return
      files.saveFile(id, content)
      setDirtyIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [files.saveFile]
  )

  // Cmd+S is registered once on mount; route it through a ref so it always
  // saves the currently selected file.
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => {
    saveRef.current = () => saveFileById(activeFileIdRef.current)
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

  const closeFile = useCallback(
    (id: string) => {
      buffersRef.current.delete(id)
      setDirtyIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      files.deleteFile(id)
    },
    [files.deleteFile]
  )

  const openTabMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, file: QueryFile) => {
      event.preventDefault()
      files.selectFile(file.id)
      setTabMenu({ fileId: file.id, x: event.clientX, y: event.clientY })
    },
    [files.selectFile]
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

  /** Display name for a group's connection tab. */
  const groupName = (group: FileGroup): string =>
    group.connId ? (connNames[group.connId] ?? group.connId) : 'Scratch'

  const activeTabHint = activeGroup
    ? `${activeGroup.files.length} open · ${groupName(activeGroup)}${
        target && activeGroup.connId ? ` / ${target.database}` : ''
      }`
    : ''

  return (
    <section className="editor-panel">
      <div className="editor-tabbar">
        <div className="editor-tabbar__tabs">
          {groups.map((group) => {
            const isActive = group.key === activeGroup?.key
            const groupTarget = resolveTarget(group, targets)
            const color = group.connId
              ? (connColors.get(group.connId) ?? 'var(--text-faint)')
              : 'var(--text-faint)'
            return (
              <button
                key={group.key}
                type="button"
                className={`conn-tab${isActive ? ' is-active' : ''}`}
                title={
                  group.connId
                    ? groupTarget
                      ? `${groupName(group)} / ${groupTarget.database}`
                      : `${groupName(group)} (offline)`
                    : 'Files not tied to a connection'
                }
                onClick={() => selectGroup(group)}
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
                <span className="conn-tab__count">{group.files.length}</span>
              </button>
            )
          })}
        </div>
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
      </div>
      <div className="file-tabbar">
        {(activeGroup?.files ?? []).map((file) => (
          <div
            key={file.id}
            className={`editor-tab${files.selectedFileId === file.id ? ' is-active' : ''}`}
            onClick={() => files.selectFile(file.id)}
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
                closeFile(file.id)
              }}
              title="Close tab"
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
          onClick={() =>
            files.createFile(
              activeGroup?.connId ?? null,
              activeGroup?.database ?? null
            )
          }
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
      {actionsOpen && actionsBtnRef.current && (
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
      <div className="editor-split" ref={splitRef}>
        <div className="editor-host">
          <SqlEditor theme={theme} onMount={handleMount} />
        </div>
        {runner.tabs.length > 0 && (
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
                tabs={runner.tabs}
                activeTabId={runner.activeTabId}
                limit={limit}
                onLimitChange={setLimit}
                onSelect={runner.setActiveTab}
                onClose={runner.closeTab}
                onCloseMany={runner.closeTabs}
                onCloseAll={runner.closeAll}
                onPin={runner.pin}
                onRerun={(id) => runner.rerun(id, limit)}
                onStatus={onQueryStatus}
              />
            </div>
          </>
        )}
      </div>
    </section>
  )
}
