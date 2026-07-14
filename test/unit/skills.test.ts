/**
 * Unit tests for src/shared/skills.ts: the built-in skill definitions (which
 * wrap the codebase-scan prompts), the {{args}} substitution rules, and the
 * pure store-resolution logic the main process serves over skills:list.
 */

import { describe, expect, it } from 'vitest'

import { REPO_SCAN_PROMPT, repoTargetedScanPrompt } from '../../src/shared/repo'
import {
  BUILTIN_SKILLS,
  SCAN_CODEBASE_SKILL_ID,
  SKILL_ARGS_PLACEHOLDER,
  TARGETED_SCAN_SKILL_ID,
  applySkillArgs,
  builtinSkillById,
  isBuiltinSkillId,
  matchesBuiltin,
  resolveSkills,
  skillHasArgs
} from '../../src/shared/skills'
import type { StoredSkill } from '../../src/shared/skills'

function stored(overrides: Partial<StoredSkill>): StoredSkill {
  return {
    id: 'sk-1',
    name: 'Custom',
    description: '',
    prompt: 'Do the thing.',
    connId: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

describe('BUILTIN_SKILLS', () => {
  it('ships the codebase-scan prompt verbatim as a skill', () => {
    const scan = builtinSkillById(SCAN_CODEBASE_SKILL_ID)
    expect(scan?.prompt).toBe(REPO_SCAN_PROMPT)
  })

  it('ships the targeted scan as a template with an args placeholder', () => {
    const targeted = builtinSkillById(TARGETED_SCAN_SKILL_ID)
    expect(targeted).not.toBeNull()
    expect(skillHasArgs(targeted!.prompt)).toBe(true)
    // Substituting a focus must reproduce the original prompt exactly, so
    // the skill and the pre-skills scan flow can never drift.
    const focus = 'Re-read app/services/billing and capture proration rules.'
    expect(applySkillArgs(targeted!.prompt, focus)).toBe(
      repoTargetedScanPrompt(focus)
    )
  })

  it('has unique ids that isBuiltinSkillId recognizes', () => {
    const ids = BUILTIN_SKILLS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isBuiltinSkillId(id)).toBe(true)
    expect(isBuiltinSkillId('sk-123')).toBe(false)
  })
})

describe('applySkillArgs', () => {
  it('replaces every placeholder occurrence with the trimmed input', () => {
    const prompt = `A ${SKILL_ARGS_PLACEHOLDER} B ${SKILL_ARGS_PLACEHOLDER}`
    expect(applySkillArgs(prompt, '  x  ')).toBe('A x B x')
  })

  it('appends non-empty input when the prompt has no placeholder', () => {
    expect(applySkillArgs('Do it.', 'with feeling')).toBe(
      'Do it.\n\nwith feeling'
    )
  })

  it('leaves a placeholder-free prompt alone on empty input', () => {
    expect(applySkillArgs('Do it.', '   ')).toBe('Do it.')
  })
})

describe('resolveSkills', () => {
  it('returns every built-in unedited when nothing is stored', () => {
    const skills = resolveSkills([])
    expect(skills.map((s) => s.id)).toEqual(BUILTIN_SKILLS.map((b) => b.id))
    for (const s of skills) {
      expect(s.builtin).toBe(true)
      expect(s.edited).toBe(false)
      expect(s.connId).toBeNull()
    }
  })

  it('lets a stored override shadow a built-in, flagged as edited', () => {
    const override = stored({
      id: SCAN_CODEBASE_SKILL_ID,
      name: 'Scan codebase',
      prompt: 'My own scan instructions.'
    })
    const scan = resolveSkills([override]).find(
      (s) => s.id === SCAN_CODEBASE_SKILL_ID
    )
    expect(scan?.prompt).toBe('My own scan instructions.')
    expect(scan?.builtin).toBe(true)
    expect(scan?.edited).toBe(true)
  })

  it('appends custom skills sorted by name after the built-ins', () => {
    const skills = resolveSkills([
      stored({ id: 'sk-b', name: 'Zeta', connId: 'c-1' }),
      stored({ id: 'sk-a', name: 'Alpha' })
    ])
    const customs = skills.filter((s) => !s.builtin)
    expect(customs.map((s) => s.name)).toEqual(['Alpha', 'Zeta'])
    expect(customs[1].connId).toBe('c-1')
    expect(skills.slice(0, BUILTIN_SKILLS.length).every((s) => s.builtin)).toBe(
      true
    )
  })
})

describe('matchesBuiltin', () => {
  it('detects a save that restores the installed content exactly', () => {
    const scan = builtinSkillById(SCAN_CODEBASE_SKILL_ID)!
    expect(
      matchesBuiltin(scan, {
        name: scan.name,
        description: scan.description,
        prompt: scan.prompt
      })
    ).toBe(true)
    expect(
      matchesBuiltin(scan, {
        name: scan.name,
        description: scan.description,
        prompt: scan.prompt + '!'
      })
    ).toBe(false)
  })
})
