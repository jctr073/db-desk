/**
 * Cross-validates the statement corpus against a real Postgres.
 *
 * The corpus (test/support/statements.ts) records, for every statement, what
 * the read-only session does with it (`underReadOnly`) and whether table data
 * changed (`mutates`). This suite runs each statement through the *real*
 * postgres driver in the same read-only session the agent uses, and asserts
 * those two observations still hold. It is the ground truth the classifier
 * unit tests are checked against.
 *
 * The load-bearing assertion is `read-only statements never mutate`: it is the
 * safety property `classifyStatement === 'read'` is a proxy for.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../../src/main/drivers/postgres'
import { PG_CASES, READ_CASES, ESCAPE_CASES } from '../../support/statements'
import {
  connectDriver,
  disconnectDriver,
  dropStrayObjects,
  resetData,
  rowCounts,
  runAsAgent,
  startAdmin,
  stopAdmin
} from '../support/db'

let connId: string

beforeAll(async () => {
  await startAdmin()
  connId = await connectDriver()
})

afterAll(async () => {
  await disconnectDriver(connId)
  await postgresDriver.disconnectAll()
  await stopAdmin()
})

afterEach(async () => {
  await dropStrayObjects()
  await resetData()
})

describe('corpus vs. a real read-only session', () => {
  for (const c of PG_CASES) {
    it(`${c.expected.padEnd(7)} ${c.name}`, async () => {
      await resetData()
      const before = await rowCounts()
      const res = await runAsAgent(connId, c.sql)
      const after = await rowCounts()

      const rejected = !res.ok
      expect(
        rejected ? 'rejected' : 'permitted',
        `read-only session verdict drifted for: ${c.sql}`
      ).toBe(c.underReadOnly)

      const mutated =
        before.customers !== after.customers ||
        before.orders !== after.orders ||
        before.orderItems !== after.orderItems
      expect(mutated, `mutation observation drifted for: ${c.sql}`).toBe(
        c.mutates
      )
    })
  }
})

describe('the safety property', () => {
  it('no statement classified `read` ever mutates under the read-only session', async () => {
    for (const c of READ_CASES) {
      if (c.skipIntegration) continue
      await resetData()
      const before = await rowCounts()
      await runAsAgent(connId, c.sql)
      const after = await rowCounts()
      expect(after, `a "read" statement changed data: ${c.sql}`).toEqual(before)
    }
  })
})

describe('why the client-side wall is load-bearing', () => {
  it('the read-only session alone lets multi-statement escapes mutate data', async () => {
    // These are exactly the payloads the guarded channel must refuse. Here we
    // prove they are real by letting them through the belt and watching rows
    // vanish -- so a regression that weakens guardAgentStatement cannot pass
    // unnoticed.
    expect(ESCAPE_CASES.length).toBeGreaterThan(0)
    for (const c of ESCAPE_CASES) {
      await resetData()
      const before = await rowCounts()
      const res = await runAsAgent(connId, c.sql)
      const after = await rowCounts()
      expect(res.ok, `expected the belt to permit: ${c.sql}`).toBe(true)
      expect(
        after.orderItems,
        `escape did not actually delete rows: ${c.sql}`
      ).toBeLessThan(before.orderItems)
    }
  })
})
