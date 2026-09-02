/**
 * The feature registry is the source of truth read by the command palette,
 * shortcut sheet, Discover browser, highlight mode, and the agent's /help
 * prompt. These tests keep it internally consistent and in sync with the
 * user guide it points readers at.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMAND_IDS, FEATURES, featureById, slugifyHeading } from '../../src/shared/features'

const guidePath = fileURLToPath(new URL('../../docs/user-guide.md', import.meta.url))
const guide = readFileSync(guidePath, 'utf8')

const guideHeadingSlugs = new Set(
  guide
    .split('\n')
    .filter((line) => /^#{2,3}\s+/.test(line))
    .map((line) => slugifyHeading(line.replace(/^#{2,3}\s+/, '')))
)

describe('FEATURES registry', () => {
  it('has unique ids', () => {
    const ids = FEATURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only references commands declared in COMMAND_IDS', () => {
    const commandIds: readonly string[] = COMMAND_IDS
    for (const feature of FEATURES) {
      if (feature.command) expect(commandIds).toContain(feature.command)
      if (feature.reveal) expect(commandIds).toContain(feature.reveal)
    }
  })

  it('points every guide slug at a real heading in docs/user-guide.md', () => {
    const missing = FEATURES.filter((f) => !guideHeadingSlugs.has(f.guide))
    expect(missing.map((f) => `${f.id} -> ${f.guide}`)).toEqual([])
  })

  it('gives every feature a non-empty location', () => {
    for (const feature of FEATURES) {
      expect(feature.location.trim().length).toBeGreaterThan(0)
    }
  })

  it('keeps shortcuts unique among features that declare one', () => {
    const shortcuts = FEATURES.map((f) => f.shortcut).filter((s): s is string => !!s)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('resolves every anchor to an existing feature id', () => {
    const ids = new Set(FEATURES.map((f) => f.id))
    for (const feature of FEATURES) {
      if (feature.anchor) expect(ids.has(feature.anchor)).toBe(true)
    }
  })

  it('finds a feature by id', () => {
    const feature = featureById('editor.run')
    expect(feature?.title).toBe('Run SQL')
  })

  it('returns undefined for an unknown id', () => {
    expect(featureById('nope.nope')).toBeUndefined()
  })
})

describe('slugifyHeading', () => {
  it('slugifies a heading with commas', () => {
    expect(slugifyHeading('Sessions, web search, and context size')).toBe(
      'sessions-web-search-and-context-size'
    )
  })

  it('slugifies a plain heading', () => {
    expect(slugifyHeading('Read and manage results')).toBe('read-and-manage-results')
  })
})
