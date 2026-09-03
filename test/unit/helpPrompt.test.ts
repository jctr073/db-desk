import { describe, expect, it } from 'vitest'

import {
  HIGHLIGHT_FEATURE_TOOL,
  buildHelpSystemPrompt,
  execHighlightFeature
} from '../../src/main/agent/help'
import { FEATURES } from '../../src/shared/features'
import type { AgentEvent, AgentSendRequest } from '../../src/shared/agent'

import Anthropic from '@anthropic-ai/sdk'

function toolUseBlock(featureId: unknown): Anthropic.ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_1',
    name: HIGHLIGHT_FEATURE_TOOL.name,
    input: { featureId },
    caller: { type: 'direct' }
  }
}

describe('buildHelpSystemPrompt', () => {
  const prompt = buildHelpSystemPrompt()

  it('contains every feature id in backticks', () => {
    for (const feature of FEATURES) {
      expect(prompt).toContain(`\`${feature.id}\``)
    }
  })

  it('contains a known guide heading and the user guide section', () => {
    expect(prompt).toContain('Export results')
    expect(prompt).toContain('## User guide')
  })
})

describe('execHighlightFeature', () => {
  const req = { chatId: 'c1' } as AgentSendRequest

  it('returns is_error for an unknown id and sends nothing', () => {
    const sent: AgentEvent[] = []
    const budget = { left: 3 }
    const result = execHighlightFeature(
      req,
      toolUseBlock('not.a.real.id'),
      (evt) => sent.push(evt),
      budget
    )
    expect(result.is_error).toBe(true)
    expect(result.content).toBe('Unknown feature id; use one from the list.')
    expect(sent).toHaveLength(0)
    expect(budget.left).toBe(3)
  })

  it('sends tool_start, ui_action, tool_result in order and decrements budget on success', () => {
    const feature = FEATURES[0]
    const sent: AgentEvent[] = []
    const budget = { left: 3 }
    const result = execHighlightFeature(
      req,
      toolUseBlock(feature.id),
      (evt) => sent.push(evt),
      budget
    )
    expect(result.is_error).toBeUndefined()
    expect(sent).toHaveLength(3)
    expect(sent[0]).toMatchObject({
      type: 'tool_start',
      chatId: 'c1',
      toolId: 'tool_1',
      name: HIGHLIGHT_FEATURE_TOOL.name
    })
    expect(sent[1]).toMatchObject({
      type: 'ui_action',
      chatId: 'c1',
      action: 'spotlight',
      featureId: feature.id
    })
    expect(sent[2]).toMatchObject({
      type: 'tool_result',
      chatId: 'c1',
      toolId: 'tool_1',
      ok: true
    })
    expect(budget.left).toBe(2)
  })

  it('returns the limit error without sending when budget is exhausted', () => {
    const feature = FEATURES[0]
    const sent: AgentEvent[] = []
    const budget = { left: 0 }
    const result = execHighlightFeature(
      req,
      toolUseBlock(feature.id),
      (evt) => sent.push(evt),
      budget
    )
    expect(result.is_error).toBe(true)
    expect(result.content).toBe('Highlight limit reached for this answer.')
    expect(sent).toHaveLength(0)
    expect(budget.left).toBe(0)
  })
})
