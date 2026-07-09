/**
 * Wire types for MCP (Model Context Protocol) server support: shared by the
 * main-process MCP manager, the preload bridge, and the renderer settings UI.
 * Structured-clone friendly.
 *
 * MCP servers are external programs the user configures; their tools operate
 * on external systems with whatever access rights the user granted those
 * programs. They are independent of the database access mode, which governs
 * only the built-in SQL tools against the connected database.
 */

export interface McpServerConfig {
  id: string
  /** Display name; also the namespace segment in tool names shown to the model. */
  name: string
  /** Executable to spawn (e.g. "npx"). */
  command: string
  /** Arguments, one per entry. */
  args: string[]
  /** Extra environment variables for the server process. */
  env: Record<string, string>
  /** Disabled servers are kept configured but never spawned. */
  enabled: boolean
}

export type McpServerState = 'stopped' | 'starting' | 'running' | 'error'

/** A tool as reported by a running server, for display in the settings UI. */
export interface McpToolInfo {
  name: string
  description: string
}

export interface McpServerStatus {
  config: McpServerConfig
  state: McpServerState
  /** Present when state is 'error'. */
  error: string | null
  /** Tools the server advertises; empty unless running. */
  tools: McpToolInfo[]
}
