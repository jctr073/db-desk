/**
 * Main-process skills store: persists custom skills and edits ("overrides")
 * of the built-in skills as JSON under userData, following the house pattern
 * of repo.ts/knowledge.ts (module cache, load/persist, tmp+rename writes).
 * Built-in skill bodies live in shared/skills.ts, so only user-authored
 * content is on disk: "Reset to installed" deletes the override, and app
 * upgrades reach every unedited skill automatically.
 *
 * The renderer talks to it through `skills:*` IPC handles and receives a
 * `skills:changed` push after every mutation — including the cascade delete
 * that runs when a connection is removed.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomicJson'

import { app } from 'electron'
import type { BrowserWindow } from 'electron'

import { typedHandle, typedSend } from './ipc'

import { builtinSkillById, isBuiltinSkillId, matchesBuiltin, resolveSkills } from '../shared/skills'
import type { Skill, SkillSaveInput, StoredSkill } from '../shared/skills'
import { log } from './log'

/** Current on-disk file format version. */
const FILE_VERSION = 1

/** Generous content caps: a scan prompt is ~3k chars; these only stop abuse. */
const NAME_MAX_CHARS = 120
const DESCRIPTION_MAX_CHARS = 1_000
const PROMPT_MAX_CHARS = 100_000

interface SkillsFile {
  version: number
  skills: StoredSkill[]
}

let cache: StoredSkill[] | null = null

/** Set by registerSkillHandlers; mutations push skills:changed through it. */
let notifyChanged: (() => void) | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'skills.json')
}

function isStoredSkill(value: unknown): value is StoredSkill {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    s.id !== '' &&
    // Same floor as save-time validation: a record with an empty name or
    // prompt (hand edit, sync conflict) would otherwise shadow a built-in
    // with an empty override and silently no-op the scan actions.
    typeof s.name === 'string' &&
    s.name.trim() !== '' &&
    typeof s.description === 'string' &&
    typeof s.prompt === 'string' &&
    s.prompt.trim() !== '' &&
    (s.connId === null || typeof s.connId === 'string') &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number'
  )
}

/**
 * A file we cannot read as `{ skills: [...] }` must never be silently treated
 * as empty: the next save would persist over it and destroy every skill the
 * user authored. Move it aside instead (same rule as the knowledge store).
 */
function quarantineCorruptFile(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    // Rename failed (permissions?): leave the file; loading still returns
    // empty, and the non-atomic-overwrite risk is the lesser evil here.
  }
}

function load(): StoredSkill[] {
  if (cache) return cache
  let records: StoredSkill[] = []
  const path = storePath()
  if (existsSync(path)) {
    let skills: unknown
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      skills = (parsed as SkillsFile | null)?.skills
    } catch {
      skills = undefined
    }
    if (Array.isArray(skills)) {
      records = skills
        .filter(isStoredSkill)
        // A built-in override is always general-purpose; a hand-edited
        // scope would otherwise hide the built-in from resolveSkills.
        .map((s) => (isBuiltinSkillId(s.id) && s.connId !== null ? { ...s, connId: null } : s))
    } else {
      log.error('skills', `unreadable file quarantined: ${path}`)
      quarantineCorruptFile(path)
    }
  }
  cache = records
  return cache
}

function persist(records: StoredSkill[]): void {
  cache = records
  const file: SkillsFile = { version: FILE_VERSION, skills: records }
  // Atomic write: prompts are user-authored content a crash mid-write must
  // not truncate (same rule as the knowledge store).
  writeJsonAtomic(storePath(), file)
  notifyChanged?.()
}

function generateId(): string {
  return `sk-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** No real name/description belongs on multiple lines. */
// eslint-disable-next-line no-control-regex -- filtering control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Throws unless `input` is a well-formed skills:save payload. */
function validateSkillInput(input: unknown): asserts input is SkillSaveInput {
  if (!input || typeof input !== 'object') {
    throw new Error('Skill must be an object')
  }
  const s = input as Record<string, unknown>
  if (s.id !== undefined && (typeof s.id !== 'string' || s.id === '')) {
    throw new Error('Skill id must be a non-empty string when present')
  }
  if (typeof s.name !== 'string' || s.name.trim() === '') {
    throw new Error('Skill name must be a non-empty string')
  }
  if (s.name.length > NAME_MAX_CHARS || CONTROL_CHARS.test(s.name)) {
    throw new Error('Skill name must be a single short line')
  }
  if (
    typeof s.description !== 'string' ||
    s.description.length > DESCRIPTION_MAX_CHARS ||
    CONTROL_CHARS.test(s.description)
  ) {
    throw new Error('Skill description must be a single line')
  }
  if (typeof s.prompt !== 'string' || s.prompt.trim() === '') {
    throw new Error('Skill prompt must be a non-empty string')
  }
  if (s.prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`Skill prompt too long (max ${PROMPT_MAX_CHARS.toLocaleString()} characters)`)
  }
  if (s.connId !== null && typeof s.connId !== 'string') {
    throw new Error('Skill connId must be a string or null')
  }
}

// --- Public API --------------------------------------------------------------

export function listSkills(): Skill[] {
  return resolveSkills(load())
}

/**
 * Create or update a skill. A built-in id upserts an override — unless the
 * content matches the installed version exactly, in which case any override
 * is dropped (saving the installed text back IS a reset). A present custom
 * id updates in place; an absent id mints a new custom skill.
 */
export function saveSkill(input: SkillSaveInput): Skill {
  validateSkillInput(input)
  const records = load().filter((r) => r.id !== input.id)
  const prev = load().find((r) => r.id === input.id)
  const now = Date.now()
  let id: string
  const builtin = input.id ? builtinSkillById(input.id) : null
  if (input.id && builtin) {
    id = input.id
    if (!matchesBuiltin(builtin, input)) {
      records.push({
        id,
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        connId: null, // built-ins are general-purpose; scope is not editable
        createdAt: prev?.createdAt ?? now,
        updatedAt: now
      })
    }
  } else if (input.id) {
    // Upsert rather than reject a missing id: the record may have been
    // removed while the editor was open (e.g. the connection-delete
    // cascade); throwing here would strand the user's draft.
    id = input.id
    records.push({
      id,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      connId: input.connId,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    })
  } else {
    id = generateId()
    records.push({
      id,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      connId: input.connId,
      createdAt: now,
      updatedAt: now
    })
  }
  persist(records)
  const saved = listSkills().find((s) => s.id === id)
  if (!saved) throw new Error('Skill not found after save')
  return saved
}

/**
 * Delete a stored record. For a custom skill this removes it; for a built-in
 * id it deletes the override — i.e. "Reset to installed version".
 */
export function removeSkill(id: string): void {
  const records = load()
  const next = records.filter((r) => r.id !== id)
  if (next.length !== records.length) persist(next)
}

/** Cascade for store:delete — a removed connection takes its skills with it. */
export function deleteSkillsForConnection(connId: string): void {
  const records = load()
  const next = records.filter((r) => r.connId !== connId)
  if (next.length !== records.length) persist(next)
}

// --- IPC ----------------------------------------------------------------------

export function registerSkillHandlers(getWindow: () => BrowserWindow | null): void {
  notifyChanged = () => {
    typedSend(getWindow(), 'skills:changed')
  }
  typedHandle('skills:list', () => listSkills())
  typedHandle('skills:save', (_event, input) => saveSkill(input))
  typedHandle('skills:delete', (_event, id) => removeSkill(id))
}
