import type { ReactElement } from 'react'

import { ChevronDownIcon, ChevronUpIcon, CogIcon, SearchIcon } from './icons'

/** Background-agents segment; absent hides the segment entirely. */
export interface StatusBarAgents {
  state: 'idle' | 'running' | 'failed'
  /** "No agents" | "2 agents · 42%" | "1 agent failed" (from foldAgentSegment). */
  label: string
  /** Tray open → the chevron points down. */
  open: boolean
  onToggle: () => void
  /** Callback ref for the segment button, so the tray can anchor to it. */
  setAnchor?: (el: HTMLButtonElement | null) => void
}

interface StatusBarProps {
  onOpenSettings: () => void
  /** Connection the active editor tab runs against, e.g. "Connection · wcap_dev". */
  connText: string
  /** Active query result summary, e.g. "SELECT · 3 rows · 22 ms". */
  queryText: string
  /** Target of the active query, e.g. "wcap_dev / wcap". */
  queryTarget: string
  /** Background schema-sync summary, e.g. "Validating schema…"; '' hides it. */
  schemaText?: string
  /** Drives the sync segment's styling. */
  schemaState?: 'validating' | 'ok' | 'error'
  /** Tooltip for the sync segment (e.g. the validation error). */
  schemaTitle?: string
  agents?: StatusBarAgents
}

export function StatusBar({
  onOpenSettings,
  connText,
  queryText,
  queryTarget,
  schemaText = '',
  schemaState,
  schemaTitle,
  agents
}: StatusBarProps): ReactElement {
  const Chevron = agents?.open ? ChevronDownIcon : ChevronUpIcon
  return (
    <div className="statusbar">
      <button
        className="statusbar__btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
        type="button"
      >
        <CogIcon size={15} />
      </button>
      {connText && <span className="statusbar__dot" aria-hidden="true" />}
      {connText && <span className="statusbar__sel">{connText}</span>}
      {connText && queryText && <span className="statusbar__divider" aria-hidden="true" />}
      {queryText && <span className="statusbar__query">{queryText}</span>}
      {(connText || queryText) && schemaText && (
        <span className="statusbar__divider" aria-hidden="true" />
      )}
      {schemaText && (
        <span
          className={`statusbar__schema${schemaState ? ` is-${schemaState}` : ''}`}
          title={schemaTitle}
        >
          {schemaText}
        </span>
      )}
      {agents && (connText || queryText || schemaText) && (
        <span className="statusbar__divider" aria-hidden="true" />
      )}
      {agents && (
        <button
          ref={agents.setAnchor}
          type="button"
          className="statusbar__agents"
          aria-label="Background agents"
          aria-expanded={agents.open}
          title={agents.label}
          onClick={agents.onToggle}
        >
          {agents.state === 'idle' ? (
            <>
              <SearchIcon size={11} />
              <span className="statusbar__agents-idle">{agents.label}</span>
            </>
          ) : (
            <span
              className={`statusbar__agents-pill${
                agents.state === 'failed' ? ' statusbar__agents-pill--failed' : ''
              }`}
            >
              {agents.state === 'failed' ? (
                <span className="statusbar__agents-dot" aria-hidden="true" />
              ) : (
                <span className="spinner spinner--xs" aria-hidden="true" />
              )}
              {agents.label}
              <Chevron size={10} />
            </span>
          )}
        </button>
      )}
      <span className="statusbar__spacer" />
      {queryTarget && <span className="statusbar__target">{queryTarget}</span>}
    </div>
  )
}
