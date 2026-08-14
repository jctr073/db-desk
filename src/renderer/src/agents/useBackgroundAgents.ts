import { useCallback, useEffect, useMemo, useState } from 'react'

import { foldAgentSegment } from '../../../shared/backgroundAgents'
import type {
  BackgroundAgentJob,
  BackgroundScanRequest,
  BackgroundScanStartResult
} from '../../../shared/backgroundAgents'

/**
 * Background scan jobs, kept live from the main-process runner: the initial
 * list plus every `agents:changed` push. Called once in App; the value feeds
 * the status-bar segment, the tray, and the manage dialog.
 * The return type is inferred so it stays in sync with the body.
 */
export function useBackgroundAgents() {
  const [jobs, setJobs] = useState<BackgroundAgentJob[]>([])
  const [queuePaused, setQueuePaused] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  /** Failure stickiness: the failed pill shows until the tray is opened after it. */
  const [lastTrayOpenedAt, setLastTrayOpenedAt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const apply = (state: { jobs: BackgroundAgentJob[]; queuePaused: boolean }): void => {
      if (cancelled) return
      setJobs(state.jobs)
      setQueuePaused(state.queuePaused)
    }
    void window.dbDesk.agents
      .list()
      .then(apply)
      .catch(() => {
        // Best-effort: a failed initial load simply shows an empty tray until
        // the first push arrives.
      })
    const unsubscribe = window.dbDesk.agents.onChanged(apply)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const toggleTray = useCallback(() => {
    setTrayOpen((open) => {
      if (!open) setLastTrayOpenedAt(Date.now())
      return !open
    })
  }, [])
  const closeTray = useCallback(() => setTrayOpen(false), [])

  const cancel = useCallback((jobId: string) => {
    void window.dbDesk.agents.cancel(jobId)
  }, [])
  const remove = useCallback((jobId: string) => {
    void window.dbDesk.agents.remove(jobId)
  }, [])
  const retry = useCallback((jobId: string) => {
    void window.dbDesk.agents.retry(jobId)
  }, [])
  const setPaused = useCallback((paused: boolean) => {
    void window.dbDesk.agents.setQueuePaused(paused)
  }, [])
  const startScan = useCallback(
    (req: BackgroundScanRequest): Promise<BackgroundScanStartResult> =>
      window.dbDesk.agents.startScan(req),
    []
  )

  const segment = useMemo(() => foldAgentSegment(jobs, lastTrayOpenedAt), [jobs, lastTrayOpenedAt])

  return {
    jobs,
    queuePaused,
    trayOpen,
    segment,
    toggleTray,
    closeTray,
    cancel,
    remove,
    retry,
    setPaused,
    startScan
  }
}

/** What the tray and status bar consume; App owns the single instance. */
export type BackgroundAgentsApi = ReturnType<typeof useBackgroundAgents>
