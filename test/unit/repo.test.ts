/**
 * Unit tests for the sandboxed repo-access module (src/main/repo.ts): the
 * lexical path sandbox (resolveRepoPath), the minimal glob compiler
 * (globToRegExp), the sensitive-filename guard (isSensitiveName), the three
 * read-only primitives (listRepoFiles, grepRepo, readRepoFile) against real
 * temp-directory fixtures (including the symlink-escape guards), and the
 * repo-root persistence delegation to the owning knowledge base
 * (getRepoRoot/clearRepoRoot now proxy knowledge.ts's
 * getBaseRepoRoot/setBaseRepoRoot, keyed by kbId, since v2 dropped repo.ts's
 * own per-connection `repo-roots.json`).
 *
 * repo.ts imports `dialog` and `ipcMain` from `electron` at module top (for
 * its IPC helpers, which this file does not exercise) and, via knowledge.ts,
 * `app` for userData-relative persistence. `electron` is mocked the same way
 * knowledge.test.ts and agentKnowledge.test.ts do it — `app.getPath('userData')`
 * resolves to a fresh per-test temp dir — so the sandbox tests below (which
 * never touch persistence) and the new persistence-delegation tests share one
 * mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (): void => {} }
}))

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'db-desk-repo-userdata-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

import {
  globToRegExp,
  grepRepo,
  isSensitiveName,
  listRepoFiles,
  readRepoFile,
  resolveRepoPath
} from '../../src/main/repo'

describe('resolveRepoPath', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'db-desk-repo-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts "." and resolves to the root', () => {
    expect(resolveRepoPath(root, '.')).toBe(root)
  })

  it('accepts empty-ish input as the root', () => {
    expect(resolveRepoPath(root, '')).toBe(root)
  })

  it('accepts nested relative paths', () => {
    expect(resolveRepoPath(root, 'a/b/c.txt')).toBe(join(root, 'a', 'b', 'c.txt'))
  })

  it('accepts a ".." that stays inside the root', () => {
    expect(resolveRepoPath(root, 'a/../b.txt')).toBe(join(root, 'b.txt'))
  })

  it('throws on a simple ".." escape', () => {
    expect(() => resolveRepoPath(root, '../outside')).toThrow(/escapes the repository root/)
  })

  it('throws on a sneaky nested ".." escape', () => {
    expect(() => resolveRepoPath(root, 'a/../../b')).toThrow(/escapes the repository root/)
  })

  it('throws on an absolute path', () => {
    expect(() => resolveRepoPath(root, '/etc/passwd')).toThrow(/must be relative/)
  })

  it('throws on a "~" prefixed path', () => {
    expect(() => resolveRepoPath(root, '~/secrets')).toThrow(/must be relative/)
  })

  it('throws on a Windows drive-letter path', () => {
    expect(() => resolveRepoPath(root, 'C:/x')).toThrow(/must be relative/)
    expect(() => resolveRepoPath(root, 'C:\\x')).toThrow(/must be relative/)
  })

  it('throws on control characters', () => {
    expect(() => resolveRepoPath(root, 'a\x00b')).toThrow(/control characters/)
    expect(() => resolveRepoPath(root, 'a\nb')).toThrow(/control characters/)
    expect(() => resolveRepoPath(root, 'a\x7fb')).toThrow(/control characters/)
  })

  it('throws on a non-string path', () => {
    expect(() => resolveRepoPath(root, undefined as unknown as string)).toThrow(/must be a string/)
  })
})

describe('globToRegExp', () => {
  it('matches "**" across directory separators', () => {
    const re = globToRegExp('db/**/x')
    expect(re.test('db/a/b/x')).toBe(true)
    expect(re.test('db/x')).toBe(true)
  })

  it('does not let "*" cross a "/"', () => {
    const re = globToRegExp('db/*.rb')
    expect(re.test('db/migrate.rb')).toBe(true)
    expect(re.test('db/a/migrate.rb')).toBe(false)
  })

  it('does not let "?" cross a "/"', () => {
    const re = globToRegExp('a?b')
    expect(re.test('axb')).toBe(true)
    expect(re.test('a/b')).toBe(false)
  })

  it('escapes regex metacharacters in the glob', () => {
    const re = globToRegExp('a.b')
    expect(re.test('a.b')).toBe(true)
    expect(re.test('axb')).toBe(false)
  })
})

describe('isSensitiveName', () => {
  it('flags conventional secret filenames', () => {
    expect(isSensitiveName('.env')).toBe(true)
    expect(isSensitiveName('.env.local')).toBe(true)
    expect(isSensitiveName('x.pem')).toBe(true)
    expect(isSensitiveName('x.key')).toBe(true)
    expect(isSensitiveName('id_rsa')).toBe(true)
    expect(isSensitiveName('id_ed25519.pub')).toBe(true)
    expect(isSensitiveName('.npmrc')).toBe(true)
    expect(isSensitiveName('.netrc')).toBe(true)
    expect(isSensitiveName('.pgpass')).toBe(true)
  })

  it('does not flag lookalike source filenames', () => {
    expect(isSensitiveName('env.ts')).toBe(false)
    expect(isSensitiveName('key.ts')).toBe(false)
    expect(isSensitiveName('residency.pem.md')).toBe(false)
  })
})

describe('listRepoFiles', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'db-desk-repo-'))
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'noop\n')
    writeFileSync(join(root, '.env'), 'SECRET=1\n')
    mkdirSync(join(root, 'db', 'migrate'), { recursive: true })
    writeFileSync(join(root, 'db', 'migrate', '001_init.rb'), '-- init\n')
    mkdirSync(join(root, 'app', 'models'), { recursive: true })
    writeFileSync(join(root, 'app', 'models', 'user.rb'), 'class User; end\n')
    writeFileSync(join(root, 'README.md'), '# repo\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns repo-relative POSIX paths', () => {
    return listRepoFiles(root).then((res) => {
      expect(res.files).toContain('README.md')
      expect(res.files).toContain('db/migrate/001_init.rb')
      expect(res.files).toContain('app/models/user.rb')
    })
  })

  it('skips dot-directories', async () => {
    const res = await listRepoFiles(root)
    expect(res.files.some((f) => f.startsWith('.git/'))).toBe(false)
  })

  it('skips ignored directories like node_modules', async () => {
    const res = await listRepoFiles(root)
    expect(res.files.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('skips sensitive files', async () => {
    const res = await listRepoFiles(root)
    expect(res.files).not.toContain('.env')
  })

  it('matches basenames at any depth when the glob has no "/"', async () => {
    const res = await listRepoFiles(root, undefined, '*.rb')
    expect(res.files.sort()).toEqual(['app/models/user.rb', 'db/migrate/001_init.rb'].sort())
  })

  it('scopes the walk to the given dir', async () => {
    const res = await listRepoFiles(root, 'db')
    expect(res.files).toEqual(['db/migrate/001_init.rb'])
  })

  it('throws for a dir outside the root', async () => {
    await expect(listRepoFiles(root, '../outside')).rejects.toThrow(/escapes the repository root/)
  })

  it('throws when dir names a file, not a directory', async () => {
    await expect(listRepoFiles(root, 'README.md')).rejects.toThrow(/Not a directory/)
  })
})

describe('listRepoFiles symlink handling', () => {
  it.skipIf(process.platform === 'win32')(
    'never traverses a symlink pointing outside the root',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'db-desk-repo-'))
      const outside = mkdtempSync(join(tmpdir(), 'db-desk-outside-'))
      try {
        writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
        symlinkSync(outside, join(root, 'escape-link'), 'dir')
        writeFileSync(join(root, 'normal.txt'), 'fine\n')
        const res = await listRepoFiles(root)
        expect(res.files).toEqual(['normal.txt'])
        expect(res.files.some((f) => f.includes('secret'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    }
  )
})

describe('grepRepo', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'db-desk-repo-'))
    writeFileSync(
      join(root, 'a.txt'),
      ['first line', 'needle here', 'NEEDLE upper', 'last line'].join('\n')
    )
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'b.rb'), ['# comment', 'needle in rb'].join('\n'))
    writeFileSync(
      join(root, 'binary.dat'),
      Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65])
    )
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('matches lines with correct 1-based line numbers', async () => {
    const res = await grepRepo(root, 'needle', { glob: 'a.txt' })
    expect(res.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'a.txt', line: 2, text: 'needle here' })
      ])
    )
  })

  it('is case-insensitive by default', async () => {
    const res = await grepRepo(root, 'needle', { glob: 'a.txt' })
    const lines = res.matches.map((m) => m.line)
    expect(lines).toContain(2)
    expect(lines).toContain(3)
  })

  it('respects caseSensitive: true', async () => {
    const res = await grepRepo(root, 'needle', {
      glob: 'a.txt',
      caseSensitive: true
    })
    expect(res.matches.map((m) => m.line)).toEqual([2])
  })

  it('throws a clean error for an invalid regex', async () => {
    await expect(grepRepo(root, '(unterminated')).rejects.toThrow(/Invalid regular expression/)
  })

  it('throws for an empty pattern', async () => {
    await expect(grepRepo(root, '')).rejects.toThrow(/non-empty/)
    await expect(grepRepo(root, '   ')).rejects.toThrow(/non-empty/)
  })

  it('skips binary files', async () => {
    const res = await grepRepo(root, 'eedl')
    expect(res.matches.some((m) => m.path === 'binary.dat')).toBe(false)
  })

  it('respects the glob filter', async () => {
    const res = await grepRepo(root, 'needle', { glob: '*.rb' })
    expect(res.matches).toEqual([expect.objectContaining({ path: 'sub/b.rb', line: 2 })])
  })
})

describe('readRepoFile', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'db-desk-repo-'))
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    writeFileSync(join(root, 'multi.txt'), lines.join('\n'))
    writeFileSync(join(root, '.env'), 'SECRET=1\n')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0x00, 0x01, 0x61, 0x62]))
    mkdirSync(join(root, 'adir'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads the full file when no paging is given', async () => {
    const res = await readRepoFile(root, 'multi.txt')
    expect(res.startLine).toBe(1)
    expect(res.totalLines).toBe(10)
    expect(res.truncated).toBe(false)
    expect(res.content.split('\n')).toHaveLength(10)
  })

  it('pages with offset and limit', async () => {
    const res = await readRepoFile(root, 'multi.txt', 3, 2)
    expect(res.startLine).toBe(3)
    expect(res.totalLines).toBe(10)
    expect(res.truncated).toBe(true)
    expect(res.content.split('\n')).toEqual(['line 3', 'line 4'])
  })

  it('reports not truncated when the limit reaches the end', async () => {
    const res = await readRepoFile(root, 'multi.txt', 8, 3)
    expect(res.truncated).toBe(false)
    expect(res.content.split('\n')).toEqual(['line 8', 'line 9', 'line 10'])
  })

  it('refuses binary files', async () => {
    await expect(readRepoFile(root, 'binary.dat')).rejects.toThrow(/binary/)
  })

  it('refuses sensitive filenames', async () => {
    await expect(readRepoFile(root, '.env')).rejects.toThrow(/credentials/)
  })

  it('refuses directories', async () => {
    await expect(readRepoFile(root, 'adir')).rejects.toThrow(/Is a directory/)
  })

  it('throws for a nonexistent path', async () => {
    await expect(readRepoFile(root, 'nope.txt')).rejects.toThrow()
  })

  it('throws when a symlinked path resolves outside the root', async () => {
    if (process.platform === 'win32') return
    const outside = mkdtempSync(join(tmpdir(), 'db-desk-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
      await expect(readRepoFile(root, 'link.txt')).rejects.toThrow(/resolves outside/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('repo root persistence (delegates to the owning knowledge base)', () => {
  // getRepoRoot/clearRepoRoot no longer own any storage; they proxy
  // knowledge.ts's getBaseRepoRoot/setBaseRepoRoot keyed by kbId. Dynamic
  // import + vi.resetModules() gives each test a cold knowledge-store cache,
  // independent of the statically-imported sandbox functions above.
  let repoMod: typeof import('../../src/main/repo')
  let knowledge: typeof import('../../src/main/knowledge')

  beforeEach(async () => {
    vi.resetModules()
    repoMod = await import('../../src/main/repo')
    knowledge = await import('../../src/main/knowledge')
  })

  it('getRepoRoot reads the root persisted on the base via setBaseRepoRoot', () => {
    const base = knowledge.createBase('Repo base')
    const codeDir = mkdtempSync(join(tmpdir(), 'db-desk-repo-code-'))
    try {
      knowledge.setBaseRepoRoot(base.id, codeDir)
      expect(repoMod.getRepoRoot(base.id)).toBe(codeDir)
    } finally {
      rmSync(codeDir, { recursive: true, force: true })
    }
  })

  it('returns null for a base with no repo root attached', () => {
    const base = knowledge.createBase('Bare base')
    expect(repoMod.getRepoRoot(base.id)).toBeNull()
  })

  it('clearRepoRoot detaches the root without deleting the base', () => {
    const base = knowledge.createBase('Repo base')
    const codeDir = mkdtempSync(join(tmpdir(), 'db-desk-repo-code-'))
    try {
      knowledge.setBaseRepoRoot(base.id, codeDir)
      repoMod.clearRepoRoot(base.id)
      expect(repoMod.getRepoRoot(base.id)).toBeNull()
      expect(knowledge.getBase(base.id)).not.toBeNull()
    } finally {
      rmSync(codeDir, { recursive: true, force: true })
    }
  })

  it('reflects a root that vanished from disk as detached', () => {
    const base = knowledge.createBase('Repo base')
    const codeDir = mkdtempSync(join(tmpdir(), 'db-desk-repo-code-'))
    knowledge.setBaseRepoRoot(base.id, codeDir)
    rmSync(codeDir, { recursive: true, force: true })
    expect(repoMod.getRepoRoot(base.id)).toBeNull()
  })
})
