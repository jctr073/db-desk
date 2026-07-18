import type { ReactElement } from 'react'

import { CogIcon } from './icons'

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
}

export function StatusBar({
  onOpenSettings,
  connText,
  queryText,
  queryTarget,
  schemaText = '',
  schemaState,
  schemaTitle
}: StatusBarProps): ReactElement {
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
      <span className="statusbar__spacer" />
      {queryTarget && <span className="statusbar__target">{queryTarget}</span>}
    </div>
  )
}
