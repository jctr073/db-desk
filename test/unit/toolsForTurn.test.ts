/**
 * Tool assembly rules for one agent turn (docs/plan-feature-discovery.md
 * §6.3): a help turn gets exactly the highlight tool and nothing that can
 * reach the database, whatever else the request carries.
 */

import { describe, expect, it } from 'vitest'

import { toolsForTurn } from '../../src/main/agent/tools'
import type { ToolsForTurnInput } from '../../src/main/agent/tools'
import { dialectFor } from '../../src/shared/dialect'

const names = (tools: ReturnType<typeof toolsForTurn>): string[] => tools.map((t) => t.name)

const base: ToolsForTurnInput = {
  intent: 'chat',
  hasTarget: true,
  mode: 'read-only',
  dialect: dialectFor('postgres'),
  editorTools: true,
  repoRoot: '/repo',
  mcpTools: [
    { namespacedName: 'mcp__x__y', toolName: 'y', serverName: 'x', inputSchema: { type: 'object' } }
  ],
  webTool: { type: 'web_search_20250305', name: 'web_search' }
}

describe('toolsForTurn', () => {
  it('gives a help turn exactly highlight_feature, ignoring target, repo, MCP and web', () => {
    expect(names(toolsForTurn({ ...base, intent: 'help' }))).toEqual(['highlight_feature'])
  })

  it('offers SQL, editor, knowledge, repo, MCP and web tools on a Read & Run chat turn', () => {
    const got = names(toolsForTurn(base))
    expect(got).toEqual([
      'write_to_editor',
      'read_editor',
      'run_sql',
      'explain_query',
      'describe_table',
      'search_schema',
      'search_knowledge',
      'save_knowledge',
      'list_repo_files',
      'grep_repo',
      'read_repo_file',
      'mcp__x__y',
      'web_search'
    ])
    expect(got).not.toContain('highlight_feature')
  })

  it('withholds execution tools in Metadata Only and knowledge tools without a target', () => {
    expect(
      names(
        toolsForTurn({
          ...base,
          mode: 'metadata',
          hasTarget: false,
          repoRoot: null,
          mcpTools: [],
          webTool: null
        })
      )
    ).toEqual(['write_to_editor', 'read_editor'])
  })
})
