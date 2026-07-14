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
}
