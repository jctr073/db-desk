import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactElement, RefObject } from 'react'

import type { BackgroundAgentJob } from '../../../shared/backgroundAgents'
import type { BackgroundAgentsApi } from '../agents/useBackgroundAgents'
import { CheckIcon, CloseIcon } from './icons'

/** Tray width; the popover is fixed-width so the anchor only sets its left edge. */
const TRAY_WIDTH = 398
/** 26px status bar + 8px gap. */
const TRAY_BOTTOM = 34
const EDGE_GAP = 8
/** Finished runs shown under the Running tab's FINISHED divider. */
const RECENT_FINISHED = 5

type TrayTab = 'running' | 'queued' | 'history'

interface AgentsTrayProps {
  agents: BackgroundAgentsApi
  /** The status-bar segment button the tray anchors to (App owns the ref). */
  anchor: RefObject<HTMLButtonElement | null>
  onViewRecords: (job: BackgroundAgentJob) => void
  onOpenAgentPanel: () => void
}

/** Coarse relative age, per the design: minutes then hours, never seconds. */
function agoLabel(at: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/** Run duration: seconds below a minute, then "4m 12s", then "1h 6m". */
function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const KIND_LABEL: Record<BackgroundAgentJob['kind'], string> = {
  full: 'Codebase scan',
  targeted: 'Targeted scan'
}

/** "…/repo · wcap / public, billing" — the run's scope in one line. */
function scopeLine(job: BackgroundAgentJob): string {
  const schemas = job.schemas.length > 0 ? ` / ${job.schemas.join(', ')}` : ''
  return `${job.repoRoot} · ${job.target.database}${schemas}`
}

function RunningRow({
  job,
  now,
  onCancel
}: {
  job: BackgroundAgentJob
  now: number
  onCancel: (id: string) => void
}): ReactElement {
  const teal = job.kind === 'targeted'
  const counts = `${job.filesRead} of ${job.filesTotal ?? '?'} files`
  const elapsed = job.startedAt ? durationLabel(now - job.startedAt) : '0s'
  const sub =
    job.kind === 'full'
      ? `${counts} · ${job.recordsWritten} records written · ${elapsed} elapsed`
      : `“${job.focus ?? ''}” · ${counts} · ${job.recordsWritten} records`
  return (
    <div className="agents-tray__row agents-tray__row--running">
      <div className="agents-tray__row-main">
        <span className={`spinner spinner--xs${teal ? ' spinner--teal' : ''}`} aria-hidden="true" />
        <div className="agents-tray__row-body">
          <div className="agents-tray__row-head">
            <span className="agents-tray__row-kind">{KIND_LABEL[job.kind]}</span>
            <span className="agents-tray__row-base">{job.baseName}</span>
          </div>
          <div className="agents-tray__row-path" title={scopeLine(job)}>
            {scopeLine(job)}
          </div>
          <div className="agents-tray__row-sub" title={sub}>
            {sub}
          </div>
        </div>
        <button type="button" className="agents-tray__row-btn" onClick={() => onCancel(job.id)}>
          Cancel
        </button>
      </div>
      <div className="agents-tray__row-rail" aria-hidden="true">
        <div
          className={`agents-tray__row-rail-fill${teal ? ' agents-tray__row-rail-fill--teal' : ''}`}
          style={{ width: `${job.percent}%` }}
        />
      </div>
    </div>
  )
}

function TerminalRow({
  job,
  now,
  agents,
  onViewRecords
}: {
  job: BackgroundAgentJob
  now: number
  agents: BackgroundAgentsApi
  onViewRecords: (job: BackgroundAgentJob) => void
}): ReactElement {
  const at = job.finishedAt ?? job.queuedAt
  const ago = `${agoLabel(at, now)} ago`
  const duration =
    job.startedAt && job.finishedAt ? durationLabel(job.finishedAt - job.startedAt) : null
  const label = job.subPath ?? job.baseName

  if (job.status === 'failed') {
    const sub = `Failed — ${job.error ?? 'unknown error'} · ${ago}`
    return (
      <div className="agents-tray__row agents-tray__row--failed">
        <div className="agents-tray__row-main">
          <span className="agents-tray__disc agents-tray__disc--failed" aria-hidden="true">
            <CloseIcon size={8} />
          </span>
          <div className="agents-tray__row-body">
            <div className="agents-tray__row-head">
              <span className="agents-tray__row-kind">{label}</span>
            </div>
            <div className="agents-tray__row-sub agents-tray__row-sub--failed" title={sub}>
              {sub}
            </div>
          </div>
          <button
            type="button"
            className="agents-tray__row-btn"
            onClick={() => agents.retry(job.id)}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (job.status === 'cancelled') {
    return (
      <div className="agents-tray__row agents-tray__row--done">
        <div className="agents-tray__row-main">
          <span className="agents-tray__hollow agents-tray__hollow--faint" aria-hidden="true" />
          <div className="agents-tray__row-body">
            <div className="agents-tray__row-head">
              <span className="agents-tray__row-kind">{label}</span>
            </div>
            <div className="agents-tray__row-sub">{`Cancelled · ${ago}`}</div>
          </div>
          <button
            type="button"
            className="agents-tray__row-btn"
            onClick={() => agents.remove(job.id)}
          >
            Remove
          </button>
        </div>
      </div>
    )
  }

  const sub = `+${job.recordsWritten} records${duration ? ` · ${duration}` : ''} · ${ago}`
  return (
    <div className="agents-tray__row agents-tray__row--done">
      <div className="agents-tray__row-main">
        <span className="agents-tray__disc agents-tray__disc--done" aria-hidden="true">
          <CheckIcon size={9} />
        </span>
        <div className="agents-tray__row-body">
          <div className="agents-tray__row-head">
            <span className="agents-tray__row-kind">{label}</span>
          </div>
          <div className="agents-tray__row-sub">{sub}</div>
        </div>
        <button type="button" className="agents-tray__row-btn" onClick={() => onViewRecords(job)}>
          View records
        </button>
      </div>
    </div>
  )
}

function QueuedRow({
  job,
  onRemove
}: {
  job: BackgroundAgentJob
  onRemove: (id: string) => void
}): ReactElement {
  return (
    <div className="agents-tray__row agents-tray__row--queued">
      <div className="agents-tray__row-main">
        <span className="agents-tray__hollow" aria-hidden="true" />
        <div className="agents-tray__row-body">
          <div className="agents-tray__row-head">
            <span className="agents-tray__row-kind">{KIND_LABEL[job.kind]}</span>
            <span className="agents-tray__row-base">{job.baseName}</span>
          </div>
          <div className="agents-tray__row-sub">Queued — starts when a slot frees up</div>
        </div>
        <button type="button" className="agents-tray__row-btn" onClick={() => onRemove(job.id)}>
          Remove
        </button>
      </div>
    </div>
  )
}

/**
 * Popover over the status-bar agents segment: running, queued and finished
 * background scans. Lives in the app shell so it survives dialogs closing, and
 * dismisses on Escape in the capture phase so one keypress closes only the tray
 * when a dialog sits underneath it.
 */
export function AgentsTray({
  agents,
  anchor,
  onViewRecords,
  onOpenAgentPanel
}: AgentsTrayProps): ReactElement {
  const [tab, setTab] = useState<TrayTab>('running')
  const [left, setLeft] = useState(EDGE_GAP)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  // Elapsed/"ago" labels are coarse (m/h), so a slow tick keeps them honest.
  const [now, setNow] = useState(() => Date.now())

  const { closeTray, cancel, remove, jobs, queuePaused, setPaused } = agents

  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect()
    const max = Math.max(EDGE_GAP, window.innerWidth - TRAY_WIDTH - EDGE_GAP)
    setLeft(Math.min(max, Math.max(EDGE_GAP, rect?.left ?? EDGE_GAP)))
  }, [anchor])

  useLayoutEffect(() => {
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [place])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  // Capture phase on purpose: a dialog may be open underneath, and its
  // window-level (bubble) Escape handler must not also fire.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      closeTray()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [closeTray])

  // Outside click dismisses, except on the anchor button — its own click
  // already toggles the tray, and closing here too would reopen it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (root?.contains(target)) return
      if (anchor.current?.contains(target)) return
      closeTray()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [root, anchor, closeTray])

  const running = useMemo(() => jobs.filter((j) => j.status === 'running'), [jobs])
  const queued = useMemo(() => jobs.filter((j) => j.status === 'queued'), [jobs])
  const finished = useMemo(
    () =>
      jobs
        .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
    [jobs]
  )
  /** The Running tab's FINISHED strip excludes cancelled runs (design). */
  const recentFinished = useMemo(
    () => finished.filter((j) => j.status !== 'cancelled').slice(0, RECENT_FINISHED),
    [finished]
  )

  const terminalRow = (job: BackgroundAgentJob): ReactElement => (
    <TerminalRow key={job.id} job={job} now={now} agents={agents} onViewRecords={onViewRecords} />
  )

  return (
    <div className="agents-tray" ref={setRoot} style={{ left, bottom: TRAY_BOTTOM }} role="dialog">
      <div className="agents-tray__header">
        <span className="agents-tray__title">Background agents</span>
        <span className="agents-tray__header-spacer" />
        <button
          type="button"
          className="agents-tray__ghost"
          onClick={() => setPaused(!queuePaused)}
        >
          {queuePaused ? 'Resume queue' : 'Pause queue'}
        </button>
      </div>

      <div className="dtabs agents-tray__tabs">
        <button
          type="button"
          className={`dtab${tab === 'running' ? ' is-active' : ''}`}
          onClick={() => setTab('running')}
        >
          Running · {running.length}
        </button>
        <button
          type="button"
          className={`dtab${tab === 'queued' ? ' is-active' : ''}`}
          onClick={() => setTab('queued')}
        >
          Queued · {queued.length}
        </button>
        <button
          type="button"
          className={`dtab${tab === 'history' ? ' is-active' : ''}`}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      <div className="agents-tray__list">
        {tab === 'running' && (
          <>
            {running.map((job) => (
              <RunningRow key={job.id} job={job} now={now} onCancel={cancel} />
            ))}
            {queued.map((job) => (
              <QueuedRow key={job.id} job={job} onRemove={remove} />
            ))}
            {running.length === 0 && queued.length === 0 && (
              <div className="agents-tray__empty">No agents running.</div>
            )}
            {recentFinished.length > 0 && (
              <>
                <div className="agents-tray__finished-label">FINISHED</div>
                {recentFinished.map(terminalRow)}
              </>
            )}
          </>
        )}
        {tab === 'queued' && (
          <>
            {queued.map((job) => (
              <QueuedRow key={job.id} job={job} onRemove={remove} />
            ))}
            {queued.length === 0 && <div className="agents-tray__empty">Nothing queued.</div>}
          </>
        )}
        {tab === 'history' && (
          <>
            {finished.map(terminalRow)}
            {finished.length === 0 && (
              <div className="agents-tray__empty">No finished runs yet.</div>
            )}
          </>
        )}
      </div>

      <div className="agents-tray__footer">
        <span className="agents-tray__hint">Agents keep running while dialogs are closed.</span>
        <button type="button" className="agents-tray__link" onClick={onOpenAgentPanel}>
          Open agent panel
        </button>
      </div>
    </div>
  )
}
