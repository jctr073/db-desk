import type { CellValue, QueryField } from '../../../shared/db'
import type { DataExportFormat } from '../../../shared/export'

export function exportNeedsFullQuery(format: DataExportFormat, selectedRowCount: number): boolean {
  return selectedRowCount === 0 && format !== 'json'
}

export function selectedResultRows(
  rows: CellValue[][],
  selectedRows: ReadonlySet<number>
): CellValue[][] {
  return [...selectedRows]
    .sort((a, b) => a - b)
    .filter((index) => index >= 0 && index < rows.length)
    .map((index) => rows[index])
}

function delimitedCell(value: CellValue, delimiter: string): string {
  if (value === null) return ''
  const text = String(value)
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

function serializeDelimited(fields: QueryField[], rows: CellValue[][], delimiter: string): string {
  const lines = [
    fields.map((field) => delimitedCell(field.name, delimiter)).join(delimiter),
    ...rows.map((row) =>
      fields.map((_, index) => delimitedCell(row[index] ?? null, delimiter)).join(delimiter)
    )
  ]
  return `${lines.join('\n')}\n`
}

function uniqueJsonKeys(fields: QueryField[]): string[] {
  const used = new Set<string>()
  return fields.map((field) => {
    let key = field.name
    let suffix = 2
    while (used.has(key)) key = `${field.name}_${suffix++}`
    used.add(key)
    return key
  })
}

export function serializeResult(
  fields: QueryField[],
  rows: CellValue[][],
  format: DataExportFormat
): string {
  if (format === 'csv') return serializeDelimited(fields, rows, ',')
  if (format === 'tsv') return serializeDelimited(fields, rows, '\t')

  const keys = uniqueJsonKeys(fields)
  const objects = rows.map((row) =>
    Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null] as const))
  )
  return `${JSON.stringify(objects, null, 2)}\n`
}
