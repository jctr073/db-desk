/**
 * Imperative handle the SQL editor registers so the AI agent panel can read
 * the active buffer and insert generated SQL without owning the editor.
 */
export interface EditorBridge {
  getActiveSql: () => { fileName: string | null; sql: string }
  /** Insert SQL at the cursor (replacing any selection) in the active editor. */
  insertSql: (sql: string) => void
}
