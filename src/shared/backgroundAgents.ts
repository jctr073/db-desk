/**
 * Wire types for background scan agents: headless agent turns run by the main
 * process (src/main/backgroundAgents.ts) and surfaced in the renderer's
 * status-bar segment and agents tray. Structured-clone friendly, no electron
 * or node imports — same rules as the other shared modules.
 */

import type { AgentEffort, AgentMode } from './agent'

export type BackgroundScanKind = 'full' | 'targeted'

export type BackgroundAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One background scan run, as pushed to the renderer (tray + status bar). */
export interface BackgroundAgentJob {
  id: string
  kind: BackgroundScanKind
  kbId: string
  /** Base display name, snapshotted at enqueue (renames don't retitle history). */
  baseName: string
  /** Effective scanned root (repoRoot/subPath already joined), display only. */
  repoRoot: string
  subPath: string | null
  target: { connId: string; connName: string; database: string }
  /** Schema scopes of the base's links to the target, for "prod / billing" labels. */
  schemas: string[]
  /** Focus text for targeted scans; null for full scans. */
  focus: string | null
  status: BackgroundAgentStatus
  /** Files the walker counted under the effective root (capped), or null before start. */
  filesTotal: number | null
  /** read_repo_file calls on distinct paths so far. */
  filesRead: number
  /** Successful save_knowledge calls so far. */
  recordsWritten: number
  /** 0–100 display heuristic; 100 only when done. */
  percent: number
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

/**
 * Renderer → main request to enqueue a scan. The prompt is built renderer-side
 * from the (possibly user-edited) skill, exactly like the foreground path; it
 * carries no filesystem paths — main resolves the repo root from the base.
 */
export interface BackgroundScanRequest {
  kbId: string
  kind: BackgroundScanKind
  focus: string | null
  prompt: string
  connId: string
  connName: string
  database: string
  model: string
  effort: AgentEffort | null
  mode: AgentMode
}

export type BackgroundScanStartResult = { ok: true; jobId: string } | { ok: false; error: string }

/** Payload of the `agents:changed` push. */
export interface BackgroundAgentsState {
  jobs: BackgroundAgentJob[]
  queuePaused: boolean
}

/** Global cap on concurrently running background agents; the rest queue. */
export const MAX_RUNNING_AGENTS = 2

/** Finished/failed/cancelled jobs kept in session history. */
export const AGENT_HISTORY_CAP = 20

/**
 * Display-progress heuristic: a scan agent reads a fraction of the repo, so
 * scale against an expected read count, not filesTotal — an honest
 * filesRead/filesTotal would crawl and stall. Monotonic in filesRead; capped
 * at 95 so only a finished run shows 100.
 */
export function scanPercent(
  kind: BackgroundScanKind,
  filesRead: number,
  filesTotal: number | null
): number {
  const total = filesTotal ?? 200
  const expected =
    kind === 'full'
      ? Math.min(120, Math.max(20, Math.round(total * 0.3)))
      : Math.min(40, Math.max(8, Math.round(total * 0.15)))
  return Math.min(95, Math.round((100 * filesRead) / expected))
}

/**
 * Fold jobs into the status-bar segment state. Failure is sticky: a failed
 * job keeps the segment red until the user opens the tray after it finished
 * (`lastTrayOpenedAt`), then stops shouting.
 */
export function foldAgentSegment(
  jobs: BackgroundAgentJob[],
  lastTrayOpenedAt: number
): { state: 'idle' | 'running' | 'failed'; label: string; percent: number } {
  const failed = jobs.filter((j) => j.status === 'failed' && (j.finishedAt ?? 0) > lastTrayOpenedAt)
  if (failed.length > 0) {
    return {
      state: 'failed',
      label: `${failed.length} agent${failed.length === 1 ? '' : 's'} failed`,
      percent: 0
    }
  }
  const running = jobs.filter((j) => j.status === 'running')
  const queued = jobs.filter((j) => j.status === 'queued')
  const active = running.length + queued.length
  if (active > 0) {
    const pool = running.length > 0 ? running : queued
    const percent = Math.round(pool.reduce((s, j) => s + j.percent, 0) / pool.length)
    return {
      state: 'running',
      label: `${active} agent${active === 1 ? '' : 's'} · ${percent}%`,
      percent
    }
  }
  return { state: 'idle', label: 'No agents', percent: 0 }
}
