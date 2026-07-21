import type { ConnectionEnvironment } from '../../../shared/db'

/** Per-connection accent color (see the "Unified Connection" design). */
export interface ConnAccent {
  hex: string
  /** "r, g, b" triplet so CSS can build tints via rgba(var(--conn-accent-rgb), a). */
  rgb: string
}

/**
 * Environment-themed palettes: the temperature of the accent signals the
 * deployment tier at a glance — cool for dev, mid (yellow/green) for stage,
 * hot (red/orange) for prod. Each family cycles independently so several
 * connections in the same environment stay distinguishable while all reading
 * as that environment's temperature.
 */
const COOL_DEV: ConnAccent[] = [
  { hex: '#6b8afd', rgb: '107, 138, 253' }, // blue
  { hex: '#3fb6a0', rgb: '63, 182, 160' }, // teal
  { hex: '#a98be6', rgb: '169, 139, 230' }, // purple
  { hex: '#56b7e0', rgb: '86, 183, 224' } // cyan
]

const MID_STAGE: ConnAccent[] = [
  { hex: '#dcb15f', rgb: '220, 177, 95' }, // gold
  { hex: '#7fd18b', rgb: '127, 209, 139' }, // green
  { hex: '#b6c95e', rgb: '182, 201, 94' }, // lime
  { hex: '#4cc27f', rgb: '76, 194, 127' } // emerald
]

const HOT_PROD: ConnAccent[] = [
  { hex: '#e5484d', rgb: '229, 72, 77' }, // red
  { hex: '#ee7d43', rgb: '238, 125, 67' }, // orange
  { hex: '#d9548c', rgb: '217, 84, 140' }, // rose
  { hex: '#f2766b', rgb: '242, 118, 107' } // coral
]

const FAMILIES: Record<ConnectionEnvironment, ConnAccent[]> = {
  dev: COOL_DEV,
  stage: MID_STAGE,
  prod: HOT_PROD
}

/**
 * Accent per connection id, cycling each environment's palette independently
 * in the given (tree) order. Legacy connections with no environment read as
 * dev (cool) — the least alarming default.
 */
export function connAccents(
  conns: { id: string; environment?: ConnectionEnvironment | null }[]
): Map<string, ConnAccent> {
  const counts: Record<ConnectionEnvironment, number> = { dev: 0, stage: 0, prod: 0 }
  const out = new Map<string, ConnAccent>()
  for (const conn of conns) {
    if (out.has(conn.id)) continue
    const env = conn.environment ?? 'dev'
    const family = FAMILIES[env]
    out.set(conn.id, family[counts[env] % family.length])
    counts[env] += 1
  }
  return out
}
