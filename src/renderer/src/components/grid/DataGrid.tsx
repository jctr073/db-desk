import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent,
  ReactElement
} from 'react'

import type { CellValue } from '../../../../shared/db'
import { selectGridHeaders, type GridSelectionModifiers } from '../resultGridSelection'

const MIN_RESULT_COLUMN_WIDTH = 64
const COLUMN_KEYBOARD_RESIZE_STEP = 12

/** One grid column header: query results carry a data type, CSVs do not. */
export interface DataGridColumn {
  name: string
  dataType?: string
}

function activateWithKeyboard(
  event: ReactKeyboardEvent,
  activate: (modifiers: GridSelectionModifiers) => void
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate(event)
}

interface GridRowProps {
  row: readonly CellValue[]
  rowIndex: number
  selected: boolean
  /** Column indexes rendered with the selected-column background. */
  selectedColumns: ReadonlySet<number>
  onSelectRow: (row: number, modifiers: GridSelectionModifiers) => void
}

/**
 * One grid row, memoized so column resizes (applied via per-column CSS, not
 * per-cell styles) and selection changes on other rows never re-render it.
 * All props are identity-stable across those renders: `row` comes straight
 * from the `rows` prop, `selected` is a primitive, `selectedColumns` keeps its
 * identity while column selection is unchanged, and `onSelectRow` is stable.
 */
const GridRow = memo(function GridRow({
  row,
  rowIndex,
  selected,
  selectedColumns,
  onSelectRow
}: GridRowProps): ReactElement {
  return (
    <tr className={selected ? 'is-selected' : undefined} aria-selected={selected}>
      <td
        className="result-grid__rownum"
        role="rowheader"
        tabIndex={0}
        onClick={(event: ReactMouseEvent) => onSelectRow(rowIndex, event)}
        onKeyDown={(event) =>
          activateWithKeyboard(event, (modifiers) => onSelectRow(rowIndex, modifiers))
        }
      >
        {rowIndex + 1}
      </td>
      {row.map((cell, c) => (
        <td
          key={c}
          className={
            `${cell === null ? 'is-null' : ''}${selectedColumns.has(c) ? ' is-selected-column' : ''}`.trim() ||
            undefined
          }
        >
          {cell === null ? 'NULL' : String(cell)}
        </td>
      ))}
    </tr>
  )
})

interface DataGridProps {
  columns: readonly DataGridColumn[]
  rows: readonly (readonly CellValue[])[]
  onSelectedRowsChange: (rows: ReadonlySet<number>) => void
  onSelectedColumnsChange: (columns: ReadonlySet<number>) => void
  /** Present only when the parent offers the AI-context menu. */
  onGridContextMenu?: (event: ReactMouseEvent) => void
  /** Message shown under the header row when there are no rows. */
  emptyText?: string
}

/**
 * The hand-rolled selectable data grid, extracted from ResultsPanel so query
 * results and CSV previews share one implementation: row/column/range
 * selection, per-column resize, and the memoization contract documented on
 * GridRow. Selection state resets whenever `columns` or `rows` change
 * identity (a new result, a re-parsed file).
 */
export function DataGrid({
  columns,
  rows,
  onSelectedRowsChange,
  onSelectedColumnsChange,
  onGridContextMenu,
  emptyText = 'No rows returned'
}: DataGridProps): ReactElement {
  const [selectedRows, setSelectedRows] = useState<Set<number>>(() => new Set())
  const [selectedColumns, setSelectedColumns] = useState<Set<number>>(() => new Set())
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({})
  // The current selections mirrored into refs, so the row-level selection
  // callbacks stay identity-stable (memoized GridRows depend on that).
  const selectedRowsRef = useRef(selectedRows)
  const selectedColumnsRef = useRef(selectedColumns)
  const rowSelectionAnchorRef = useRef<number | null>(null)
  const columnSelectionAnchorRef = useRef<number | null>(null)
  const resizeRef = useRef<{
    column: number
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)

  const applyRowSelection = useCallback(
    (next: Set<number>): void => {
      selectedRowsRef.current = next
      setSelectedRows(next)
      onSelectedRowsChange(next)
    },
    [onSelectedRowsChange]
  )

  const applyColumnSelection = useCallback(
    (next: Set<number>): void => {
      selectedColumnsRef.current = next
      setSelectedColumns(next)
      onSelectedColumnsChange(next)
    },
    [onSelectedColumnsChange]
  )

  useEffect(() => {
    setColumnWidths({})
    rowSelectionAnchorRef.current = null
    columnSelectionAnchorRef.current = null
    applyRowSelection(new Set())
    applyColumnSelection(new Set())
  }, [columns, rows, applyRowSelection, applyColumnSelection])

  useEffect(() => () => document.body.classList.remove('is-grid-col-resizing'), [])

  const selectRow = useCallback(
    (row: number, modifiers: GridSelectionModifiers): void => {
      const next = selectGridHeaders(
        selectedRowsRef.current,
        row,
        rowSelectionAnchorRef.current,
        modifiers
      )
      applyRowSelection(next)
      if (next.size === 0) {
        rowSelectionAnchorRef.current = null
      } else if (!modifiers.shiftKey || rowSelectionAnchorRef.current === null) {
        rowSelectionAnchorRef.current = row
      }
      // Keep the empty set's identity so memoized rows see unchanged props.
      if (selectedColumnsRef.current.size > 0) applyColumnSelection(new Set())
      columnSelectionAnchorRef.current = null
    },
    [applyRowSelection, applyColumnSelection]
  )

  const selectColumn = useCallback(
    (column: number, modifiers: GridSelectionModifiers): void => {
      const next = selectGridHeaders(
        selectedColumnsRef.current,
        column,
        columnSelectionAnchorRef.current,
        modifiers
      )
      applyColumnSelection(next)
      if (next.size === 0) {
        columnSelectionAnchorRef.current = null
      } else if (!modifiers.shiftKey || columnSelectionAnchorRef.current === null) {
        columnSelectionAnchorRef.current = column
      }
      if (selectedRowsRef.current.size > 0) applyRowSelection(new Set())
      rowSelectionAnchorRef.current = null
    },
    [applyRowSelection, applyColumnSelection]
  )

  const selectAll = (): void => {
    const allRows = new Set(rows.map((_, index) => index))
    const allColumns = new Set(columns.map((_, index) => index))
    applyRowSelection(allRows)
    applyColumnSelection(allColumns)
    rowSelectionAnchorRef.current = null
    columnSelectionAnchorRef.current = null
  }

  const resizeColumn = (column: number, width: number): void => {
    setColumnWidths((widths) => ({
      ...widths,
      [column]: Math.max(MIN_RESULT_COLUMN_WIDTH, Math.round(width))
    }))
  }

  const startColumnResize = (event: PointerEvent<HTMLSpanElement>, column: number): void => {
    event.preventDefault()
    event.stopPropagation()
    resizeRef.current = {
      column,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-grid-col-resizing')
  }

  const continueColumnResize = (event: PointerEvent<HTMLSpanElement>): void => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    resizeColumn(resize.column, resize.startWidth + event.clientX - resize.startX)
  }

  const finishColumnResize = (event: PointerEvent<HTMLSpanElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    document.body.classList.remove('is-grid-col-resizing')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const resizeColumnWithKeyboard = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
    column: number
  ): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const currentWidth =
      columnWidths[column] ??
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      MIN_RESULT_COLUMN_WIDTH
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    resizeColumn(column, currentWidth + direction * COLUMN_KEYBOARD_RESIZE_STEP)
  }

  const allSelected =
    columns.length > 0 &&
    selectedRows.size === rows.length &&
    selectedColumns.size === columns.length

  // Resized column widths as per-column CSS rules scoped to this grid
  // instance, so a resize re-renders only this <style> element — never the
  // rows. The declarations match the previous per-cell inline styles exactly
  // (width + min/max on every th/td of the column) and outrank the
  // stylesheet's `.result-grid td { max-width: 420px }`, keeping resize
  // behavior pixel-identical. (A <colgroup> cannot express this: in auto
  // table layout a <col> width never shrinks a column below its cells'
  // min-content width, so narrowing a wide column would stop working.)
  const gridId = useId()
  const columnWidthCss = useMemo(
    () =>
      Object.entries(columnWidths)
        .map(([column, width]) => {
          // Column i renders as the (i + 2)th cell: the rownum cell is first.
          const cell = Number(column) + 2
          return (
            `table[data-grid-id="${gridId}"] tr > th:nth-child(${cell}),\n` +
            `table[data-grid-id="${gridId}"] tr > td:nth-child(${cell}) {\n` +
            `  width: ${width}px;\n  min-width: ${width}px;\n  max-width: ${width}px;\n}`
          )
        })
        .join('\n'),
    [columnWidths, gridId]
  )

  return (
    <div className="grid-scroll">
      {columnWidthCss && <style>{columnWidthCss}</style>}
      <table
        className="result-grid"
        data-grid-id={gridId}
        role="grid"
        aria-multiselectable="true"
        onContextMenu={
          onGridContextMenu &&
          ((event: ReactMouseEvent) => {
            event.preventDefault()
            onGridContextMenu(event)
          })
        }
      >
        <thead>
          <tr>
            <th
              className={`result-grid__rownum result-grid__corner${allSelected ? ' is-selected' : ''}`}
              aria-label="Select all cells"
              aria-selected={allSelected}
              title="Select all"
              tabIndex={0}
              onClick={selectAll}
              onKeyDown={(event) => activateWithKeyboard(event, selectAll)}
            />
            {columns.map((column, i) => (
              <th
                key={i}
                className={selectedColumns.has(i) ? 'is-selected' : undefined}
                aria-selected={selectedColumns.has(i)}
                tabIndex={0}
                onClick={(event: ReactMouseEvent) => selectColumn(i, event)}
                onKeyDown={(event) =>
                  activateWithKeyboard(event, (modifiers) => selectColumn(i, modifiers))
                }
              >
                <span className="result-grid__heading">
                  <span className="result-grid__name">{column.name}</span>
                  {column.dataType !== undefined && (
                    <span className="result-grid__type">{column.dataType}</span>
                  )}
                </span>
                <span
                  className="result-grid__resize-handle"
                  role="separator"
                  aria-label={`Resize ${column.name} column`}
                  aria-orientation="vertical"
                  tabIndex={0}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => startColumnResize(event, i)}
                  onPointerMove={continueColumnResize}
                  onPointerUp={finishColumnResize}
                  onPointerCancel={finishColumnResize}
                  onKeyDown={(event) => resizeColumnWithKeyboard(event, i)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <GridRow
              key={r}
              row={row}
              rowIndex={r}
              selected={selectedRows.has(r)}
              selectedColumns={selectedColumns}
              onSelectRow={selectRow}
            />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="grid-empty">{emptyText}</div>}
    </div>
  )
}
