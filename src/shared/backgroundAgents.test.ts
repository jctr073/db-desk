import { describe, expect, it } from 'vitest'

import type { BackgroundAgentJob } from './backgroundAgents'
import { foldAgentSegment, scanPercent } from './backgroundAgents'

function job(overrides: Partial<BackgroundAgentJob>): BackgroundAgentJob {
  return {
    id: 'bga-1',
    kind: 'full',
    kbId: 'kb-1',
    baseName: 'base',
    repoRoot: '/repo',
    subPath: null,
    target: { connId: 'c1', connName: 'prod', database: 'app' },
    schemas: ['public'],
    focus: null,
    status: 'queued',
    filesTotal: null,
    filesRead: 0,
    recordsWritten: 0,
    percent: 0,
    queuedAt: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    ...overrides
  }
}

describe('scanPercent', () => {
  it('is monotonic in filesRead', () => {
    let prev = -1
    for (let read = 0; read <= 200; read++) {
      const p = scanPercent('full', read, 300)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  it('caps at 95', () => {
    expect(scanPercent('full', 10_000, 300)).toBe(95)
    expect(scanPercent('targeted', 10_000, 300)).toBe(95)
  })

  it('starts at 0', () => {
    expect(scanPercent('full', 0, 300)).toBe(0)
    expect(scanPercent('targeted', 0, null)).toBe(0)
  })

  it('expects fewer reads for targeted scans than full scans', () => {
    // Same progress reads further along on a targeted scan.
    expect(scanPercent('targeted', 10, 300)).toBeGreaterThan(scanPercent('full', 10, 300))
  })

  it('handles a null filesTotal with a default expectation', () => {
    expect(scanPercent('full', 30, null)).toBe(50) // expected = 60 for total 200
  })

  it('clamps the expected-read count for tiny and huge repos', () => {
    // Tiny repo: expected floor of 20 for full scans.
    expect(scanPercent('full', 10, 10)).toBe(50)
    // Huge repo: expected ceiling of 120 for full scans.
    expect(scanPercent('full', 60, 100_000)).toBe(50)
  })
})

describe('foldAgentSegment', () => {
  it('is idle with no jobs', () => {
    expect(foldAgentSegment([], 0)).toEqual({ state: 'idle', label: 'No agents', percent: 0 })
  })

  it('is idle when only old finished jobs exist', () => {
    const jobs = [job({ status: 'done', finishedAt: 100, percent: 100 })]
    expect(foldAgentSegment(jobs, 0).state).toBe('idle')
  })

  it('averages percent over running jobs and counts queued in the label', () => {
    const jobs = [
      job({ id: 'a', status: 'running', percent: 40 }),
      job({ id: 'b', status: 'running', percent: 60 }),
      job({ id: 'c', status: 'queued', percent: 0 })
    ]
    expect(foldAgentSegment(jobs, 0)).toEqual({
      state: 'running',
      label: '3 agents · 50%',
      percent: 50
    })
  })

  it('uses the singular for one active agent', () => {
    const jobs = [job({ status: 'running', percent: 42 })]
    expect(foldAgentSegment(jobs, 0).label).toBe('1 agent · 42%')
  })

  it('shows queued-only pools at their own percent (0)', () => {
    const jobs = [job({ status: 'queued' })]
    expect(foldAgentSegment(jobs, 0)).toEqual({
      state: 'running',
      label: '1 agent · 0%',
      percent: 0
    })
  })

  it('failure wins over running', () => {
    const jobs = [
      job({ id: 'a', status: 'running', percent: 40 }),
      job({ id: 'b', status: 'failed', finishedAt: 100 })
    ]
    expect(foldAgentSegment(jobs, 0)).toEqual({
      state: 'failed',
      label: '1 agent failed',
      percent: 0
    })
  })

  it('pluralizes failures', () => {
    const jobs = [
      job({ id: 'a', status: 'failed', finishedAt: 100 }),
      job({ id: 'b', status: 'failed', finishedAt: 101 })
    ]
    expect(foldAgentSegment(jobs, 0).label).toBe('2 agents failed')
  })

  it('stops shouting about failures once the tray was opened after them', () => {
    const jobs = [job({ status: 'failed', finishedAt: 100 })]
    expect(foldAgentSegment(jobs, 99).state).toBe('failed')
    expect(foldAgentSegment(jobs, 100).state).toBe('idle')
    expect(foldAgentSegment(jobs, 150).state).toBe('idle')
  })
})
