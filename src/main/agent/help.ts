/**
 * `/help`: the agent's grounded help mode. Builds a system prompt from the
 * feature registry (`src/shared/features.ts`) plus the user guide, and
 * exposes a single tool, `highlight_feature`, so the model can point the
 * renderer at the control it is describing instead of just naming it.
 *
 * A help turn gets exactly this one tool and this prompt builder — no
 * schema, no repo, no MCP. See `buildHelpSystemPrompt`'s call site in
 * `runAgentTurn` (main/agent.ts) for the `intent === 'help'` branch.
 */

import Anthropic from '@anthropic-ai/sdk'

import guideMd from '../../../docs/user-guide.md?raw'
import { FEATURES, featureById } from '../../shared/features'
import type { AgentEvent, AgentSendRequest } from '../../shared/agent'
import type { Sender } from './executors'

export const HIGHLIGHT_FEATURE_TOOL: Anthropic.Tool = {
  name: 'highlight_feature',
  description:
    'Highlight a control in the DB Desk UI so the user can see exactly what you are talking about. Pass the id of an entry from the feature list in the system prompt. Use this whenever you point the user at a specific control.',
  input_schema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description:
          'A registry id from the "## Features" list in the system prompt, e.g. "results.export".'
      }
    },
    required: ['featureId']
  }
}

/** Highlights allowed per help turn; enforced by the `budget` passed to execHighlightFeature. */
export const HELP_HIGHLIGHT_BUDGET = 3

function featuresSection(): string {
  const lines = FEATURES.map((feature) => {
    const shortcut = feature.shortcut ? ` Shortcut: ${feature.shortcut}.` : ''
    return `\`${feature.id}\` — ${feature.title}: ${feature.description}. Location: ${feature.location}.${shortcut}`
  })
  return `## Features\n\n${lines.join('\n')}`
}

export function buildHelpSystemPrompt(): string {
  const role =
    'You are the built-in help for DB Desk, a desktop database client. Answer only questions about using DB Desk. Be concrete: name the control and where it is. Keep answers under ~120 words unless the user asks for a tour. Never write SQL and never claim to have changed anything in the app.'
  const toolRule =
    'When you point the user at a specific control, call `highlight_feature` with its id so the app highlights it. At most 3 highlights per answer. Only use ids from the feature list.'
  return [role, toolRule, featuresSection(), `## User guide\n\n${guideMd}`].join('\n\n')
}

export function execHighlightFeature(
  req: AgentSendRequest,
  block: Anthropic.ToolUseBlock,
  send: Sender,
  budget: { left: number }
): Anthropic.ToolResultBlockParam {
  const base: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: block.id,
    content: ''
  }
  const featureId = String((block.input as { featureId?: unknown }).featureId ?? '').trim()
  const feature = featureId ? featureById(featureId) : undefined
  if (!feature) {
    return { ...base, content: 'Unknown feature id; use one from the list.', is_error: true }
  }
  if (budget.left <= 0) {
    return { ...base, content: 'Highlight limit reached for this answer.', is_error: true }
  }
  budget.left -= 1
  send({
    type: 'tool_start',
    chatId: req.chatId,
    toolId: block.id,
    name: block.name,
    sql: ''
  })
  const uiAction: AgentEvent = {
    type: 'ui_action',
    chatId: req.chatId,
    action: 'spotlight',
    featureId: feature.id
  }
  send(uiAction)
  send({
    type: 'tool_result',
    chatId: req.chatId,
    toolId: block.id,
    ok: true,
    summary: `highlighted ${feature.title}`
  })
  return { ...base, content: `Highlighted ${feature.title} for the user.` }
}
