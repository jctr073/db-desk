/**
 * App-wide settings store (settings.json in userData) and the single API-key
 * resolver used by every Anthropic client in the main process.
 *
 * Key resolution order: a key stored in-app (encrypted with Electron's
 * safeStorage, OS keychain-backed) wins; otherwise the configured shell
 * variable is looked up in ~/.zshrc, then in the process environment.
 */

import { app, safeStorage } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomicJson'
import { API_KEY_VAR } from '../shared/agent'
import { isValidVarName } from '../shared/settings'
import type { ApiKeyConfig, ApiKeySource, AppSettingsInfo } from '../shared/settings'

interface StoredSettings {
  /** Absent = the default userData/queries directory. */
  sqlFilesDir?: string
  /** Absent = API_KEY_VAR (CLAUDE_API_KEY). */
  apiKeyVar?: string
  /** API key encrypted with safeStorage, base64; absent = no stored key. */
  apiKeySecret?: string
  apiKeyLabel?: string
}

let cache: StoredSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): StoredSettings {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as StoredSettings)
        : {}
  } catch {
    // Missing file (first run) or unparseable JSON: all defaults.
    cache = {}
  }
  return cache
}

function persist(settings: StoredSettings): void {
  cache = settings
  // Owner-only: the file holds the encrypted API key.
  writeJsonAtomic(settingsPath(), settings, { mode: 0o600 })
}

// --- SQL files directory ---

export function defaultSqlFilesDir(): string {
  return join(app.getPath('userData'), 'queries')
}

export function sqlFilesDir(): string {
  return load().sqlFilesDir ?? defaultSqlFilesDir()
}

export function setSqlFilesDir(dir: string): void {
  persist({ ...load(), sqlFilesDir: dir })
}

// --- API key ---

export function apiKeyVarName(): string {
  const name = load().apiKeyVar
  return name && isValidVarName(name) ? name : API_KEY_VAR
}

export function setApiKeyVarName(name: string): void {
  const trimmed = name.trim()
  if (!isValidVarName(trimmed)) {
    throw new Error(
      'Variable name must be letters, digits, or underscores, and cannot start with a digit'
    )
  }
  const settings = { ...load() }
  if (trimmed === API_KEY_VAR) delete settings.apiKeyVar
  else settings.apiKeyVar = trimmed
  persist(settings)
}

export function setStoredApiKey(key: string, label: string): void {
  const trimmedKey = key.trim()
  if (!trimmedKey) throw new Error('API key cannot be empty')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encrypted storage is not available on this system')
  }
  const settings = { ...load() }
  settings.apiKeySecret = safeStorage.encryptString(trimmedKey).toString('base64')
  const trimmedLabel = label.trim()
  if (trimmedLabel) settings.apiKeyLabel = trimmedLabel
  else delete settings.apiKeyLabel
  persist(settings)
}

export function clearStoredApiKey(): void {
  const settings = { ...load() }
  delete settings.apiKeySecret
  delete settings.apiKeyLabel
  persist(settings)
}

function decryptStoredKey(): string | null {
  const secret = load().apiKeySecret
  if (!secret) return null
  try {
    return safeStorage.decryptString(Buffer.from(secret, 'base64')) || null
  } catch {
    // Undecryptable (e.g. keychain entry lost): behave as if no key is stored.
    return null
  }
}

function readKeyFromZshrc(varName: string): string | null {
  try {
    const text = readFileSync(join(homedir(), '.zshrc'), 'utf8')
    const re = new RegExp(`^\\s*(?:export\\s+)?${varName}\\s*=\\s*["']?([^"'\\s#]+)`, 'gm')
    let match: RegExpExecArray | null
    let last: string | null = null
    while ((match = re.exec(text)) !== null) last = match[1]
    return last
  } catch {
    return null
  }
}

export interface ResolvedApiKey {
  key: string | null
  source: ApiKeySource | null
}

/** Re-resolved on every call so ~/.zshrc edits apply without a restart. */
export function loadApiKey(): ResolvedApiKey {
  const stored = decryptStoredKey()
  if (stored) return { key: stored, source: 'keychain' }
  const varName = apiKeyVarName()
  const fromFile = readKeyFromZshrc(varName)
  if (fromFile) return { key: fromFile, source: 'zshrc' }
  const fromEnv = process.env[varName]
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return { key: null, source: null }
}

// --- Renderer snapshot ---

export function apiKeyConfig(): ApiKeyConfig {
  return {
    varName: apiKeyVarName(),
    hasStoredKey: !!load().apiKeySecret,
    keyLabel: load().apiKeyLabel ?? null,
    activeSource: loadApiKey().source,
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

export function appSettingsInfo(): AppSettingsInfo {
  return {
    sqlDir: sqlFilesDir(),
    defaultSqlDir: defaultSqlFilesDir(),
    apiKey: apiKeyConfig()
  }
}
