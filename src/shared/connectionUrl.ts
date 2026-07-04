/**
 * Helpers for user-supplied PostgreSQL connection URLs, shared by the main
 * process (connect/persist) and the renderer (form auto-fill).
 */

const SCHEME = /^postgres(ql)?:\/\//i

function stripQuotes(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value)
  return match ? match[2].trim() : value
}

/**
 * Clean up a pasted connection string: trims whitespace, removes surrounding
 * quotes and a leading env-style `NAME=` prefix (a copied
 * `DATABASE_URL=postgresql://…` line pastes as-is).
 */
export function normalizeConnectionUrl(raw: string): string {
  const url = stripQuotes(raw.trim())
  const prefixed = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(url)
  if (prefixed) {
    const rest = stripQuotes(prefixed[1].trim())
    if (SCHEME.test(rest)) return rest
  }
  return url
}

export interface ParsedConnectionUrl {
  host: string
  port: string
  database: string
  user: string
  password: string
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Split a postgres:// URL into discrete fields; null when unparseable. */
export function parseConnectionUrl(raw: string): ParsedConnectionUrl | null {
  const normalized = normalizeConnectionUrl(raw)
  if (!SCHEME.test(normalized)) return null
  try {
    const url = new URL(normalized)
    return {
      host: decode(url.hostname),
      port: url.port,
      database: decode(url.pathname.replace(/^\/+/, '')),
      user: decode(url.username),
      password: decode(url.password)
    }
  } catch {
    return null
  }
}
