import type { DbResult } from './db'

export type DataExportFormat = 'csv' | 'tsv' | 'json'

export interface ExportDestination {
  token: string
}

export type ChooseExportResult = DbResult<ExportDestination | null>
export type WriteExportResult = DbResult<null>
