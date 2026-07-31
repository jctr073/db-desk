import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { BrowserWindow, SaveDialogOptions } from 'electron'
import { dialog } from 'electron'

import type { ChooseExportResult, DataExportFormat, WriteExportResult } from '../shared/export'
import { grantExternalPath } from './watchedFolders'

const destinations = new Map<string, string>()

const formatOptions: Record<DataExportFormat, { extension: string; name: string }> = {
  csv: { extension: 'csv', name: 'CSV' },
  tsv: { extension: 'tsv', name: 'Tab-delimited text' },
  json: { extension: 'json', name: 'JSON' }
}

function isDataExportFormat(value: unknown): value is DataExportFormat {
  return value === 'csv' || value === 'tsv' || value === 'json'
}

function defaultFileName(suggestedName: string, format: DataExportFormat): string {
  const { extension } = formatOptions[format]
  const safeName = basename(suggestedName.trim()) || 'query-results'
  return safeName.toLowerCase().endsWith(`.${extension}`) ? safeName : `${safeName}.${extension}`
}

export async function chooseExportDestination(
  parent: BrowserWindow | null,
  suggestedName: string,
  format: unknown
): Promise<ChooseExportResult> {
  if (!isDataExportFormat(format)) {
    return { ok: false, error: 'Unsupported export format' }
  }

  const info = formatOptions[format]
  const options: SaveDialogOptions = {
    title: `Export ${info.name}`,
    defaultPath: defaultFileName(suggestedName, format),
    filters: [{ name: info.name, extensions: [info.extension] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }

  try {
    const choice = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { ok: true, data: null }

    const token = randomUUID()
    destinations.set(token, choice.filePath)
    return { ok: true, data: { token } }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Write the file for a chosen export destination. The token is single-use —
 * looked up and deleted here — which is why `openAfter` rides along as an
 * argument instead of a follow-up call: there is no second chance to resolve
 * the token once this returns.
 *
 * When `openAfter` is set and the write succeeds, the freshly written path is
 * granted read/write access through the watched-folder sandbox (it was very
 * likely chosen outside every watched folder) and `onOpened` fires with the
 * path so the caller can push the renderer an `export:written` event. Push
 * logic itself stays out of this module by design — see index.ts.
 */
export async function writeExportDestination(
  token: string,
  contents: string,
  openAfter: boolean,
  onOpened: (path: string) => void
): Promise<WriteExportResult> {
  const path = destinations.get(token)
  if (!path) return { ok: false, error: 'Export destination expired' }
  destinations.delete(token)

  try {
    await writeFile(path, contents, 'utf8')
    if (openAfter) {
      grantExternalPath(path)
      onOpened(path)
    }
    return { ok: true, data: null }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function discardExportDestination(token: string): void {
  destinations.delete(token)
}
