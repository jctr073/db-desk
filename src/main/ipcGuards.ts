/**
 * Fail-closed runtime validation for IPC payloads whose handlers have
 * filesystem/process/persistence side effects. The contract in
 * src/shared/ipc.ts gives these channels compile-time types, but a
 * compromised or buggy renderer can still send anything over the wire —
 * these guards make malformed payloads throw a descriptive error at the
 * handler boundary instead of persisting garbage or spawning a bad process.
 *
 * Hand-rolled type guards in the house style of src/main/knowledge.ts's
 * validateKnowledgeRecord: plain checks, descriptive throws, no libraries.
 * No electron imports so the guards unit-test without mocks.
 */

import { CONNECTION_TYPES } from '../shared/dialect'
import type { ConnectionType } from '../shared/dialect'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function requireString(value: unknown, what: string): void {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`)
}

function requireNonEmptyString(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} must be a non-empty string`)
  }
}

function requireBoolean(value: unknown, what: string): void {
  if (typeof value !== 'boolean') throw new Error(`${what} must be a boolean`)
}

/** String-typed ConnectParams fields (everything except type/useUrl). */
const CONNECT_PARAM_STRING_FIELDS = [
  'host',
  'port',
  'database',
  'user',
  'password',
  'httpPath',
  'url'
] as const

/**
 * `store:save` payload: persisted to the connection store (and the password
 * into the OS keychain via safeStorage), so every field must be the exact
 * primitive the store expects.
 */
export function validateStoreSavePayload(
  id: unknown,
  name: unknown,
  params: unknown,
  savePassword: unknown
): void {
  requireNonEmptyString(id, 'Connection id')
  requireString(name, 'Connection name')
  requireBoolean(savePassword, 'savePassword')
  if (!isRecord(params)) throw new Error('Connection params must be an object')
  if (
    typeof params.type !== 'string' ||
    !CONNECTION_TYPES.includes(params.type as ConnectionType)
  ) {
    throw new Error(`Unknown connection type: ${String(params.type)}`)
  }
  for (const field of CONNECT_PARAM_STRING_FIELDS) {
    requireString(params[field], `Connection ${field}`)
  }
  requireBoolean(params.useUrl, 'Connection useUrl')
}

/**
 * `store:setSchemaConfig` payload: persisted per connection and steers which
 * catalogs/schemas are introspected.
 */
export function validateSchemaSelectionConfig(id: unknown, config: unknown): void {
  requireNonEmptyString(id, 'Connection id')
  if (!isRecord(config)) throw new Error('Schema selection config must be an object')
  if (config.catalogs !== null && !isStringArray(config.catalogs)) {
    throw new Error('Schema selection catalogs must be null or a string array')
  }
  if (!isRecord(config.schemas)) {
    throw new Error('Schema selection schemas must be an object of catalog to schema names')
  }
  for (const [catalog, schemas] of Object.entries(config.schemas)) {
    if (!isStringArray(schemas)) {
      throw new Error(`Schema selection for catalog ${catalog} must be a string array`)
    }
  }
}

/**
 * `mcp:save` payload: this config is persisted and then SPAWNED as a child
 * process (command + args + env), so it is validated strictly — every field
 * must be present with exactly the declared shape.
 */
export function validateMcpServerConfig(config: unknown): void {
  if (!isRecord(config)) throw new Error('MCP server config must be an object')
  requireNonEmptyString(config.id, 'MCP server id')
  requireNonEmptyString(config.name, 'MCP server name')
  requireNonEmptyString(config.command, 'MCP server command')
  if (!isStringArray(config.args)) throw new Error('MCP server args must be a string array')
  if (!isRecord(config.env)) throw new Error('MCP server env must be an object')
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value !== 'string') {
      throw new Error(`MCP server env value for ${key} must be a string`)
    }
  }
  requireBoolean(config.enabled, 'MCP server enabled')
}
