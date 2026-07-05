import { useState } from 'react'
import type { ReactElement } from 'react'

import type { FileState } from '../files/useFileState'
import { PlusThinIcon, SparkleIcon } from './icons'
import { FilesPanel } from './FilesPanel'

interface AgentPanelProps {
  files: FileState
  /** Connection id → display name. */
  connNames: Record<string, string>
}

export function AgentPanel({ files, connNames }: AgentPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'files' | 'agent'>('agent')

  return (
    <section className="agent-panel">
      <div className="agent-tabbar">
        <button
          className={`agent-tab${activeTab === 'files' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('files')}
        >
          SQL Files
        </button>
        <button
          className={`agent-tab${activeTab === 'agent' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('agent')}
        >
          <SparkleIcon />
          AI Agent
        </button>
        <div className="agent-tabbar__spacer" />
        <button className="icon-btn icon-btn--sm" title="New" type="button">
          <PlusThinIcon />
        </button>
      </div>
      {activeTab === 'files' ? (
        <FilesPanel files={files} connNames={connNames} />
      ) : (
        <div className="placeholder">
          <div className="placeholder__mono">ai agent / sql files</div>
          <div className="placeholder__text">
            Prompt-driven SQL authoring — not part of this sketch
          </div>
        </div>
      )}
    </section>
  )
}
