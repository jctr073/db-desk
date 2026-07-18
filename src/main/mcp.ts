/**
 * Main-process MCP manager: persists user-configured MCP servers, spawns
 * them as stdio child processes, and exposes their tools to the agent loop.
 * The renderer talks to it through `mcp:*` IPC handles and receives status
 * updates as `mcp:changed` pushes.
 *
 * MCP tools run against external systems with whatever rights the user
 * granted the server; they are deliberately outside the database access-mode
 * guard, which protects only the connected database via the built-in SQL
 * tools.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomicJson'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { app, safeStorage } from 'electron'
import type { BrowserWindow } from 'electron'

import { typedHandle, typedSend } from './ipc'
import { validateMcpServerConfig } from './ipcGuards'

import type { McpServerConfig, McpServerState, McpServerStatus, McpToolInfo } from '../shared/mcp'
import { log } from './log'

/** Ceiling on one MCP tool call; slow servers should not wedge a turn. */
const MCP_CALL_TIMEOUT_MS = 60_000
/** Ceiling on connect + tool listing at server startup. */
const MCP_START_TIMEOUT_MS = 20_000

/**
 * On-disk shape of a configured server. `envSecret` holds the JSON-encoded
 * env map encrypted with safeStorage (env values are often access tokens);
 * `env` is the plaintext fallback used only when encryption is unavailable.
 */
interface StoredRecord {
  id: string
  name: string
  command: string
  args: string[]
  envSecret?: string
  env?: Record<string, string>
  enabled: boolean
}

let cache: StoredRecord[] | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'mcp-servers.json')
}

function load(): StoredRecord[] {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf8'))
    cache = Array.isArray(parsed) ? (parsed as StoredRecord[]) : []
  } catch {
    cache = []
  }
  return cache
}

function persist(records: StoredRecord[]): void {
  cache = records
  // Owner-only: env values are frequently access tokens.
  writeJsonAtomic(storePath(), records, { mode: 0o600 })
}

function encryptEnv(env: Record<string, string>): Pick<StoredRecord, 'envSecret' | 'env'> {
  if (Object.keys(env).length === 0) return {}
  if (!safeStorage.isEncryptionAvailable()) return { env }
  return {
    envSecret: safeStorage.encryptString(JSON.stringify(env)).toString('base64')
  }
}

function decryptEnv(record: StoredRecord): Record<string, string> {
  if (record.envSecret) {
    try {
      const parsed: unknown = JSON.parse(
        safeStorage.decryptString(Buffer.from(record.envSecret, 'base64'))
      )
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, string>
      }
    } catch {
      // fall through — treat an undecryptable blob as no env
    }
    return {}
  }
  return record.env ?? {}
}

function toConfig(record: StoredRecord): McpServerConfig {
  return {
    id: record.id,
    name: record.name,
    command: record.command,
    args: record.args,
    env: decryptEnv(record),
    enabled: record.enabled
  }
}

interface Runtime {
  client: Client | null
  state: McpServerState
  error: string | null
  tools: McpToolInfo[]
  /** Tool name → input schema, for building the agent's tool array. */
  schemas: Map<string, Record<string, unknown>>
  /** Guards against concurrent starts of the same server. */
  starting: Promise<void> | null
}

const runtimes = new Map<string, Runtime>()

/** Set by registerMcpHandlers; pushes statuses to the renderer on change. */
let notify: (() => void) | null = null

function getRuntime(id: string): Runtime {
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      client: null,
      state: 'stopped',
      error: null,
      tools: [],
      schemas: new Map(),
      starting: null
    }
    runtimes.set(id, rt)
  }
  return rt
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

async function startServer(config: McpServerConfig): Promise<void> {
  const rt = getRuntime(config.id)
  if (rt.starting) return rt.starting
  if (rt.state === 'running') return
  rt.state = 'starting'
  rt.error = null
  notify?.()

  const run = async (): Promise<void> => {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: 'ignore'
    })
    const client = new Client({ name: 'db-desk', version: app.getVersion() })
    await withTimeout(
      client.connect(transport),
      MCP_START_TIMEOUT_MS,
      `Connecting to "${config.name}"`
    )
    const listed = await withTimeout(
      client.listTools(),
      MCP_START_TIMEOUT_MS,
      `Listing tools of "${config.name}"`
    )
    rt.client = client
    rt.state = 'running'
    rt.tools = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? ''
    }))
    rt.schemas = new Map(
      listed.tools.map((t) => [t.name, t.inputSchema as Record<string, unknown>])
    )
    // A server that exits (or is killed) should read as stopped, not running.
    client.onclose = () => {
      if (rt.client !== client) return
      rt.client = null
      rt.tools = []
      rt.schemas = new Map()
      if (rt.state === 'running') rt.state = 'stopped'
      notify?.()
    }
  }

  rt.starting = run()
    .catch((err: unknown) => {
      log.error('mcp', `server "${config.name}" failed to start`, err)
      rt.client = null
      rt.state = 'error'
      rt.error = err instanceof Error ? err.message : String(err)
      rt.tools = []
      rt.schemas = new Map()
    })
    .finally(() => {
      rt.starting = null
      notify?.()
    })
  return rt.starting
}

async function stopServer(id: string): Promise<void> {
  const rt = runtimes.get(id)
  if (!rt) return
  const client = rt.client
  rt.client = null
  rt.state = 'stopped'
  rt.error = null
  rt.tools = []
  rt.schemas = new Map()
  if (client) {
    try {
      await client.close()
    } catch {
      // already gone
    }
  }
  notify?.()
}

/** Start every enabled server that is not already running. */
export function startEnabledServers(): void {
  for (const record of load()) {
    if (record.enabled) void startServer(toConfig(record))
  }
}

export async function stopAllMcpServers(): Promise<void> {
  await Promise.all([...runtimes.keys()].map((id) => stopServer(id)))
}

export function listMcpStatuses(): McpServerStatus[] {
  return load().map((record) => {
    const rt = runtimes.get(record.id)
    return {
      config: toConfig(record),
      state: rt?.state ?? 'stopped',
      error: rt?.error ?? null,
      tools: rt?.tools ?? []
    }
  })
}

async function saveServer(config: McpServerConfig): Promise<void> {
  const record: StoredRecord = {
    id: config.id,
    name: config.name,
    command: config.command,
    args: config.args,
    enabled: config.enabled,
    ...encryptEnv(config.env)
  }
  const records = [...load()]
  const index = records.findIndex((existing) => existing.id === config.id)
  if (index >= 0) records[index] = record
  else records.push(record)
  persist(records)
  // Apply immediately: a config edit restarts the server with the new shape.
  await stopServer(config.id)
  if (config.enabled) await startServer(config)
}

async function deleteServer(id: string): Promise<void> {
  await stopServer(id)
  runtimes.delete(id)
  persist(load().filter((record) => record.id !== id))
}

/** Only characters the Anthropic API accepts in tool names. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface McpAgentTool {
  /** Namespaced name presented to the model: mcp__<server>__<tool>. */
  namespacedName: string
  serverId: string
  serverName: string
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Tools of all currently running servers, namespaced for the agent turn. */
export function mcpToolsForTurn(): McpAgentTool[] {
  const out: McpAgentTool[] = []
  const taken = new Set<string>()
  for (const record of load()) {
    const rt = runtimes.get(record.id)
    if (!rt || rt.state !== 'running') continue
    for (const tool of rt.tools) {
      let name = `mcp__${sanitizeName(record.name)}__${sanitizeName(tool.name)}`.slice(0, 64)
      // Same-named servers/tools are legal in config; tool names must not be.
      let n = 2
      while (taken.has(name)) name = `${name.slice(0, 60)}_${n++}`
      taken.add(name)
      out.push({
        namespacedName: name,
        serverId: record.id,
        serverName: record.name,
        toolName: tool.name,
        description: tool.description,
        inputSchema: rt.schemas.get(tool.name) ?? { type: 'object' }
      })
    }
  }
  return out
}

export interface McpCallResult {
  ok: boolean
  /** Flattened text content (or the error message when ok is false). */
  text: string
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const rt = runtimes.get(serverId)
  const client = rt?.client
  if (!client || rt.state !== 'running') {
    return { ok: false, text: 'The MCP server for this tool is not running.' }
  }
  try {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: MCP_CALL_TIMEOUT_MS
    })
    const blocks = Array.isArray(result.content) ? result.content : []
    const parts: string[] = []
    for (const block of blocks) {
      if (block.type === 'text') parts.push(block.text)
      else parts.push(`(${block.type} content omitted)`)
    }
    const text = parts.join('\n') || '(empty result)'
    return { ok: result.isError !== true, text }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

export function registerMcpHandlers(getWindow: () => BrowserWindow | null): void {
  notify = () => {
    typedSend(getWindow(), 'mcp:changed', listMcpStatuses())
  }

  typedHandle('mcp:list', (): McpServerStatus[] => listMcpStatuses())

  typedHandle('mcp:save', async (_event, config) => {
    // This config is persisted and spawned as a child process; validate it
    // strictly at the boundary rather than trusting the renderer payload.
    validateMcpServerConfig(config)
    await saveServer(config)
    return listMcpStatuses()
  })

  typedHandle('mcp:delete', async (_event, id) => {
    await deleteServer(id)
    return listMcpStatuses()
  })

  typedHandle('mcp:restart', async (_event, id) => {
    const record = load().find((candidate) => candidate.id === id)
    if (!record) return listMcpStatuses()
    await stopServer(id)
    await startServer(toConfig(record))
    return listMcpStatuses()
  })

  startEnabledServers()
}
