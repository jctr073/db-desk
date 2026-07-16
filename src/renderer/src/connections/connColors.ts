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

/** Accent per connection id, cycling the palette in the given (tree) order. */
export function connAccents(connIds: string[]): Map<string, ConnAccent> {
  const out = new Map<string, ConnAccent>()
  for (const id of connIds) {
    if (!out.has(id)) out.set(id, PALETTE[out.size % PALETTE.length])
  }
  return out
}
