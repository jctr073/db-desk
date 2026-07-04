import type { ReactElement } from 'react'

import { PlusThinIcon, SparkleIcon } from './icons'

export function AgentPanel(): ReactElement {
  return (
    <section className="agent-panel">
      <div className="agent-tabbar">
        <button className="agent-tab" type="button">
          SQL Files
        </button>
        <button className="agent-tab is-active" type="button">
          <SparkleIcon />
          AI Agent
        </button>
        <div className="agent-tabbar__spacer" />
        <button className="icon-btn icon-btn--sm" title="New" type="button">
          <PlusThinIcon />
        </button>
      </div>
      <div className="placeholder">
        <div className="placeholder__mono">ai agent / sql files</div>
        <div className="placeholder__text">
          Prompt-driven SQL authoring — not part of this sketch
        </div>
      </div>
    </section>
  )
}
