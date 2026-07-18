/**
 * Unit tests for monorepo knowledge-base support: the folder scope on a base
 * (`subPath` — knowledge.ts joins it onto `repoRoot` and fails closed on
 * escapes), the service-folder candidate listing (repo.ts), the pick →
 * mapping-creation flow (registerMonorepoPick / createMonorepoMappings,
 * including base reuse on re-runs), and the folder ↔ schema auto-match
 * heuristic (shared/repo.ts suggestSchema).
 *
 * Same harness as knowledge.test.ts / repo.test.ts: `electron` is mocked so
 * `app.getPath('userData')` resolves to a per-test temp dir, and the
 * main-process modules are re-imported per test (vi.resetModules) because
 * both the knowledge store and the monorepo pick slot hold module-level
 * state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { suggestSchema } from '../../src/shared/repo'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (): void => {} }
}))

let knowledge: typeof import('../../src/main/knowledge')
let repo: typeof import('../../src/main/repo')
let repoDir: string

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-monorepo-userdata-'))
  repoDir = mkdtempSync(join(tmpdir(), 'db-desk-monorepo-repo-'))
  vi.resetModules()
  knowledge = await import('../../src/main/knowledge')
  repo = await import('../../src/main/repo')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

describe('subPath on setBaseRepoRoot / getBaseRepoRoot', () => {
  it('joins root and subPath into the effective codebase root', () => {
    mkdirSync(join(repoDir, 'services', 'billing'), { recursive: true })
    const base = knowledge.createBase('mono/billing')
    knowledge.setBaseRepoRoot(base.id, repoDir, join('services', 'billing'))
    expect(knowledge.getBaseRepoRoot(base.id)).toBe(join(repoDir, 'services', 'billing'))
  })

  it('persists subPath on the base record', () => {
    mkdirSync(join(repoDir, 'billing'))
    const base = knowledge.createBase('mono/billing')
    knowledge.setBaseRepoRoot(base.id, repoDir, 'billing')
    expect(knowledge.getBase(base.id)?.subPath).toBe('billing')
  })

  it('re-picking a root without subPath clears the folder scope', () => {
    mkdirSync(join(repoDir, 'billing'))
    const base = knowledge.createBase('mono/billing')
    knowledge.setBaseRepoRoot(base.id, repoDir, 'billing')
    knowledge.setBaseRepoRoot(base.id, repoDir)
    expect(knowledge.getBase(base.id)?.subPath).toBeNull()
    expect(knowledge.getBaseRepoRoot(base.id)).toBe(repoDir)
  })

  it.each(['../outside', '/etc', '~x', ''])('rejects unsafe subPath %j', (subPath) => {
    const base = knowledge.createBase('bad')
    expect(() => knowledge.setBaseRepoRoot(base.id, repoDir, subPath)).toThrow(
      /Invalid monorepo folder/
    )
  })

  it('rejects a subPath without a root', () => {
    const base = knowledge.createBase('bad')
    expect(() => knowledge.setBaseRepoRoot(base.id, null, 'billing')).toThrow(
      /requires a repo root/
    )
  })

  it('reads as detached when the service folder vanished', () => {
    mkdirSync(join(repoDir, 'billing'))
    const base = knowledge.createBase('mono/billing')
    knowledge.setBaseRepoRoot(base.id, repoDir, 'billing')
    rmSync(join(repoDir, 'billing'), { recursive: true })
    expect(knowledge.getBaseRepoRoot(base.id)).toBeNull()
  })

  it('fails closed on a hand-edited subPath that escapes the root', () => {
    const base = knowledge.createBase('tampered')
    knowledge.setBaseRepoRoot(base.id, repoDir)
    const path = join(userDataDir, 'knowledge', 'bases', `${base.id}.json`)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.base.subPath = '../../etc'
    writeFileSync(path, JSON.stringify(file), 'utf8')
    // Cold cache so the tampered file is actually re-read.
    vi.resetModules()
    return import('../../src/main/knowledge').then((cold) => {
      expect(cold.getBaseRepoRoot(base.id)).toBeNull()
    })
  })
})

describe('listMonorepoFolders', () => {
  it('lists plain child directories sorted, excluding dot/vendored/symlinks/files', async () => {
    mkdirSync(join(repoDir, 'checkout'))
    mkdirSync(join(repoDir, 'billing'))
    mkdirSync(join(repoDir, '.github'))
    mkdirSync(join(repoDir, 'node_modules'))
    writeFileSync(join(repoDir, 'README.md'), 'hi')
    symlinkSync(join(repoDir, 'billing'), join(repoDir, 'billing-link'))
    await expect(repo.listMonorepoFolders(repoDir)).resolves.toEqual(['billing', 'checkout'])
  })
})

describe('createMonorepoMappings', () => {
  const target = { connId: 'conn-1', database: 'app_db' }

  function seedRepo(...folders: string[]): ReturnType<typeof repo.registerMonorepoPick> {
    for (const folder of folders) mkdirSync(join(repoDir, folder))
    return repo.registerMonorepoPick(repoDir, folders)
  }

  it('creates one base + link per mapping, scoped to its folder', () => {
    const pick = seedRepo('billing', 'checkout')
    const result = repo.createMonorepoMappings({
      pickId: pick.pickId,
      ...target,
      mappings: [
        { folder: 'billing', schema: 'billing', name: 'mono/billing' },
        { folder: 'checkout', schema: 'checkout', name: 'mono/checkout' }
      ]
    })
    expect(result).toMatchObject({ created: 2, reused: 0 })
    expect(result.kbIds).toHaveLength(2)
    const bases = knowledge.listBases()
    expect(bases.map((b) => [b.name, b.repoRoot, b.subPath])).toEqual([
      ['mono/billing', repoDir, 'billing'],
      ['mono/checkout', repoDir, 'checkout']
    ])
    const links = knowledge.linksForTarget(target.connId, target.database)
    expect(links.map((l) => [l.kbId, l.schema])).toEqual([
      [result.kbIds[0], 'billing'],
      [result.kbIds[1], 'checkout']
    ])
    expect(knowledge.getBaseRepoRoot(result.kbIds[0])).toBe(join(repoDir, 'billing'))
  })

  it('reuses the existing base for an already-mapped folder', () => {
    const pick = seedRepo('billing')
    const first = repo.createMonorepoMappings({
      pickId: pick.pickId,
      ...target,
      mappings: [{ folder: 'billing', schema: 'billing', name: 'mono/billing' }]
    })
    // Same folder again — different schema this time (e.g. staging schema).
    const again = repo.createMonorepoMappings({
      pickId: pick.pickId,
      ...target,
      mappings: [{ folder: 'billing', schema: 'billing_stage', name: 'ignored' }]
    })
    expect(again).toMatchObject({ created: 0, reused: 1 })
    expect(again.kbIds).toEqual(first.kbIds)
    expect(knowledge.listBases()).toHaveLength(1)
    const links = knowledge.linksForTarget(target.connId, target.database)
    expect(links.map((l) => l.schema).sort()).toEqual(['billing', 'billing_stage'])
  })

  it('does not duplicate a base when one batch names a folder twice', () => {
    const pick = seedRepo('billing')
    const result = repo.createMonorepoMappings({
      pickId: pick.pickId,
      ...target,
      mappings: [
        { folder: 'billing', schema: 'a', name: 'mono/billing' },
        { folder: 'billing', schema: 'b', name: 'mono/billing' }
      ]
    })
    expect(result).toMatchObject({ created: 1, reused: 1 })
    expect(knowledge.listBases()).toHaveLength(1)
  })

  it('rejects folders that are not part of the pick', () => {
    const pick = seedRepo('billing')
    expect(() =>
      repo.createMonorepoMappings({
        pickId: pick.pickId,
        ...target,
        mappings: [{ folder: '../etc', schema: 'x', name: 'x' }]
      })
    ).toThrow(/Not a folder of the picked root/)
  })

  it('rejects a stale pickId', () => {
    const pick = seedRepo('billing')
    repo.registerMonorepoPick(repoDir, ['billing']) // newer pick supersedes
    expect(() =>
      repo.createMonorepoMappings({
        pickId: pick.pickId,
        ...target,
        mappings: [{ folder: 'billing', schema: 'x', name: 'x' }]
      })
    ).toThrow(/expired/)
  })
})

describe('suggestSchema', () => {
  const schemas = ['billing', 'checkout_flow', 'Warehouse', 'identity']

  it('matches exact names', () => {
    expect(suggestSchema('billing', schemas)).toBe('billing')
  })

  it('matches case- and separator-insensitively', () => {
    expect(suggestSchema('Checkout-Flow', schemas)).toBe('checkout_flow')
    expect(suggestSchema('warehouse', schemas)).toBe('Warehouse')
  })

  it('strips common service suffixes as a fallback', () => {
    expect(suggestSchema('billing-service', schemas)).toBe('billing')
    expect(suggestSchema('identity_svc', schemas)).toBe('identity')
  })

  it('returns null when nothing matches', () => {
    expect(suggestSchema('frontend', schemas)).toBeNull()
    expect(suggestSchema('svc', schemas)).toBeNull()
  })
})
