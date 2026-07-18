/**
 * The strongest wall the README recommends: connect with a login role that
 * holds SELECT and nothing else. This proves the property the session-level
 * belt cannot guarantee -- a plain SELECT that calls a volatile writing
 * function is stopped too, because the privilege check fires regardless of
 * transaction read-only state.
 *
 * dbdesk_ro is created by test/seed/01-schema.sql.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../../src/main/drivers/postgres'
import {
  connectDriver,
  disconnectDriver,
  resetData,
  rowCounts,
  runAsEditor,
  startAdmin,
  stopAdmin
} from '../support/db'

let connId: string

beforeAll(async () => {
  await startAdmin()
  await resetData()
  connId = await connectDriver(true) // read-only role
})

afterAll(async () => {
  await disconnectDriver(connId)
  await postgresDriver.disconnectAll()
  await stopAdmin()
})

describe('read-only database role', () => {
  it('permits SELECT', async () => {
    const res = await runAsEditor(connId, 'SELECT count(*) FROM customers')
    expect(res.ok).toBe(true)
  })

  it('refuses a direct INSERT with a privilege error, not a read-only error', async () => {
    const before = await rowCounts()
    const res = await runAsEditor(
      connId,
      "INSERT INTO customers (email, full_name) VALUES ('role@example.com', 'Role')"
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('42501') // insufficient_privilege
    expect(await rowCounts()).toEqual(before)
  })

  it('stops the volatile-function write that the session belt cannot see', async () => {
    // Run WITHOUT readOnly: this is what makes the role, not the session, the
    // thing doing the blocking. The belt is off; only the missing privilege
    // stands between the agent and a mutation.
    const before = await rowCounts()
    const res = await runAsEditor(
      connId,
      "SELECT add_customer('role-volatile@example.com', 'RoleVolatile')"
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('42501')
    expect(await rowCounts()).toEqual(before)
  })
})
