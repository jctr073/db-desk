import type { EditorSelectionContext } from '../../../shared/agent'

/**
 * How an agent editor proposal was handled by the editor panel:
 * - 'applied'  — the buffer was blank (or a fresh file was created), so the
 *   SQL was applied immediately.
 * - 'pending'  — the buffer had content; a diff review is open and the user
 *   will accept or reject it.
 * - 'unavailable' — no SQL editor to write into and no connection to create
 *   a file on; nothing happened.
 */
export type EditorProposalOutcome = 'applied' | 'pending' | 'unavailable'

/**
 * Editor/result commands the command palette, keyboard shortcuts and
 * Discover browser drive through the bridge, instead of lifting editor and
 * results state up into `App`. Each handler is a no-op when its target
 * doesn't apply (e.g. `runActive` with no SQL file active).
 */
export interface EditorCommands {
  /** Same code path as the Run button / ⌘⏎. */
  runActive: () => void
  /** Save the active file, same as ⌘S. */
  saveActive: () => void
  /** Format the active document; no-op when it isn't a SQL file. */
  formatActive: () => void
  /** Same as the "+" in the tab strip creating a new SQL query file. */
  newQuery: () => void
  /** Pin the live (unpinned) result tab; no-op with none running/finished. */
  pinActiveResult: () => void
  /** Open the results export popover, as if the Export button was clicked. */
  openExportMenu: () => void
  /** Close every result tab. */
  closeAllResults: () => void
  /** Whether there's a target and the active file is SQL, for the palette. */
  canRun: () => boolean
  /** Whether a live, finished, unpinned result exists to pin. */
  canPin: () => boolean
  /** Whether the active result tab can be exported. */
  canExport: () => boolean
}

/**
 * Imperative handle the SQL editor registers so the AI agent panel can read
 * the active buffer and place generated SQL without owning the editor.
 */
export interface EditorBridge {
  getActiveSql: () => { fileName: string | null; sql: string }
  /** The current non-empty selection in the active SQL editor, else null. */
  getSelection: () => EditorSelectionContext | null
  /** Insert SQL at the cursor (replacing any selection) in the active editor. */
  insertSql: (sql: string) => void
  /**
   * Agent proposal for the full contents of the active editor. Blank buffer:
   * applied immediately (through the undo stack). Non-blank: opens a diff
   * review with Accept/Reject. No SQL tab open: creates a new query file on
   * the active connection and applies there.
   */
  proposeSql: (sql: string) => EditorProposalOutcome
  /** Editor/result commands the palette and shortcuts drive. */
  commands: EditorCommands
}
