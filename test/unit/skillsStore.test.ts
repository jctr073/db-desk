/**
 * Unit tests for the main-process skills store (src/main/skills.ts).
 *
 * Follows the knowledge.test.ts recipe: Electron's `app` is mocked so
 * `app.getPath('userData')` points at a fresh per-test temp dir, and
 * `vi.resetModules()` + a dynamic re-import gives each test a cold
 * module-level cache. `ipcMain` is stubbed since registerSkillHandlers is
 * not under test here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUILTIN_SKILLS,
  SCAN_CODEBASE_SKILL_ID
} from '../../src/shared/skills'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return userDataDir
    }
  },
  ipcMain: { handle: vi.fn() }
}))

let skills: typeof import('../../src/main/skills')

const scanBuiltin = BUILTIN_SKILLS.find((b) => b.id === SCAN_CODEBASE_SKILL_ID)!

function storeFile(): string {
  return join(userDataDir, 'skills.json')
}

function storedRecords(): Array<{ id: string; connId: string | null }> {
  return JSON.parse(readFileSync(storeFile(), 'utf8')).skills
}

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'dbdesk-skills-'))
  vi.resetModules()
  skills = await import('../../src/main/skills')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('listSkills', () => {
  it('returns the unedited built-ins when nothing is stored', () => {
    const list = skills.listSkills()
    expect(list.map((s) => s.id)).toEqual(BUILTIN_SKILLS.map((b) => b.id))
    expect(list.every((s) => s.builtin && !s.edited)).toBe(true)
  })
})

describe('saveSkill', () => {
  it('mints and updates custom skills', () => {
    const created = skills.saveSkill({
      name: 'Weekly report',
      description: 'd',
      prompt: 'Do the report.',
      connId: 'c-1'
    })
    expect(created.id).toMatch(/^sk-/)
    expect(created.builtin).toBe(false)
    const updated = skills.saveSkill({
      id: created.id,
      name: 'Weekly report v2',
      description: 'd',
      prompt: 'Do the report.',
      connId: null
    })
    expect(updated.name).toBe('Weekly report v2')
    expect(updated.connId).toBeNull()
    expect(skills.listSkills().filter((s) => !s.builtin)).toHaveLength(1)
  })

  it('upserts an update whose record vanished (cascade race) instead of throwing', () => {
    const created = skills.saveSkill({
      name: 'Scoped',
      description: '',
      prompt: 'p',
      connId: 'c-1'
    })
    skills.deleteSkillsForConnection('c-1')
    const saved = skills.saveSkill({
      id: created.id,
      name: 'Scoped',
      description: '',
      prompt: 'p2',
      connId: 'c-1'
    })
    expect(saved.prompt).toBe('p2')
  })

  it('stores a built-in edit as an override flagged edited', () => {
    const saved = skills.saveSkill({
      id: SCAN_CODEBASE_SKILL_ID,
      name: scanBuiltin.name,
      description: scanBuiltin.description,
      prompt: 'My own scan instructions.',
      connId: null
    })
    expect(saved.edited).toBe(true)
    expect(saved.builtin).toBe(true)
    expect(storedRecords()).toHaveLength(1)
  })

  it('drops the override when a built-in is saved back to installed content', () => {
    skills.saveSkill({
      id: SCAN_CODEBASE_SKILL_ID,
      name: scanBuiltin.name,
      description: scanBuiltin.description,
      prompt: 'edited',
      connId: null
    })
    const restored = skills.saveSkill({
      id: SCAN_CODEBASE_SKILL_ID,
      name: scanBuiltin.name,
      description: scanBuiltin.description,
      prompt: scanBuiltin.prompt,
      connId: null
    })
    expect(restored.edited).toBe(false)
    expect(storedRecords()).toHaveLength(0)
  })

  it('rejects malformed input', () => {
    const base = { description: '', prompt: 'p', connId: null }
    expect(() => skills.saveSkill({ ...base, name: '  ' })).toThrow(/name/)
    expect(() => skills.saveSkill({ ...base, name: 'a\nb' })).toThrow(/single/)
    expect(() =>
      skills.saveSkill({ ...base, name: 'ok', prompt: '' })
    ).toThrow(/prompt/)
    expect(() =>
      skills.saveSkill({
        ...base,
        name: 'ok',
        connId: 7 as unknown as string
      })
    ).toThrow(/connId/)
  })
})

describe('removeSkill', () => {
  it('resets an edited built-in to the installed version', () => {
    skills.saveSkill({
      id: SCAN_CODEBASE_SKILL_ID,
      name: scanBuiltin.name,
      description: scanBuiltin.description,
      prompt: 'edited',
      connId: null
    })
    skills.removeSkill(SCAN_CODEBASE_SKILL_ID)
    const scan = skills
      .listSkills()
      .find((s) => s.id === SCAN_CODEBASE_SKILL_ID)
    expect(scan?.edited).toBe(false)
    expect(scan?.prompt).toBe(scanBuiltin.prompt)
  })

  it('deletes a custom skill', () => {
    const created = skills.saveSkill({
      name: 'Custom',
      description: '',
      prompt: 'p',
      connId: null
    })
    skills.removeSkill(created.id)
    expect(skills.listSkills().some((s) => s.id === created.id)).toBe(false)
  })
})

describe('deleteSkillsForConnection', () => {
  it('removes only that connection’s skills', () => {
    skills.saveSkill({ name: 'A', description: '', prompt: 'p', connId: 'c-1' })
    skills.saveSkill({ name: 'B', description: '', prompt: 'p', connId: 'c-2' })
    skills.saveSkill({ name: 'C', description: '', prompt: 'p', connId: null })
    skills.deleteSkillsForConnection('c-1')
    const customs = skills.listSkills().filter((s) => !s.builtin)
    expect(customs.map((s) => s.name).sort()).toEqual(['B', 'C'])
  })
})

describe('load hardening', () => {
  it('quarantines a corrupt file instead of silently overwriting it', () => {
    writeFileSync(storeFile(), '{not json', 'utf8')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(skills.listSkills().every((s) => s.builtin)).toBe(true)
      skills.saveSkill({ name: 'New', description: '', prompt: 'p', connId: null })
    } finally {
      spy.mockRestore()
    }
    const quarantined = readdirSync(userDataDir).filter((f) =>
      f.startsWith('skills.json.corrupt-')
    )
    expect(quarantined).toHaveLength(1)
    expect(
      readFileSync(join(userDataDir, quarantined[0]), 'utf8')
    ).toBe('{not json')
    expect(existsSync(storeFile())).toBe(true)
  })

  it('drops records with empty names/prompts and normalizes built-in override scope', () => {
    const record = {
      description: '',
      createdAt: 1,
      updatedAt: 1
    }
    writeFileSync(
      storeFile(),
      JSON.stringify({
        version: 1,
        skills: [
          { ...record, id: SCAN_CODEBASE_SKILL_ID, name: 'Scan', prompt: '  ', connId: null },
          { ...record, id: 'targeted-scan', name: 'T', prompt: 'p', connId: 'c-9' },
          { ...record, id: 'sk-1', name: '', prompt: 'p', connId: null }
        ]
      }),
      'utf8'
    )
    const list = skills.listSkills()
    // Empty-prompt scan override and empty-name custom are dropped…
    const scan = list.find((s) => s.id === SCAN_CODEBASE_SKILL_ID)
    expect(scan?.edited).toBe(false)
    expect(scan?.prompt).toBe(scanBuiltin.prompt)
    expect(list.some((s) => s.id === 'sk-1')).toBe(false)
    // …and a scoped built-in override is forced back to general-purpose.
    const targeted = list.find((s) => s.id === 'targeted-scan')
    expect(targeted?.edited).toBe(true)
    expect(targeted?.connId).toBeNull()
  })
})
