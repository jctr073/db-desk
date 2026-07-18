/**
 * Wire types, built-in definitions, and pure logic for the skills system:
 * named, editable prompts the agent panel can run as ordinary chat turns.
 * Shared by the main-process store, the preload bridge, and the renderer
 * Skills tab. Structured-clone friendly.
 *
 * Built-in skill bodies live here (not on disk), so the store only holds
 * user edits ("overrides") and custom skills: resetting a built-in is
 * deleting its override, and app upgrades flow through to unedited skills
 * automatically.
 */

import { REPO_SCAN_PROMPT, repoTargetedScanPrompt } from './repo'

/**
 * Placeholder replaced with the user's input when a skill runs. A skill
 * whose prompt has no placeholder gets non-empty input appended instead,
 * so an edit that drops the marker degrades gracefully rather than
 * silently discarding what the user typed.
 */
export const SKILL_ARGS_PLACEHOLDER = '{{args}}'

export const SCAN_CODEBASE_SKILL_ID = 'scan-codebase'
export const TARGETED_SCAN_SKILL_ID = 'targeted-scan'

export interface BuiltinSkillDefinition {
  id: string
  name: string
  description: string
  prompt: string
}

/**
 * One stored record: either a custom skill (`sk-…` id) or a built-in
 * override (id equal to the built-in's id). Built-in overrides are always
 * general-purpose (`connId: null`) — scoping is a custom-skill feature.
 */
export interface StoredSkill {
  id: string
  name: string
  description: string
  prompt: string
  /** null = general purpose; otherwise the connection the skill belongs to. */
  connId: string | null
  createdAt: number
  updatedAt: number
}

/** A resolved skill as the renderer sees it: built-in defaults merged with overrides, plus custom skills. */
export interface Skill {
  id: string
  name: string
  description: string
  prompt: string
  connId: string | null
  /** True when the skill ships with the app (its id is a built-in id). */
  builtin: boolean
  /** True for a built-in whose stored override shadows the installed version. */
  edited: boolean
  updatedAt: number | null
}

/** Payload of skills:save. An absent id mints a new custom skill. */
export interface SkillSaveInput {
  id?: string
  name: string
  description: string
  prompt: string
  connId: string | null
}

export const BUILTIN_SKILLS: BuiltinSkillDefinition[] = [
  {
    id: SCAN_CODEBASE_SKILL_ID,
    name: 'Scan codebase',
    description:
      'Survey the attached codebase and record what it teaches about this database in the knowledge store. Sent by the Knowledge tab’s "Scan codebase" action.',
    prompt: REPO_SCAN_PROMPT
  },
  {
    id: TARGETED_SCAN_SKILL_ID,
    name: 'Targeted scan',
    description: `Follow-up codebase scan scoped to focus instructions (${SKILL_ARGS_PLACEHOLDER}). Sent by the Knowledge tab’s "Targeted scan…" action.`,
    prompt: repoTargetedScanPrompt(SKILL_ARGS_PLACEHOLDER)
  }
]

export function builtinSkillById(id: string): BuiltinSkillDefinition | null {
  return BUILTIN_SKILLS.find((b) => b.id === id) ?? null
}

export function isBuiltinSkillId(id: string): boolean {
  return builtinSkillById(id) !== null
}

/** True when running the skill should collect user input first. */
export function skillHasArgs(prompt: string): boolean {
  return prompt.includes(SKILL_ARGS_PLACEHOLDER)
}

/**
 * Skills that only make sense with the codebase tools available: running
 * them must require an attached repo and force it on for the turn. A
 * property of the skill model, not of the panel that launches it.
 */
export function skillNeedsRepo(id: string): boolean {
  return id === SCAN_CODEBASE_SKILL_ID || id === TARGETED_SCAN_SKILL_ID
}

/**
 * Substitute the user's input into a skill prompt: every placeholder is
 * replaced; a prompt without one gets non-empty input appended as a final
 * paragraph.
 */
export function applySkillArgs(prompt: string, args: string): string {
  const trimmed = args.trim()
  if (skillHasArgs(prompt)) {
    return prompt.split(SKILL_ARGS_PLACEHOLDER).join(trimmed)
  }
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt
}

/**
 * True when a built-in override carries exactly the installed content — the
 * store drops such records instead of keeping a no-op override around.
 */
export function matchesBuiltin(
  builtin: BuiltinSkillDefinition,
  input: Pick<SkillSaveInput, 'name' | 'description' | 'prompt'>
): boolean {
  return (
    input.name === builtin.name &&
    input.description === builtin.description &&
    input.prompt === builtin.prompt
  )
}

/**
 * Merge the installed built-ins with the stored records into the list the
 * UI shows: every built-in exactly once (override winning), then custom
 * skills sorted by name. Pure so it can be unit-tested without Electron.
 */
export function resolveSkills(stored: StoredSkill[]): Skill[] {
  const skills: Skill[] = BUILTIN_SKILLS.map((builtin) => {
    const override = stored.find((s) => s.id === builtin.id)
    return override
      ? {
          id: builtin.id,
          name: override.name,
          description: override.description,
          prompt: override.prompt,
          connId: null,
          builtin: true,
          edited: true,
          updatedAt: override.updatedAt
        }
      : {
          ...builtin,
          connId: null,
          builtin: true,
          edited: false,
          updatedAt: null
        }
  })
  const customs = stored
    .filter((s) => !isBuiltinSkillId(s.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      connId: s.connId,
      builtin: false,
      edited: false,
      updatedAt: s.updatedAt
    }))
  return [...skills, ...customs]
}
