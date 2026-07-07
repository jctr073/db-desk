import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'

import type { DatabaseIntrospection } from '../../../shared/db'
import { statementAtOffset } from '../../../shared/sql'
import { ensureSqlLanguageFeatures } from '../sql/completions'
import type { Theme } from '../theme'
import {
  CheckIcon,
  ChevronDownIcon,
  CubeIcon,
  DatabaseIcon,
  FormatIcon,
  KebabIcon,
  PlayIcon,
  PlusThinIcon,
  SaveIcon,
  SqlFileIcon,
  CloseIcon
} from './icons'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor } from './SqlEditor'
import type { QueryRunner, QueryTarget } from './useQueryRunner'
import type { EditorBridge } from './editorBridge'
import type { FileState } from '../files/useFileState'

const DEFAULT_LIMIT = 500

interface EditorPanelProps {
  theme: Theme
  targets: QueryTarget[]
  /** Introspection cache: connection id → database name → schema. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  ensureSchema: (connId: string, database: string) => void
  files: FileState
  runner: QueryRunner
  /** Registered on mount so the AI agent can read/insert editor SQL. */
  bridge: MutableRefObject<EditorBridge | null>
}

function targetKey(target: QueryTarget): string {
  return JSON.stringify([target.connId, target.database])
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
  schemas,
  ensureSchema,
  files,
  runner,
  bridge
}: EditorPanelProps): ReactElement {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [limit, setLimit] = useState<number | null>(DEFAULT_LIMIT)
  const [resultsPct, setResultsPct] = useState(50)
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set())
  /** Which toolbar popover is open: the connection target or the kebab. */
  const [menu, setMenu] = useState<'target' | 'actions' | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const targetBtnRef = useRef<HTMLButtonElement | null>(null)
  const actionsBtnRef = useRef<HTMLButtonElement | null>(null)

  // Per-file buffers so switching tabs preserves unsaved edits.
  const buffersRef = useRef(new Map<string, string>())
  const activeFileIdRef = useRef<string | null>(null)
  activeFileIdRef.current = files.selectedFileId
  // Distinguishes programmatic setValue (tab switch) from user typing.
  const suppressChangeRef = useRef(false)

  const target = targets.find((t) => targetKey(t) === selectedKey) ?? null
  const activeFile = files.selectedFileId
    ? files.files.find((f) => f.id === files.selectedFileId)
    : null

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
    if (!menu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  // Keep the selection valid as connections come and go; prefer the database
  // the first connection was actually opened against.
  useEffect(() => {
    if (selectedKey && targets.some((t) => targetKey(t) === selectedKey)) return
    const fallback = targets.find((t) => t.primary) ?? targets[0]
    setSelectedKey(fallback ? targetKey(fallback) : null)
  }, [targets, selectedKey])

  // Completion reads the active target's schema through this ref so the
  // provider (registered once) always sees the latest introspection.
  const activeSchema = target
    ? (schemas[target.connId]?.[target.database] ?? null)
    : null
  const schemaRef = useRef<DatabaseIntrospection | null>(null)
  schemaRef.current = activeSchema

  // Databases picked in the toolbar may not have been expanded in the tree
  // yet; introspect them so completions have something to offer.
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

  const byConnection = new Map<string, QueryTarget[]>()
  for (const t of targets) {
    const list = byConnection.get(t.connId)
    if (list) list.push(t)
    else byConnection.set(t.connId, [t])
  }

  const filesByGroup = useMemo(() => {
    const groups = new Map<string, (typeof files.files)[number][]>()
    for (const file of files.files) {
      const key = file.connId && file.database
        ? `${file.connId}/${file.database}`
        : file.connId || 'unsaved'
      const list = groups.get(key) ?? []
      list.push(file)
      groups.set(key, list)
    }
    return groups
  }, [files.files])

  return (
    <section className="editor-panel">
      <div className="editor-tabbar">
        <div className="editor-tabbar__tabs">
        {[...filesByGroup.entries()].map(([groupKey, groupFiles]) => (
          <div key={groupKey} className="editor-tabs-group">
            {groupFiles.map((file) => (
              <div
                key={file.id}
                className={`editor-tab${files.selectedFileId === file.id ? ' is-active' : ''}`}
                onClick={() => files.selectFile(file.id)}
                title={`${file.name} · ${file.connId}/${file.database || '(connection level)'}`}
              >
                <SqlFileIcon />
                {file.name}
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
          </div>
        ))}
        <button
          className="icon-btn icon-btn--sm editor-tabbar__new"
          title="New query"
          type="button"
          onClick={() => {
            const connId = activeFile?.connId || null
            const database = activeFile?.database || null
            files.createFile(connId, database)
          }}
        >
          <PlusThinIcon />
        </button>
        </div>
        <button
          ref={targetBtnRef}
          className={`target-pill${menu === 'target' ? ' is-open' : ''}`}
          type="button"
          title="Connection and database queries run against"
          disabled={targets.length === 0}
          onClick={() => setMenu((m) => (m === 'target' ? null : 'target'))}
        >
          <span
            className={`target-pill__dot${target ? '' : ' is-off'}`}
            aria-hidden
          />
          <span className="target-pill__icon">
            <DatabaseIcon size={13} />
          </span>
          {target ? (
            <>
              <span className="target-pill__conn">{target.connName}</span>
              <span className="target-pill__sep">/</span>
              <span>{target.database}</span>
            </>
          ) : (
            'No connection'
          )}
          <span className="pill-chev">
            <ChevronDownIcon size={10} />
          </span>
        </button>
        <button
          className="btn-run btn-run--bar"
          type="button"
          disabled={!target}
          title={
            target
              ? 'Run statement at cursor (⌘⏎)'
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
          className={`btn-kebab${menu === 'actions' ? ' is-open' : ''}`}
          type="button"
          title="More actions"
          onClick={() => setMenu((m) => (m === 'actions' ? null : 'actions'))}
        >
          <KebabIcon />
        </button>
      </div>
      {menu === 'target' && targetBtnRef.current && (
        <>
          <div className="ctx-overlay" onClick={() => setMenu(null)} />
          <div
            className="ctx-menu toolbar-menu target-menu"
            style={menuPosition(targetBtnRef.current)}
            role="menu"
          >
            {[...byConnection.values()].map((group) => (
              <div key={group[0].connId}>
                <div className="target-menu__group">
                  <span className="target-menu__dot" aria-hidden />
                  {group[0].connName}
                </div>
                {group.map((t) => {
                  const key = targetKey(t)
                  const active = key === selectedKey
                  return (
                    <button
                      key={key}
                      className={`target-menu__item${active ? ' is-active' : ''}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        setSelectedKey(key)
                        setMenu(null)
                      }}
                    >
                      <CubeIcon />
                      <span>{t.database}</span>
                      {active && (
                        <span className="menu-check">
                          <CheckIcon size={13} />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </>
      )}
      {menu === 'actions' && actionsBtnRef.current && (
        <>
          <div className="ctx-overlay" onClick={() => setMenu(null)} />
          <div
            className="ctx-menu toolbar-menu"
            style={menuPosition(actionsBtnRef.current)}
            role="menu"
          >
            <button
              className="toolbar-menu__item"
              type="button"
              role="menuitem"
              onClick={() => setMenu(null)}
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
                setMenu(null)
              }}
            >
              <SaveIcon />
              <span>Save file</span>
              <span className="toolbar-menu__kbd">⌘S</span>
            </button>
          </div>
        </>
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
              />
            </div>
          </>
        )}
      </div>
    </section>
  )
}
