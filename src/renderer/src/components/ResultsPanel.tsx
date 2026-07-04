import type { ReactElement } from 'react'

import type { QueryResult } from '../../../shared/db'
import { CloseIcon, PinIcon, RefreshIcon } from './icons'
import type { ResultTab } from './useQueryRunner'

interface ResultsPanelProps {
  tabs: ResultTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onPin: (id: string) => void
  onRerun: (id: string) => void
}

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
  onSelect,
  onClose,
  onPin,
  onRerun
}: ResultsPanelProps): ReactElement {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  return (
    <div className="results-panel">
      <div className="results-tabbar">
        {tabs.map((tab) => (
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
        <div className="editor-tabbar__spacer" />
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
      {active && <TabBody tab={active} />}
      {active && !active.running && (
        <div className="result-status">
          <span className="result-status__main">
            {active.error ? 'Query failed' : statusLine(active)}
          </span>
          <span className="result-status__target">
            {active.target.connName} / {active.target.database}
          </span>
        </div>
      )}
    </div>
  )
}
