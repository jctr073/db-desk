import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'

import type { AgentResultItem } from '../../../shared/agent'
import type { QueryResult } from '../../../shared/db'
import type { DataExportFormat } from '../../../shared/export'
import { buildResultContextItem } from '../../../shared/resultContext'
import { DataGrid } from './grid/DataGrid'
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  ExportIcon,
  PinIcon,
  RefreshIcon,
  RowsIcon,
  SparkleIcon
} from './icons'
import { exportNeedsFullQuery, selectedResultRows, serializeResult } from './resultExport'
import type { ResultTab } from './useQueryRunner'
import { useEscapeKey } from '../useEscapeKey'

interface ResultsPanelProps {
  tabs: ResultTab[]
  activeTabId: string | null
  /** Automatic row limit applied to SELECT runs; null = no limit. */
  limit: number | null
  onLimitChange: (limit: number | null) => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCloseMany: (ids: string[]) => void
  onCloseAll: () => void
  onPin: (id: string) => void
  onRerun: (id: string) => void
  /** Hide the editable limit picker (relation previews always use 100). */
  showLimitControl?: boolean
  /** Render only the active result body, for a workspace-level preview tab. */
  contentOnly?: boolean
  /** Report the active result's summary + target up to the app status bar. */
  onStatus?: (text: string, target: string) => void
  /** Attach a result-context chip to the AI agent thread. */
  onAddAgentContext?: (item: AgentResultItem) => void
  /** Attach context AND pre-fill the agent composer (e.g. "Fix this error"). */
  onAskAgent?: (prompt: string, item: AgentResultItem) => void
}

const LIMIT_CHOICES: (number | null)[] = [100, 500, 1000, 5000, null]

/** Width budgeted per inline tab when deciding how many fit. */
const TAB_SLOT_PX = 150
/** Space kept free for the RESULTS cap, AI group tab, overflow button,
    spacer, limit pill and rerun control. */
const BAR_RESERVED_PX = 385

const EXPORT_FORMATS: Array<{
  format: DataExportFormat
  label: string
  extension: string
}> = [
  { format: 'csv', label: 'CSV', extension: '.csv' },
  { format: 'tsv', label: 'Tab-delimited', extension: '.tsv' },
  { format: 'json', label: 'JSON', extension: '.json' }
]

function exportFileBase(tab: ResultTab): string {
  const candidate = tab.hint || tab.title || 'query-results'
  const safe = candidate
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe || 'query-results'
}

function statusLine(tab: ResultTab): string {
  const result = tab.result
  if (!result) return ''
  const parts: string[] = []
  if (result.fields.length > 0) {
    parts.push(`${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`)
  } else {
    parts.push(`${result.rowCount ?? 0} row${(result.rowCount ?? 0) === 1 ? '' : 's'} affected`)
  }
  parts.push(`${result.durationMs} ms`)
  if (result.limitApplied !== null) parts.push(`LIMIT ${result.limitApplied} applied`)
  if (result.truncated) parts.push('output truncated')
  return `${result.command || 'OK'} · ${parts.join(' · ')}`
}

interface TabBodyProps {
  tab: ResultTab
  onSelectedRowsChange: (rows: ReadonlySet<number>) => void
  onSelectedColumnsChange: (columns: ReadonlySet<number>) => void
  onGridContextMenu?: (event: ReactMouseEvent) => void
  /** Present only when the parent offers "Fix with AI" on failed runs. */
  onFixWithAi?: () => void
}

function TabBody({
  tab,
  onSelectedRowsChange,
  onSelectedColumnsChange,
  onGridContextMenu,
  onFixWithAi
}: TabBodyProps): ReactElement {
  if (tab.running) {
    return (
      <div className="results-center">
        <span className="spinner" />
        <span className="results-center__text">Running…</span>
      </div>
    )
  }
  if (tab.error) {
    return (
      <div className="results-center">
        <pre className="result-error">{tab.error}</pre>
        {onFixWithAi && (
          <button
            className="fix-with-ai"
            type="button"
            title="Attach this error to the AI agent and ask it to fix the query"
            onClick={onFixWithAi}
          >
            <span className="fix-with-ai__icon">
              <SparkleIcon size={12} />
            </span>
            <span>Fix with AI</span>
          </button>
        )}
      </div>
    )
  }
  if (!tab.result) return <div className="results-center" />
  if (tab.result.fields.length === 0) {
    return (
      <div className="results-center">
        <span className="results-center__text">{statusLine(tab)}</span>
      </div>
    )
  }
  return (
    <DataGrid
      columns={tab.result.fields}
      rows={tab.result.rows}
      onSelectedRowsChange={onSelectedRowsChange}
      onSelectedColumnsChange={onSelectedColumnsChange}
      onGridContextMenu={onGridContextMenu}
    />
  )
}

export function ResultsPanel({
  tabs,
  activeTabId,
  limit,
  onLimitChange,
  onSelect,
  onClose,
  onCloseMany,
  onCloseAll,
  onPin,
  onRerun,
  showLimitControl = true,
  contentOnly = false,
  onStatus,
  onAddAgentContext,
  onAskAgent
}: ResultsPanelProps): ReactElement {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  const [menuOpen, setMenuOpen] = useState(false)
  const [limitOpen, setLimitOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportingFormat, setExportingFormat] = useState<DataExportFormat | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [selectedRowIndexes, setSelectedRowIndexes] = useState<Set<number>>(() => new Set())
  const [selectedColumnIndexes, setSelectedColumnIndexes] = useState<Set<number>>(() => new Set())
  const [resultCtxMenu, setResultCtxMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [maxVisible, setMaxVisible] = useState(6)
  const barRef = useRef<HTMLDivElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const limitBtnRef = useRef<HTMLButtonElement>(null)
  const exportBtnRef = useRef<HTMLButtonElement>(null)

  const onSelectedRowsChange = useCallback(
    (rows: ReadonlySet<number>): void => setSelectedRowIndexes(new Set(rows)),
    []
  )

  const onSelectedColumnsChange = useCallback(
    (columns: ReadonlySet<number>): void => setSelectedColumnIndexes(new Set(columns)),
    []
  )

  useEffect(() => {
    setSelectedRowIndexes(new Set())
    setSelectedColumnIndexes(new Set())
    setResultCtxMenu(null)
    setExportOpen(false)
    setExportError(null)
  }, [activeTabId])

  // Mirror the active result's summary into the app-wide status bar.
  useEffect(() => {
    if (!onStatus) return
    if (!active || active.running) {
      onStatus('', '')
      return
    }
    const text = active.error ? 'Query failed' : statusLine(active)
    onStatus(text, `${active.target.connName} / ${active.target.database}`)
  }, [active, onStatus])
  // Clear the status bar when the results panel unmounts (last tab closed).
  useEffect(() => () => onStatus?.('', ''), [onStatus])

  // Agent-executed runs collapse into a single "AI Agent" group tab instead
  // of flooding the bar; manual runs keep their own tabs.
  const aiTabs = tabs.filter((tab) => tab.source === 'ai')
  const userTabs = tabs.filter((tab) => tab.source !== 'ai')
  const activeIsAi = active?.source === 'ai'

  // Pop the runs strip open whenever the agent lands a new result.
  const aiCount = aiTabs.length
  useEffect(() => {
    if (aiCount > 0) setAiOpen(true)
  }, [aiCount])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const observer = new ResizeObserver(() => {
      setMaxVisible(Math.max(2, Math.floor((bar.clientWidth - BAR_RESERVED_PX) / TAB_SLOT_PX)))
    })
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])

  // Keep the active tab visible: when it lives past the cutoff it takes the
  // last inline slot, and everything else collapses into the overflow menu.
  let visibleTabs = userTabs
  let overflowTabs: ResultTab[] = []
  if (userTabs.length > maxVisible) {
    const activeIndex = userTabs.findIndex((tab) => tab.id === activeTabId)
    visibleTabs =
      activeIndex >= maxVisible
        ? [...userTabs.slice(0, maxVisible - 1), userTabs[activeIndex]]
        : userTabs.slice(0, maxVisible)
    const visibleIds = new Set(visibleTabs.map((tab) => tab.id))
    overflowTabs = userTabs.filter((tab) => !visibleIds.has(tab.id))
  }

  useEffect(() => {
    if (overflowTabs.length === 0) setMenuOpen(false)
  }, [overflowTabs.length])

  useEscapeKey(menuOpen || limitOpen || exportOpen || !!resultCtxMenu, () => {
    setMenuOpen(false)
    setLimitOpen(false)
    setExportOpen(false)
    setResultCtxMenu(null)
  })

  const menuRect = menuOpen ? overflowBtnRef.current?.getBoundingClientRect() : undefined
  const limitRect = limitOpen ? limitBtnRef.current?.getBoundingClientRect() : undefined
  const exportRect = exportOpen ? exportBtnRef.current?.getBoundingClientRect() : undefined

  const activeResult = active?.result ?? null
  const canExport = Boolean(activeResult && activeResult.fields.length > 0 && !active?.running)
  const selectedRowCount = selectedRowIndexes.size

  const hasSelection = selectedRowIndexes.size > 0 || selectedColumnIndexes.size > 0

  const addResultContext = (useSelection: boolean): void => {
    if (!active || !onAddAgentContext) return
    onAddAgentContext(
      buildResultContextItem({
        id: crypto.randomUUID(),
        title: active.title,
        sql: active.sql,
        connId: active.target.connId,
        database: active.target.database,
        result: active.result,
        error: active.error,
        selectedRows: useSelection ? selectedRowIndexes : null,
        selectedColumns: useSelection ? selectedColumnIndexes : null
      })
    )
    setResultCtxMenu(null)
  }

  const onGridContextMenu = onAddAgentContext
    ? (event: ReactMouseEvent): void => setResultCtxMenu({ x: event.clientX, y: event.clientY })
    : undefined

  const onFixWithAi =
    active && onAskAgent
      ? (): void =>
          onAskAgent(
            'Fix the error in this query and propose the corrected active query as an editor diff.',
            buildResultContextItem({
              id: crypto.randomUUID(),
              title: active.title,
              sql: active.sql,
              connId: active.target.connId,
              database: active.target.database,
              result: null,
              error: active.error
            })
          )
      : undefined

  const startExport = async (format: DataExportFormat): Promise<void> => {
    if (!active?.result || active.running || exportingFormat) return

    const tab = active
    const displayedResult: QueryResult = active.result
    const selectedRows = new Set(selectedRowIndexes)
    const extension =
      EXPORT_FORMATS.find((candidate) => candidate.format === format)?.extension ?? `.${format}`

    setExportOpen(false)
    setExportError(null)

    const destination = await window.dbDesk.exportFile.choose(
      `${exportFileBase(tab)}${extension}`,
      format
    )
    if (!destination.ok) {
      setExportError(destination.error)
      return
    }
    if (!destination.data) return

    const { token } = destination.data
    setExportingFormat(format)
    try {
      let fields = displayedResult.fields
      let rows =
        selectedRows.size > 0
          ? selectedResultRows(displayedResult.rows, selectedRows)
          : displayedResult.rows

      if (exportNeedsFullQuery(format, selectedRows.size)) {
        const fullResult = await window.dbDesk.db.queryForExport(
          tab.target.connId,
          tab.target.database,
          tab.sql
        )
        if (!fullResult.ok) throw new Error(fullResult.error)
        fields = fullResult.data.fields
        rows = fullResult.data.rows
      }

      const saved = await window.dbDesk.exportFile.write(
        token,
        serializeResult(fields, rows, format)
      )
      if (!saved.ok) throw new Error(saved.error)
    } catch (error) {
      await window.dbDesk.exportFile.discard(token)
      setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      setExportingFormat(null)
    }
  }

  const exportButton = canExport ? (
    <button
      ref={exportBtnRef}
      className={`export-pill${exportOpen ? ' is-open' : ''}`}
      title={
        selectedRowCount > 0
          ? `Export ${selectedRowCount} selected row${selectedRowCount === 1 ? '' : 's'}`
          : 'Export query results'
      }
      type="button"
      disabled={exportingFormat !== null}
      onClick={() => setExportOpen((open) => !open)}
    >
      {exportingFormat ? <span className="spinner spinner--xs" /> : <ExportIcon size={12} />}
      <span>{exportingFormat ? 'Exporting' : 'Export'}</span>
      {!exportingFormat && <ChevronDownIcon size={10} />}
    </button>
  ) : null

  const exportMenu = exportOpen && exportRect && activeResult && (
    <>
      <div className="ctx-overlay" onClick={() => setExportOpen(false)} />
      <div
        className="ctx-menu export-menu"
        style={{
          top: exportRect.bottom + 4,
          right: window.innerWidth - exportRect.right
        }}
        role="menu"
      >
        <div className="export-menu__scope">
          {selectedRowCount > 0
            ? `${selectedRowCount} selected row${selectedRowCount === 1 ? '' : 's'}`
            : 'All rows'}
        </div>
        {EXPORT_FORMATS.map(({ format, label, extension }) => (
          <button
            key={format}
            className="export-menu__item"
            type="button"
            role="menuitem"
            onClick={() => void startExport(format)}
          >
            <span>
              <span className="export-menu__label">{label}</span>
              <span className="export-menu__extension">{extension}</span>
            </span>
            <span className="export-menu__detail">
              {selectedRowCount > 0
                ? 'Current selection'
                : format === 'json'
                  ? `${activeResult.rows.length} loaded row${activeResult.rows.length === 1 ? '' : 's'}`
                  : 'Re-run without limit'}
            </span>
          </button>
        ))}
      </div>
    </>
  )

  const resultCtxMenuNode =
    resultCtxMenu && onAddAgentContext && active?.result ? (
      <div
        className="ctx-overlay"
        onMouseDown={() => setResultCtxMenu(null)}
        onContextMenu={(event) => {
          event.preventDefault()
          setResultCtxMenu(null)
        }}
      >
        <div
          className="ctx-menu"
          style={{ top: resultCtxMenu.y, left: resultCtxMenu.x }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {hasSelection && (
            <button
              className="ctx-menu__item"
              type="button"
              role="menuitem"
              onClick={() => addResultContext(true)}
            >
              Add selection to AI chat
            </button>
          )}
          <button
            className="ctx-menu__item"
            type="button"
            role="menuitem"
            onClick={() => addResultContext(false)}
          >
            Add result to AI chat
          </button>
        </div>
      </div>
    ) : null

  if (contentOnly) {
    return (
      <div className="results-panel">
        {exportButton && <div className="results-content-actions">{exportButton}</div>}
        {exportError && (
          <div className="result-export-error" role="alert">
            <span>{exportError}</span>
            <button type="button" onClick={() => setExportError(null)}>
              <CloseIcon size={11} />
            </button>
          </div>
        )}
        {exportMenu}
        {resultCtxMenuNode}
        {active && (
          <TabBody
            key={active.id}
            tab={active}
            onSelectedRowsChange={onSelectedRowsChange}
            onSelectedColumnsChange={onSelectedColumnsChange}
            onGridContextMenu={onGridContextMenu}
            onFixWithAi={onFixWithAi}
          />
        )}
      </div>
    )
  }

  return (
    <div className="results-panel">
      <div className="results-tabbar" ref={barRef}>
        <span className="results-cap">RESULTS</span>
        {visibleTabs.map((tab) => (
          <div
            key={tab.id}
            className={`results-tab${tab.id === activeTabId ? ' is-active' : ''}`}
            onClick={() => onSelect(tab.id)}
            role="tab"
            aria-selected={tab.id === activeTabId}
          >
            {tab.pinned && (
              <span className="results-tab__pinned">
                <PinIcon size={11} />
              </span>
            )}
            <span className="results-tab__title" title={tab.sql}>
              {tab.title}
            </span>
            {tab.running && <span className="spinner spinner--xs" />}
            {!tab.pinned && !tab.running && (
              <button
                className="results-tab__btn"
                title="Pin results — the next run opens a new tab"
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onPin(tab.id)
                }}
              >
                <PinIcon size={11} />
              </button>
            )}
            <button
              className="results-tab__btn"
              title="Close results"
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
        {overflowTabs.length > 0 && (
          <button
            ref={overflowBtnRef}
            className={`results-tab-overflow${menuOpen ? ' is-open' : ''}`}
            title={`${overflowTabs.length} more result tab${overflowTabs.length === 1 ? '' : 's'}`}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
          >
            +{overflowTabs.length}
            <ChevronDownIcon size={12} />
          </button>
        )}
        {aiTabs.length > 0 && (
          <button
            className={`ai-tab${aiOpen ? ' is-open' : ''}${activeIsAi ? ' is-active' : ''}`}
            title={`${aiTabs.length} quer${aiTabs.length === 1 ? 'y' : 'ies'} run by the AI agent`}
            type="button"
            onClick={() => setAiOpen((open) => !open)}
          >
            <span className="ai-tab__icon">
              <SparkleIcon size={12} />
            </span>
            <span className="ai-tab__label">AI Agent</span>
            <span className="ai-tab__count">{aiTabs.length}</span>
            <span className={`ai-tab__chev${aiOpen ? ' is-open' : ''}`}>
              <ChevronDownIcon size={10} />
            </span>
          </button>
        )}
        <div className="editor-tabbar__spacer" />
        {active && (
          <span
            className="ctx-chip ctx-chip--sm"
            title={`Result target — ${active.target.connName} / ${active.target.database}`}
          >
            <span className="ctx-chip__dot" />
            <span className="ctx-chip__name">{active.target.connName}</span>
            <span className="ctx-chip__db">/ {active.target.database}</span>
          </span>
        )}
        {showLimitControl && (
          <button
            ref={limitBtnRef}
            className={`limit-pill${limitOpen ? ' is-open' : ''}`}
            title="Automatic row limit for SELECT queries"
            type="button"
            onClick={() => setLimitOpen((open) => !open)}
          >
            <span className="limit-pill__icon">
              <RowsIcon />
            </span>
            <span className="limit-pill__word">limit</span>
            <span className="limit-pill__value">{limit === null ? 'none' : limit}</span>
            <span className="pill-chev">
              <ChevronDownIcon size={10} />
            </span>
          </button>
        )}
        {exportButton}
        {active && !active.running && (
          <button
            className="icon-btn icon-btn--sm"
            title="Run this query again"
            type="button"
            onClick={() => onRerun(active.id)}
          >
            <RefreshIcon />
          </button>
        )}
      </div>
      {exportError && (
        <div className="result-export-error" role="alert">
          <span>{exportError}</span>
          <button type="button" onClick={() => setExportError(null)}>
            <CloseIcon size={11} />
          </button>
        </div>
      )}
      {exportMenu}
      {aiOpen && aiTabs.length > 0 && (
        <div className="ai-strip">
          <span className="ai-strip__label">Runs</span>
          {aiTabs.map((tab, i) => (
            <button
              key={tab.id}
              className={`ai-run${tab.id === activeTabId ? ' is-active' : ''}${tab.final ? ' is-final' : ''}`}
              title={tab.final ? `Final result of the agent turn\n${tab.sql}` : tab.sql}
              type="button"
              onClick={() => onSelect(tab.id)}
            >
              <span className="ai-run__num">{i + 1}</span>
              <span className="ai-run__hint">{tab.hint || 'query'}</span>
              {tab.final && <span className="ai-run__final">final</span>}
            </button>
          ))}
          <div className="editor-tabbar__spacer" />
          <button
            className="ai-strip__clear"
            title="Close all AI agent results"
            type="button"
            onClick={() => onCloseMany(aiTabs.map((tab) => tab.id))}
          >
            Clear all
          </button>
        </div>
      )}
      {showLimitControl && limitOpen && limitRect && (
        <>
          <div className="ctx-overlay" onClick={() => setLimitOpen(false)} />
          <div
            className="ctx-menu limit-menu"
            style={{
              top: limitRect.bottom + 4,
              right: window.innerWidth - limitRect.right
            }}
            role="menu"
          >
            {LIMIT_CHOICES.map((n) => {
              const isActive = n === limit
              return (
                <button
                  key={n === null ? 'none' : n}
                  className={`limit-menu__item${isActive ? ' is-active' : ''}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    onLimitChange(n)
                    setLimitOpen(false)
                  }}
                >
                  <span>{n === null ? 'No limit' : n}</span>
                  {isActive && (
                    <span className="menu-check">
                      <CheckIcon size={12} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
      {menuOpen && menuRect && (
        <>
          <div className="ctx-overlay" onClick={() => setMenuOpen(false)} />
          <div
            className="ctx-menu results-overflow-menu"
            style={{ top: menuRect.bottom + 4, left: menuRect.left }}
            role="menu"
          >
            {overflowTabs.map((tab) => (
              <div
                key={tab.id}
                className="results-overflow-menu__item"
                title={tab.sql}
                role="menuitem"
                onClick={() => {
                  onSelect(tab.id)
                  setMenuOpen(false)
                }}
              >
                {tab.pinned && (
                  <span className="results-tab__pinned">
                    <PinIcon size={11} />
                  </span>
                )}
                <span className="results-overflow-menu__title">{tab.title}</span>
                {tab.running ? (
                  <span className="spinner spinner--xs" />
                ) : (
                  <button
                    className="results-tab__btn"
                    title="Close results"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(tab.id)
                    }}
                  >
                    <CloseIcon size={11} />
                  </button>
                )}
              </div>
            ))}
            <div className="ctx-menu__sep" />
            <button
              className="ctx-menu__item"
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onCloseAll()
              }}
            >
              Close all results
            </button>
          </div>
        </>
      )}
      {resultCtxMenuNode}
      {active && (
        <TabBody
          key={active.id}
          tab={active}
          onSelectedRowsChange={onSelectedRowsChange}
          onSelectedColumnsChange={onSelectedColumnsChange}
          onGridContextMenu={onGridContextMenu}
          onFixWithAi={onFixWithAi}
        />
      )}
    </div>
  )
}
