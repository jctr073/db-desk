import type { ConnectionEnvironment } from '../../../shared/db'

/** Per-connection accent color (see the "Unified Connection" design). */
export interface ConnAccent {
  hex: string
  /** "r, g, b" triplet so CSS can build tints via rgba(var(--conn-accent-rgb), a). */
  rgb: string
}

const PALETTE: ConnAccent[] = [
  { hex: '#6b8afd', rgb: '107, 138, 253' },
  { hex: '#a98be6', rgb: '169, 139, 230' },
  { hex: '#3fb6a0', rgb: '63, 182, 160' },
  { hex: '#dcb15f', rgb: '220, 177, 95' },
  { hex: '#df8aa6', rgb: '223, 138, 166' },
  { hex: '#7fd18b', rgb: '127, 209, 139' }
]

/** Fixed accent for prod connections — overrides the palette everywhere
 * accent-derived chrome appears (titlebar pill, tab underline, tree dot). */
export const PROD_ACCENT: ConnAccent = { hex: '#e5484d', rgb: '229, 72, 77' }

/** The accent a connection should render with: prod always reads red,
 * regardless of its palette slot; dev/stage keep their assigned color. */
function accentFor(
  environment: ConnectionEnvironment | null | undefined,
  paletteAccent: ConnAccent
): ConnAccent {
  return environment === 'prod' ? PROD_ACCENT : paletteAccent
}

/**
 * Accent per connection id, cycling the palette in the given (tree) order.
 * Prod connections are overridden to the fixed red PROD_ACCENT, but still
 * consume a palette slot so dev/stage accents stay identical to before.
 */
export function connAccents(
  conns: { id: string; environment?: ConnectionEnvironment | null }[]
): Map<string, ConnAccent> {
  const out = new Map<string, ConnAccent>()
  for (const conn of conns) {
    if (out.has(conn.id)) continue
    const paletteAccent = PALETTE[out.size % PALETTE.length]
    out.set(conn.id, accentFor(conn.environment, paletteAccent))
  }
  return out
}
