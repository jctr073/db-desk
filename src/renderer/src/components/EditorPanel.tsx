import type { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { statementAtOffset } from '../../../shared/sql'
import type { Theme } from '../theme'
import { PlayIcon, PlusThinIcon, SqlFileIcon } from './icons'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor } from './SqlEditor'
import { useQueryRunner } from './useQueryRunner'
import type { QueryTarget } from './useQueryRunner'

const LIMIT_CHOICES = [100, 500, 1000, 5000]
const DEFAULT_LIMIT = 500

interface EditorPanelProps {
  theme: Theme
  targets: QueryTarget[]
}

function targetKey(target: QueryTarget): string {
  return JSON.stringify([target.connId, target.database])
}

export function EditorPanel({
  theme,
  targets
}: EditorPanelProps): ReactElement {
  const runner = useQueryRunner()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [limit, setLimit] = useState<number | null>(DEFAULT_LIMIT)
  const [resultsPct, setResultsPct] = useState(50)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)

  const target = targets.find((t) => targetKey(t) === selectedKey) ?? null

  // Keep the selection valid as connections come and go; prefer the database
  // the first connection was actually opened against.
  useEffect(() => {
    if (selectedKey && targets.some((t) => targetKey(t) === selectedKey)) return
    const fallback = targets.find((t) => t.primary) ?? targets[0]
    setSelectedKey(fallback ? targetKey(fallback) : null)
  }, [targets, selectedKey])

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

  const handleMount = useCallback<OnMount>((ed, monaco) => {
    editorRef.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      runRef.current()
    )
  }, [])

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

  return (
    <section className="editor-panel">
      <div className="editor-tabbar">
        <div className="editor-tab">
          <SqlFileIcon />
          query-1.sql
          <span className="editor-tab__dot" title="Unsaved changes" />
        </div>
        <button
          className="icon-btn icon-btn--sm"
          title="New query"
          type="button"
        >
          <PlusThinIcon />
        </button>
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
