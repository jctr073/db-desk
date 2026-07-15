/**
 * Wire types for app-wide settings: shared by the main-process settings
 * store, the preload bridge, and the renderer settings dialog.
 */

/** Where the active API key was found, in resolution order. */
export type ApiKeySource = 'keychain' | 'zshrc' | 'env'

export interface ApiKeyConfig {
  /** Shell variable name looked up in ~/.zshrc and the environment. */
  varName: string
  /** True when a key is stored encrypted via the OS keychain. */
  hasStoredKey: boolean
  /** User-chosen label on the stored key, e.g. "personal". */
  keyLabel: string | null
  /** Source of the key the agent would use right now; null = none found. */
  activeSource: ApiKeySource | null
  /** False when safeStorage cannot encrypt on this system. */
  encryptionAvailable: boolean
}

export interface AppSettingsInfo {
  /** Directory SQL files are stored in (resolved, absolute). */
  sqlDir: string
  /** The built-in default directory, to flag when sqlDir is custom. */
  defaultSqlDir: string
  apiKey: ApiKeyConfig
}

export type ChangeSqlDirResult =
  | { status: 'moved'; sqlDir: string; movedFiles: number }
  | { status: 'canceled' }
  | { status: 'error'; error: string }

/** Env-style variable name: letters, digits, underscore; no leading digit. */
export function isValidVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}
