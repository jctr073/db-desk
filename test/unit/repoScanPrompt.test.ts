/**
 * Unit tests for the codebase-scan prompts in src/shared/repo.ts: the full
 * REPO_SCAN_PROMPT and the targeted follow-up variant built by
 * repoTargetedScanPrompt. Both share the recording guide and rules sections,
 * so these tests pin the shared content and the parts that differ.
 */

import { describe, expect, it } from 'vitest'

import { REPO_SCAN_PROMPT, repoTargetedScanPrompt } from '../../src/shared/repo'

const SHARED_LINES = [
  'Record findings with save_knowledge:',
  '- annotation — what a column or table really means',
  'Rules:',
  '- Save only facts that change how a query would be written',
  'Search the knowledge store first (search_knowledge)',
  'Finish with a short summary of what you recorded'
]

describe('REPO_SCAN_PROMPT', () => {
  it('surveys the whole codebase through the source hierarchy', () => {
    expect(REPO_SCAN_PROMPT).toContain('Survey the attached codebase')
    expect(REPO_SCAN_PROMPT).toContain('Work through these sources, most authoritative first:')
    expect(REPO_SCAN_PROMPT).toContain('1. Migrations')
  })

  it('contains the shared recording guide and rules', () => {
    for (const line of SHARED_LINES) {
      expect(REPO_SCAN_PROMPT).toContain(line)
    }
  })
})

describe('repoTargetedScanPrompt', () => {
  const focus = 'Re-read app/services/billing and capture proration rules.'

  it('quotes the trimmed focus text verbatim', () => {
    const text = repoTargetedScanPrompt(`  ${focus}\n`)
    expect(text).toContain(`\n\n${focus}\n\n`)
  })

  it('scopes the survey instead of repeating the full-scan walkthrough', () => {
    const text = repoTargetedScanPrompt(focus)
    expect(text).toContain('targeted follow-up scan')
    expect(text).toContain('Survey only the parts of the codebase relevant')
    expect(text).not.toContain('Work through these sources, most authoritative first:')
  })

  it('tells the agent to reconcile with existing records first', () => {
    const text = repoTargetedScanPrompt(focus)
    expect(text).toContain('Earlier scans already populated the knowledge store')
    expect(text).toContain('update existing records by id')
  })

  it('contains the shared recording guide and rules', () => {
    const text = repoTargetedScanPrompt(focus)
    for (const line of SHARED_LINES) {
      expect(text).toContain(line)
    }
  })
})
