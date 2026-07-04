import type { CSSProperties, ReactElement, ReactNode } from 'react'

import type { IconKey, TreeNode } from './types'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const NODE_SVGS: Partial<Record<IconKey, ReactNode>> = {
  connection: (
    <>
      <rect x="2.4" y="3" width="11.2" height="4" rx="1" />
      <rect x="2.4" y="9" width="11.2" height="4" rx="1" />
      <circle cx="4.6" cy="5" r="0.55" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="11" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="4" rx="4.8" ry="1.9" />
      <path d="M3.2 4v8c0 1 2.15 1.9 4.8 1.9s4.8-.9 4.8-1.9V4" />
      <path d="M3.2 8c0 1 2.15 1.9 4.8 1.9s4.8-.9 4.8-1.9" />
    </>
  ),
  schema: (
    <>
      <path d="M8 2.3 13.4 5.2v5.6L8 13.7 2.6 10.8V5.2z" />
      <path d="M2.7 5.3 8 8.1l5.3-2.8" />
      <path d="M8 8.1v5.5" />
    </>
  ),
  table: (
    <>
      <rect x="2.5" y="3.2" width="11" height="9.6" rx="1.2" />
      <path d="M2.5 6.4h11M2.5 9.6h11M6.4 6.4v6.4" />
    </>
  ),
  view: (
    <>
      <path d="M1.7 8S4 4.2 8 4.2 14.3 8 14.3 8 12 11.8 8 11.8 1.7 8 1.7 8Z" />
      <circle cx="8" cy="8" r="1.7" />
    </>
  ),
  matview: (
    <>
      <path d="M8 2.4 14 5.3 8 8.2 2 5.3z" />
      <path d="M2 8.2 8 11.1 14 8.2" />
      <path d="M2 11 8 13.9 14 11" />
    </>
  ),
  index: (
    <>
      <path d="M3 4.6h6.3M3 8h6.3M3 11.4h3.8" />
      <path d="M11.7 5v6M11.7 11l1.4-1.5M11.7 11l-1.4-1.5" />
    </>
  ),
  sequence: <path d="M4 12.5V9.6M8 12.5V6.6M12 12.5V3.6" strokeWidth={1.5} />,
  column: <rect x="6.1" y="2.9" width="3.8" height="10.2" rx="1.1" />
}

const GLYPHS: Partial<Record<IconKey, string>> = {
  function: 'ƒ', // ƒ
  type: '{}',
  aggregate: 'Σ' // Σ
}

interface NodeIconProps {
  node: TreeNode
  color: string
}

/** Render the leading icon (SVG or typographic glyph) for a tree node. */
export function NodeIcon({ node, color }: NodeIconProps): ReactElement {
  const iconKey: IconKey = node.kind === 'category' ? (node.icon ?? 'table') : node.kind
  const glyph = GLYPHS[iconKey]

  const box: CSSProperties = {
    display: 'inline-flex',
    width: 16,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    color
  }

  if (glyph) {
    return (
      <span
        style={{
          ...box,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontStyle: iconKey === 'function' ? 'italic' : 'normal',
          fontWeight: 700,
          fontSize: iconKey === 'type' ? 10 : 12
        }}
      >
        {glyph}
      </span>
    )
  }

  return (
    <span style={box}>
      <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
        {NODE_SVGS[iconKey] ?? NODE_SVGS.table}
      </svg>
    </span>
  )
}
