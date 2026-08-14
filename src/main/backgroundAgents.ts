/**
 * Main-process background scan runner: owns the table of background scan
 * jobs, their queue, and their lifecycle. Each job runs a normal agent turn
 * (runAgentTurn) headless under a synthetic chatId (`bga:<jobId>`) with an
 * intercepting Sender, so scan traffic never reaches the renderer's chat —
 * the tray is its only surface, fed by `agents:changed` pushes.
 *
 * Trust model matches the chat path: the request carries no filesystem paths
 * (main resolves the repo root from the base) and a kbId is honored only when
 * actually linked to the (connId, database) target — fail closed otherwise.
 * State is session-only by design: history dies with the process.
 */

import type { BrowserWindow } from 'electron'

import { typedHandle, typedSend } from './ipc'
import { disposeChat, runAgentTurn, stopChat } from './agent'
import type { Sender } from './agent/executors'
import { linksForTarget, listBases } from './knowledge'
import { getRepoRoot, listRepoFiles } from './repo'
import type { AgentSendRequest } from '../shared/agent'
import type {
  BackgroundAgentJob,
  BackgroundAgentsState,
  BackgroundScanRequest,
  BackgroundScanStartResult
} from '../shared/backgroundAgents'
import { AGENT_HISTORY_CAP, MAX_RUNNING_AGENTS, scanPercent } from '../shared/backgroundAgents'

/** jobId -> job; insertion order = enqueue order (pump takes oldest queued). */
const jobs = new Map<string, BackgroundAgentJob>()
/** jobId -> original request, kept so retry re-runs the same prompt. */
const requests = new Map<string, BackgroundScanRequest>()
let queuePaused = false

/** Progress pushes are throttled per job; status transitions push at once. */
const PROGRESS_PUSH_MIN_MS = 300

let broadcast: () => void = () => {}

function currentState(): BackgroundAgentsState {
  return { jobs: [...jobs.values()], queuePaused }
}

function chatIdFor(jobId: string): string {
  return `bga:${jobId}`
}

function runningCount(): number {
  let n = 0
  for (const job of jobs.values()) {
    if (job.status === 'running') n++
  }
  return n
}

/**
 * Drop the oldest finished/failed/cancelled jobs beyond the history cap.
 * Active jobs are never pruned.
 */
function pruneHistory(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  for (const job of finished.slice(0, Math.max(0, finished.length - AGENT_HISTORY_CAP))) {
    jobs.delete(job.id)
    requests.delete(job.id)
  }
}

/** Validation shared by startScan and retry; null = fine, else the refusal. */
function validateScanTarget(req: BackgroundScanRequest): string | null {
  // Same trust model as resolveActiveKbId: the base must actually be linked
  // to the target this scan claims to serve.
  if (!linksForTarget(req.connId, req.database).some((l) => l.kbId === req.kbId)) {
    return 'This base is not linked to the target.'
  }
  if (!getRepoRoot(req.kbId)) {
    return 'No codebase attached.'
  }
  return null
}

/** Enqueue a scan, or refuse with a user-facing reason. */
function startScan(req: BackgroundScanRequest): BackgroundScanStartResult {
  const invalid = validateScanTarget(req)
  if (invalid) return { ok: false, error: invalid }
  if (req.kind === 'targeted' && (!req.focus || req.focus.trim() === '')) {
    return { ok: false, error: 'A targeted scan needs a focus.' }
  }
  for (const job of jobs.values()) {
    if (job.kbId === req.kbId && (job.status === 'queued' || job.status === 'running')) {
      return { ok: false, error: 'A scan for this base is already running or queued.' }
    }
  }
  const base = listBases().find((b) => b.id === req.kbId)
  const root = getRepoRoot(req.kbId)
  if (!base || !root) return { ok: false, error: 'No codebase attached.' }
  const schemas = linksForTarget(req.connId, req.database)
    .filter((l) => l.kbId === req.kbId)
    .map((l) => l.schema)
    .filter((s): s is string => typeof s === 'string')
  const job: BackgroundAgentJob = {
    id: `bga-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    kind: req.kind,
    kbId: req.kbId,
    baseName: base.name,
    repoRoot: root,
    subPath: base.subPath ?? null,
    target: { connId: req.connId, connName: req.connName, database: req.database },
    schemas,
    focus: req.kind === 'targeted' ? req.focus : null,
    status: 'queued',
    filesTotal: null,
    filesRead: 0,
    recordsWritten: 0,
    percent: 0,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null
  }
  jobs.set(job.id, job)
  requests.set(job.id, req)
  pump()
  broadcast()
  return { ok: true, jobId: job.id }
}

/** Promote queued jobs (oldest first) while slots are free. */
function pump(): void {
  if (queuePaused) return
  for (const job of jobs.values()) {
    if (runningCount() >= MAX_RUNNING_AGENTS) return
    if (job.status !== 'queued') continue
    job.status = 'running'
    void runJob(job)
  }
}

async function runJob(job: BackgroundAgentJob): Promise<void> {
  job.startedAt = Date.now()
  broadcast()
  const snapshot = requests.get(job.id)
  const root = getRepoRoot(job.kbId)
  if (!snapshot || !root) {
    job.status = 'failed'
    job.error = 'Codebase is no longer attached.'
    job.finishedAt = Date.now()
    broadcast()
    pump()
    return
  }

  const chatId = chatIdFor(job.id)
  let sawError = false
  let sawAbort = false
  try {
    // The walker's result cap is fine here — the count only feeds the
    // display heuristic.
    try {
      const { files } = await listRepoFiles(root)
      job.filesTotal = files.length
    } catch {
      job.filesTotal = null
    }
    broadcast()

    const req: AgentSendRequest = {
      chatId,
      prompt: snapshot.prompt,
      intent: 'chat',
      model: snapshot.model,
      effort: snapshot.effort,
      mode: snapshot.mode,
      webSearch: false,
      repo: true,
      target: {
        connId: job.target.connId,
        connName: job.target.connName,
        database: job.target.database,
        kbId: job.kbId
      },
      editor: null,
      editorSelection: null,
      context: []
    }

    // Intercepting sender: nothing is forwarded to the renderer's
    // agent:event — progress is folded into the job and pushed (throttled)
    // on agents:changed instead.
    const toolNames = new Map<string, string>()
    const readPaths = new Set<string>()
    let lastProgressPush = 0
    let progressTimer: NodeJS.Timeout | null = null
    const pushProgress = (): void => {
      const now = Date.now()
      if (now - lastProgressPush >= PROGRESS_PUSH_MIN_MS) {
        lastProgressPush = now
        broadcast()
        return
      }
      if (progressTimer) return
      progressTimer = setTimeout(
        () => {
          progressTimer = null
          lastProgressPush = Date.now()
          broadcast()
        },
        PROGRESS_PUSH_MIN_MS - (now - lastProgressPush)
      )
    }
    const intercept: Sender = (evt) => {
      if (evt.type === 'tool_start') {
        toolNames.set(evt.toolId, evt.name)
        if (evt.name === 'read_repo_file') {
          // The label is `repo: read ${path}` (executors.ts); count
          // distinct paths.
          readPaths.add(evt.sql.startsWith('repo: read ') ? evt.sql.slice(11) : evt.sql)
          job.filesRead = readPaths.size
          job.percent = Math.max(job.percent, scanPercent(job.kind, job.filesRead, job.filesTotal))
          pushProgress()
        }
      } else if (evt.type === 'tool_result') {
        if (evt.ok && toolNames.get(evt.toolId) === 'save_knowledge') {
          job.recordsWritten++
          pushProgress()
        }
      } else if (evt.type === 'error') {
        sawError = true
        job.error = evt.message
      } else if (evt.type === 'done') {
        if (evt.stopReason === 'aborted') sawAbort = true
      }
    }

    await runAgentTurn(req, intercept, { editorTools: false })
    if (progressTimer) clearTimeout(progressTimer)
  } catch (err) {
    // runAgentTurn catches its own errors; this is a belt for bugs.
    sawError = true
    job.error = err instanceof Error ? err.message : String(err)
  } finally {
    disposeChat(chatId)
    if (sawAbort) {
      job.status = 'cancelled'
    } else if (sawError) {
      job.status = 'failed'
      job.error = job.error ?? 'The scan failed.'
    } else {
      job.status = 'done'
      job.percent = 100
    }
    job.finishedAt = Date.now()
    pruneHistory()
    broadcast()
    pump()
  }
}

function cancelJob(jobId: string): void {
  const job = jobs.get(jobId)
  if (!job) return
  if (job.status === 'queued') {
    job.status = 'cancelled'
    job.finishedAt = Date.now()
    pruneHistory()
    broadcast()
    pump()
    return
  }
  if (job.status === 'running') {
    // Finalization (status, finishedAt, broadcast) happens in runJob when
    // the aborted turn returns.
    stopChat(chatIdFor(jobId))
  }
}

function removeJob(jobId: string): void {
  const job = jobs.get(jobId)
  if (!job || job.status === 'running') return
  jobs.delete(jobId)
  requests.delete(jobId)
  broadcast()
  pump()
}

function retryJob(jobId: string): void {
  const job = jobs.get(jobId)
  const snapshot = requests.get(jobId)
  if (!job || !snapshot) return
  if (job.status !== 'failed' && job.status !== 'cancelled') return
  // The base may have been unlinked or detached since; fail closed like
  // startScan rather than re-queueing a job that can only fail.
  const invalid = validateScanTarget(snapshot)
  if (invalid) {
    job.error = invalid
    broadcast()
    return
  }
  job.status = 'queued'
  job.error = null
  job.startedAt = null
  job.finishedAt = null
  job.filesTotal = null
  job.filesRead = 0
  job.recordsWritten = 0
  job.percent = 0
  job.queuedAt = Date.now()
  pump()
  broadcast()
}

function setQueuePaused(paused: boolean): void {
  queuePaused = paused
  if (!paused) pump()
  broadcast()
}

export function registerBackgroundAgentHandlers(getWindow: () => BrowserWindow | null): void {
  broadcast = () => {
    typedSend(getWindow(), 'agents:changed', currentState())
  }

  typedHandle('agents:list', (): BackgroundAgentsState => currentState())

  typedHandle('agents:startScan', (_event, req): BackgroundScanStartResult => startScan(req))

  typedHandle('agents:cancel', (_event, jobId) => {
    cancelJob(jobId)
  })

  typedHandle('agents:remove', (_event, jobId) => {
    removeJob(jobId)
  })

  typedHandle('agents:retry', (_event, jobId) => {
    retryJob(jobId)
  })

  typedHandle('agents:setQueuePaused', (_event, paused) => {
    setQueuePaused(paused)
  })
}
