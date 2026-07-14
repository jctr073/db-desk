import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import type { ColumnEndpoint, ReferenceEdge, ReferenceLists } from './references'

const POP_WIDTH = 320
const POP_MAX_HEIGHT = 360
const POP_LEFT_MARGIN = 8
const POP_RIGHT_MARGIN = 12

function fmt(end: ColumnEndpoint): string {
  return `${end.schema}.${end.table}.${end.column}`
}

interface ReferencesPopoverProps {
  x: number
  y: number
  /** Header line, e.g. "public.orders.customer_id". */
  title: string
  /** Set when the subject is a single column (its name is dropped from rows). */
  subjectColumn: string | null
  /** Null when the database's introspection is not cached (shouldn't happen). */
  lists: ReferenceLists | null
  onNavigate: (endpoint: ColumnEndpoint) => void
  onClose: () => void
}

/**
 * Anchored panel listing foreign-key references for a table or column:
 * "References" (what the subject points at) and "Referenced by" (what points
 * at it), covering declared FKs and inferred logical FKs. Rows navigate to
 * the referenced node in the connections tree.
 */
export function ReferencesPopover({
  x,
  y,
  title,
  subjectColumn,
  lists,
  onNavigate,
  onClose
}: ReferencesPopoverProps): ReactElement {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(() =>
    Math.max(POP_LEFT_MARGIN, Math.min(x, window.innerWidth - POP_WIDTH - POP_RIGHT_MARGIN))
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useLayoutEffect(() => {
    const popover = popoverRef.current
    if (!popover) return

    const updateLeft = (): void => {
      const nextLeft = Math.max(
        POP_LEFT_MARGIN,
        Math.min(x, window.innerWidth - popover.getBoundingClientRect().width - POP_RIGHT_MARGIN)
      )
      setLeft((currentLeft) => (currentLeft === nextLeft ? currentLeft : nextLeft))
    }

    updateLeft()
    const resizeObserver = new ResizeObserver(updateLeft)
    resizeObserver.observe(popover)
    window.addEventListener('resize', updateLeft)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateLeft)
    }
  }, [x])

  const top = Math.max(8, Math.min(y, window.innerHeight - POP_MAX_HEIGHT - 12))

  const rowLabel = (edge: ReferenceEdge, side: 'to' | 'from'): string => {
    if (side === 'to') {
      // Outbound: "<local column> → schema.table.column" (column subjects
      // drop the local prefix — it's the title).
      const target = fmt(edge.to)
      return subjectColumn ? `→ ${target}` : `${edge.from.column} → ${target}`
    }
    const source = fmt(edge.from)
    return edge.fromRelationKind === 'table' ? source : `${source} (${edge.fromRelationKind})`
  }

  const section = (
    heading: string,
    edges: ReferenceEdge[],
    side: 'to' | 'from'
  ): ReactElement | null => {
    if (edges.length === 0) return null
    return (
      <>
        <div className="refs-pop__section">{heading}</div>
        {edges.map((edge, index) => {
          const label = rowLabel(edge, side)
          return (
            <button
              key={`${side}-${index}`}
              className="refs-pop__row"
              onClick={() => onNavigate(side === 'to' ? edge.to : edge.from)}
              title={label}
            >
              <span className="refs-pop__name">{label}</span>
              <span
                className={
                  edge.kind === 'fk'
                    ? 'refs-pop__badge'
                    : 'refs-pop__badge refs-pop__badge--lfk'
                }
                title={
                  edge.kind === 'fk'
                    ? 'Declared foreign key'
                    : 'Logical foreign key (inferred from naming)'
                }
              >
                {edge.kind === 'fk' ? 'FK' : 'LFK'}
              </span>
            </button>
          )
        })}
      </>
    )
  }

  const empty = lists && lists.outbound.length === 0 && lists.inbound.length === 0

  return (
    <div
      className="ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        ref={popoverRef}
        className="refs-pop"
        role="dialog"
        aria-label={`References for ${title}`}
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="refs-pop__title" title={title}>
          {title}
        </div>
        {!lists && <div className="refs-pop__empty">Schema not loaded.</div>}
        {lists && section('References', lists.outbound, 'to')}
        {lists && section('Referenced by', lists.inbound, 'from')}
        {empty && <div className="refs-pop__empty">No references found.</div>}
      </div>
    </div>
  )
}
