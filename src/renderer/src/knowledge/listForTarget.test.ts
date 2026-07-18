import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeTargetGroup } from '../../../shared/knowledge'
import { listForTargetCoalesced } from './listForTarget'

const flushMicrotasks = (): Promise<void> => Promise.resolve()

describe('listForTargetCoalesced', () => {
  let listForTarget: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listForTarget = vi.fn((connId: string, database: string): Promise<KnowledgeTargetGroup[]> =>
      Promise.resolve([{ marker: `${connId}/${database}` } as unknown as KnowledgeTargetGroup])
    )
    vi.stubGlobal('window', { dbDesk: { knowledge: { listForTarget } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('coalesces same-target calls made in the same synchronous burst', async () => {
    const first = listForTargetCoalesced('c1', 'db1')
    const second = listForTargetCoalesced('c1', 'db1')
    const third = listForTargetCoalesced('c1', 'db1')

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(listForTarget).toHaveBeenCalledTimes(1)
    await expect(first).resolves.toEqual([{ marker: 'c1/db1' }])
  })

  it('keeps different targets separate', async () => {
    const a = listForTargetCoalesced('c1', 'db1')
    const b = listForTargetCoalesced('c1', 'db2')
    const c = listForTargetCoalesced('c2', 'db1')

    expect(b).not.toBe(a)
    expect(c).not.toBe(a)
    expect(listForTarget).toHaveBeenCalledTimes(3)
    await expect(b).resolves.toEqual([{ marker: 'c1/db2' }])
  })

  it('does not treat the key parts as a joined string', () => {
    const a = listForTargetCoalesced('c1/db', '1')
    const b = listForTargetCoalesced('c1', 'db/1')

    expect(b).not.toBe(a)
    expect(listForTarget).toHaveBeenCalledTimes(2)
  })

  it('issues a fresh request once the synchronous burst is over', async () => {
    const first = listForTargetCoalesced('c1', 'db1')
    await flushMicrotasks()
    const second = listForTargetCoalesced('c1', 'db1')

    expect(second).not.toBe(first)
    expect(listForTarget).toHaveBeenCalledTimes(2)
  })

  it('never re-serves an in-flight request in a later task, even an unresolved one', async () => {
    let resolveFirst: ((groups: KnowledgeTargetGroup[]) => void) | undefined
    listForTarget.mockImplementationOnce(
      () =>
        new Promise<KnowledgeTargetGroup[]>((resolve) => {
          resolveFirst = resolve
        })
    )

    const first = listForTargetCoalesced('c1', 'db1')
    await flushMicrotasks()
    // The first request is still pending, but the burst that started it is
    // over — e.g. a knowledge:changed reload must not read pre-change data.
    const second = listForTargetCoalesced('c1', 'db1')

    expect(second).not.toBe(first)
    expect(listForTarget).toHaveBeenCalledTimes(2)
    resolveFirst?.([])
    await expect(first).resolves.toEqual([])
  })
})
