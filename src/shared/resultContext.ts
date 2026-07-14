/**
 * Pure serializer that turns a query result — or a row/column selection
 * within one — into the AgentResultItem wire shape attached to the AI agent
 * thread. No renderer/main imports so it can run (and be unit tested) in
 * either process.
 */

import type { AgentResultItem } from './agent'
import type { QueryResult } from './db'

/** Rows kept after selection filtering, before the char-budget pass. */
export const RESULT_CONTEXT_MAX_ROWS = 50
/** Per-cell cap; longer values are cut with a trailing '…'. */
export const RESULT_CONTEXT_CELL_CHARS = 200
/** Overall budget for one item's JSON.stringify length. */
export const RESULT_CONTEXT_MAX_CHARS = 16_000

function hexPreview(bytes: Uint8Array): string {
  // Only decode as many bytes as could possibly matter post-cap (2 hex
  // chars/byte) — avoids hex-encoding an entire large blob just to slice it.
  const maxBytes = Math.ceil(RESULT_CONTEXT_CELL_CHARS / 2) + 1
  const slice = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes
  let hex = ''
  for (let i = 0; i < slice.length; i++) {
    hex += slice[i].toString(16).padStart(2, '0')
  }
  return `\\x${hex}`
}

/** Uncapped string form of a cell, by runtime type — capping happens after. */
function rawCellString(cell: unknown): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (typeof cell === 'string') return cell
  if (
    typeof cell === 'number' ||
    typeof cell === 'boolean' ||
    typeof cell === 'bigint'
  ) {
    return String(cell)
  }
  if (cell instanceof Date) return cell.toISOString()
  // Buffer is a Uint8Array subclass, so this also covers driver Buffers.
  if (cell instanceof Uint8Array) return hexPreview(cell)
  if (typeof cell === 'object') {
    try {
      return JSON.stringify(cell)
    } catch {
      return String(cell)
    }
  }
  return String(cell)
}

function stringifyCell(cell: unknown): string {
  const text = rawCellString(cell)
  return text.length > RESULT_CONTEXT_CELL_CHARS
    ? `${text.slice(0, RESULT_CONTEXT_CELL_CHARS)}…`
    : text
}

/** Ascending, de-duplicated, in-range indexes; null/empty selection = all. */
function resolveIndexes(
  selected: ReadonlySet<number> | null | undefined,
  count: number
): number[] {
  const all = (): number[] => Array.from({ length: count }, (_, i) => i)
  if (!selected || selected.size === 0) return all()
  return [...selected].filter((i) => i >= 0 && i < count).sort((a, b) => a - b)
}

function rowScope(params: {
  totalRows: number
  rowFilterActive: boolean
  baseCount: number
  keptCount: number
  keptRowIndexes: number[]
  trimmedForChars: boolean
}): string {
  const {
    totalRows,
    rowFilterActive,
    baseCount,
    keptCount,
    keptRowIndexes,
    trimmedForChars
  } = params
  const trimmedSuffix = trimmedForChars ? ' (trimmed to fit)' : ''
  const plural = (n: number): string => (n === 1 ? '' : 's')

  if (rowFilterActive && keptCount === baseCount) {
    // The whole selection fit — describe it as the 1-based range it spans.
    const first = keptRowIndexes[0] + 1
    const last = keptRowIndexes[keptRowIndexes.length - 1] + 1
    const range = first === last ? `row ${first}` : `rows ${first}–${last}`
    return `${range} of ${totalRows} (selected)${trimmedSuffix}`
  }
  if (rowFilterActive) {
    // The selection itself had to be cut down further.
    return `first ${keptCount} of ${baseCount} selected row${plural(baseCount)} (of ${totalRows} total)${trimmedSuffix}`
  }
  if (keptCount === totalRows && !trimmedForChars) {
    return `all ${totalRows} row${plural(totalRows)}`
  }
  return `first ${keptCount} of ${totalRows} row${plural(totalRows)}${trimmedSuffix}`
}

/** Cap the listed column names at 5, folding the rest into "and N more". */
function columnScopeSuffix(columnFilterActive: boolean, columnNames: string[]): string {
  if (!columnFilterActive) return ''
  const maxListed = 5
  const listed = columnNames.slice(0, maxListed)
  const remaining = columnNames.length - listed.length
  const names =
    remaining > 0 ? `${listed.join(', ')}, and ${remaining} more` : listed.join(', ')
  return `, columns ${names} (selected)`
}

export function buildResultContextItem(args: {
  id: string
  title: string
  sql: string
  connId: string
  database: string
  result: QueryResult | null
  error: string | null
  /** Row indexes to include; null/empty = all rows (capped). */
  selectedRows?: ReadonlySet<number> | null
  /** Column indexes to include; null/empty = all columns. */
  selectedColumns?: ReadonlySet<number> | null
}): AgentResultItem {
  const { id, title, sql, connId, database, result, error } = args

  if (!result) {
    return {
      kind: 'result',
      id,
      title,
      sql,
      connId,
      database,
      columns: [],
      rows: [],
      totalRows: null,
      scope: 'failed query',
      error
    }
  }

  const totalRows = result.rows.length
  const columnFilterActive = Boolean(args.selectedColumns && args.selectedColumns.size > 0)
  const columnIndexes = resolveIndexes(args.selectedColumns, result.fields.length)
  const columns = columnIndexes.map((c) => ({
    name: result.fields[c].name,
    dataType: result.fields[c].dataType
  }))

  const rowFilterActive = Boolean(args.selectedRows && args.selectedRows.size > 0)
  const rowIndexes = resolveIndexes(args.selectedRows, totalRows)
  const baseCount = rowIndexes.length

  const buildRowsPayload = (indexes: number[]): string[][] =>
    indexes.map((r) => columnIndexes.map((c) => stringifyCell(result.rows[r][c])))

  const buildItem = (indexes: number[], trimmedForChars: boolean): AgentResultItem => ({
    kind: 'result',
    id,
    title,
    sql,
    connId,
    database,
    columns,
    rows: buildRowsPayload(indexes),
    totalRows,
    scope:
      rowScope({
        totalRows,
        rowFilterActive,
        baseCount,
        keptCount: indexes.length,
        keptRowIndexes: indexes,
        trimmedForChars
      }) + columnScopeSuffix(columnFilterActive, columns.map((c) => c.name)),
    error: null
  })

  let keptRowIndexes = rowIndexes.slice(0, RESULT_CONTEXT_MAX_ROWS)
  let trimmedForChars = false
  let item = buildItem(keptRowIndexes, trimmedForChars)

  while (
    JSON.stringify(item).length > RESULT_CONTEXT_MAX_CHARS &&
    keptRowIndexes.length > 1
  ) {
    keptRowIndexes = keptRowIndexes.slice(0, Math.ceil(keptRowIndexes.length / 2))
    trimmedForChars = true
    item = buildItem(keptRowIndexes, trimmedForChars)
  }

  return item
}
