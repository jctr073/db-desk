import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import type { QueryResult } from '../../../shared/db'
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  PinIcon,
  RefreshIcon,
  RowsIcon,
  SparkleIcon
} from './icons'
import type { ResultTab } from './useQueryRunner'

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
  /** Report the active result's summary + target up to the app status bar. */
  onStatus?: (text: string, target: string) => void
}

const LIMIT_CHOICES: (number | null)[] = [100, 500, 1000, 5000, null]

/** Width budgeted per inline tab when deciding how many fit. */
const TAB_SLOT_PX = 150
/** Space kept free for the RESULTS cap, AI group tab, overflow button,
    spacer, limit pill and rerun control. */
const BAR_RESERVED_PX = 310

function statusLine(tab: ResultTab): string {
  const result = tab.result
  if (!result) return ''
  const parts: string[] = []
  if (result.fields.length > 0) {
    parts.push(
      `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`
    )
  } else {
    parts.push(
      `${result.rowCount ?? 0} row${(result.rowCount ?? 0) === 1 ? '' : 's'} affected`
    )
  }
  parts.push(`${result.durationMs} ms`)
  if (result.limitApplied !== null)
    parts.push(`LIMIT ${result.limitApplied} applied`)
  if (result.truncated) parts.push('output truncated')
  return `${result.command || 'OK'} · ${parts.join(' · ')}`
}

function ResultGrid({ result }: { result: QueryResult }): ReactElement {
  return (
    <div className="grid-scroll">
      <table className="result-grid">
        <thead>
          <tr>
            <th className="result-grid__rownum" aria-label="Row number" />
            {result.fields.map((field, i) => (
              <th key={i}>
                {field.name}
                <span className="result-grid__type">{field.dataType}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r}>
              <td className="result-grid__rownum">{r + 1}</td>
              {row.map((cell, c) => (
                <td key={c} className={cell === null ? 'is-null' : undefined}>
                  {cell === null ? 'NULL' : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && (
        <div className="grid-empty">No rows returned</div>
      )}
    </div>
  )
}

function TabBody({ tab }: { tab: ResultTab }): ReactElement {
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
  return <ResultGrid result={tab.result} />
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
  onStatus
}: ResultsPanelProps): ReactElement {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  const [menuOpen, setMenuOpen] = useState(false)
  const [limitOpen, setLimitOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [maxVisible, setMaxVisible] = useState(6)
  const barRef = useRef<HTMLDivElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const limitBtnRef = useRef<HTMLButtonElement>(null)

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
      setMaxVisible(
        Math.max(2, Math.floor((bar.clientWidth - BAR_RESERVED_PX) / TAB_SLOT_PX))
      )
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

  useEffect(() => {
    if (!menuOpen && !limitOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setLimitOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, limitOpen])

  const menuRect = menuOpen
    ? overflowBtnRef.current?.getBoundingClientRect()
    : undefined
  const limitRect = limitOpen
    ? limitBtnRef.current?.getBoundingClientRect()
    : undefined

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
          <span className="limit-pill__value">
            {limit === null ? 'none' : limit}
          </span>
          <span className="pill-chev">
            <ChevronDownIcon size={10} />
          </span>
        </button>
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
      {aiOpen && aiTabs.length > 0 && (
        <div className="ai-strip">
          <span className="ai-strip__label">Runs</span>
          {aiTabs.map((tab, i) => (
            <button
              key={tab.id}
              className={`ai-run${tab.id === activeTabId ? ' is-active' : ''}`}
              title={tab.sql}
              type="button"
              onClick={() => onSelect(tab.id)}
            >
              <span className="ai-run__num">{i + 1}</span>
              <span className="ai-run__hint">{tab.hint || 'query'}</span>
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
      {limitOpen && limitRect && (
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
                <span className="results-overflow-menu__title">
                  {tab.title}
                </span>
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
      {active && <TabBody tab={active} />}
    </div>
  )
}
