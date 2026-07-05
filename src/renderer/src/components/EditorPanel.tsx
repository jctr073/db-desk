import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import type { DatabaseIntrospection } from '../../../shared/db'
import { statementAtOffset } from '../../../shared/sql'
import { ensureSqlLanguageFeatures } from '../sql/completions'
import type { Theme } from '../theme'
import { PlayIcon, PlusThinIcon, SqlFileIcon, CloseIcon } from './icons'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor } from './SqlEditor'
import { useQueryRunner } from './useQueryRunner'
import type { QueryTarget } from './useQueryRunner'
import type { FileState } from '../files/useFileState'

const LIMIT_CHOICES = [100, 500, 1000, 5000]
const DEFAULT_LIMIT = 500

interface EditorPanelProps {
  theme: Theme
  targets: QueryTarget[]
  /** Introspection cache: connection id → database name → schema. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  ensureSchema: (connId: string, database: string) => void
  files: FileState
}

function targetKey(target: QueryTarget): string {
  return JSON.stringify([target.connId, target.database])
}

export function EditorPanel({
  theme,
  targets,
  schemas,
  ensureSchema,
  files
}: EditorPanelProps): ReactElement {
  const runner = useQueryRunner()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [limit, setLimit] = useState<number | null>(DEFAULT_LIMIT)
  const [resultsPct, setResultsPct] = useState(50)
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set())
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)

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
          className="icon-btn icon-btn--sm"
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
      <div className="editor-toolbar">
        <div className="editor-tabbar__spacer" />
        <select
          className="toolbar-select toolbar-select--target"
          title="Connection and database queries run against"
          value={selectedKey ?? ''}
          onChange={(e) => setSelectedKey(e.target.value || null)}
          disabled={targets.length === 0}
        >
          {targets.length === 0 && <option value="">No connection</option>}
          {[...byConnection.values()].map((group) => (
            <optgroup key={group[0].connId} label={group[0].connName}>
              {group.map((t) => (
                <option key={targetKey(t)} value={targetKey(t)}>
                  {t.connName} / {t.database}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          className="toolbar-select"
          title="Automatic row limit for SELECT queries"
          value={limit === null ? 'none' : String(limit)}
          onChange={(e) =>
            setLimit(e.target.value === 'none' ? null : Number(e.target.value))
          }
        >
          {LIMIT_CHOICES.map((n) => (
            <option key={n} value={String(n)}>
              LIMIT {n}
            </option>
          ))}
          <option value="none">No limit</option>
        </select>
        <button
          className="btn-run"
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
        </button>
        <button className="btn-format" type="button">
          Format
        </button>
        <button
          className="btn-save"
          type="button"
          disabled={
            !files.selectedFileId || !dirtyIds.has(files.selectedFileId)
          }
          title={
            files.selectedFileId && dirtyIds.has(files.selectedFileId)
              ? 'Save file (⌘S)'
              : 'No unsaved changes'
          }
          onClick={() => saveFileById(files.selectedFileId)}
        >
          Save
        </button>
      </div>
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
                onSelect={runner.setActiveTab}
                onClose={runner.closeTab}
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
