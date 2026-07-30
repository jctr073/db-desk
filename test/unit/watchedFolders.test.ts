/**
 * Unit tests for the watched-folders sandbox (src/main/watchedFolders.ts),
 * focused on Phase 6's grantExternalPath: a path outside every configured
 * watched folder that main itself just wrote (data export "open after
 * export") must be readable/writable, while an ungranted path outside every
 * root is still refused exactly as before.
 *
 * watchedFolders.ts imports `shell` from electron (revealWatchedFile) and,
 * via settings.ts, `app` (userData-relative settings.json) — mocked the same
 * way repo.test.ts and files.test.ts do it. No watched folders are
 * configured for these tests: settings.json is left absent, so
 * `watchedFolders()` resolves to `[]` and every accepted path here is
 * accepted solely through the grant, not folder-root containment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  },
  shell: { showItemInFolder: vi.fn() }
}))

let watchedFolders: typeof import('../../src/main/watchedFolders')
let scratchDir: string

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-watched-userdata-'))
  scratchDir = mkdtempSync(join(tmpdir(), 'db-desk-watched-scratch-'))
  vi.resetModules()
  watchedFolders = await import('../../src/main/watchedFolders')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(scratchDir, { recursive: true, force: true })
})

describe('grantExternalPath', () => {
  it('lets a granted path be read even though it is outside every watched folder', async () => {
    const path = join(scratchDir, 'exported-results.csv')
    writeFileSync(path, 'a,b\n1,2\n', 'utf8')

    watchedFolders.grantExternalPath(path)

    const content = await watchedFolders.readWatchedFile(path)
    expect(content.content).toBe('a,b\n1,2\n')
  })

  it('lets a granted path be written in place', async () => {
    const path = join(scratchDir, 'exported-results.csv')
    writeFileSync(path, 'a,b\n1,2\n', 'utf8')
    watchedFolders.grantExternalPath(path)

    const read = await watchedFolders.readWatchedFile(path)
    const result = await watchedFolders.writeWatchedFile(path, 'a,b\n3,4\n', read.mtimeMs)

    expect(result.status).toBe('ok')
    const reread = await watchedFolders.readWatchedFile(path)
    expect(reread.content).toBe('a,b\n3,4\n')
  })

  it('still refuses an ungranted path outside every watched folder', async () => {
    const path = join(scratchDir, 'not-granted.csv')
    writeFileSync(path, 'a,b\n1,2\n', 'utf8')

    await expect(watchedFolders.readWatchedFile(path)).rejects.toThrow(
      'Path is outside every watched folder.'
    )
  })

  it('only grants the specific path, not its containing directory', async () => {
    const granted = join(scratchDir, 'granted.csv')
    const sibling = join(scratchDir, 'sibling.csv')
    writeFileSync(granted, 'a,b\n1,2\n', 'utf8')
    writeFileSync(sibling, 'a,b\n5,6\n', 'utf8')

    watchedFolders.grantExternalPath(granted)

    await expect(watchedFolders.readWatchedFile(granted)).resolves.toMatchObject({
      content: 'a,b\n1,2\n'
    })
    await expect(watchedFolders.readWatchedFile(sibling)).rejects.toThrow(
      'Path is outside every watched folder.'
    )
  })
})
