/**
 * Pure helpers for the agent transcript: code-fence handling and the
 * end-of-turn recap. Kept free of React so they are unit-testable.
 */

/** Splits assistant text on ``` fences; odd segments are code blocks. */
export function splitFences(text: string): { code: boolean; body: string }[] {
  return text.split('```').map((segment, i) => {
    if (i % 2 === 0) return { code: false, body: segment }
    // Strip an optional language tag on the fence line ("sql\n...").
    const newline = segment.indexOf('\n')
    const firstLine = newline === -1 ? segment : segment.slice(0, newline)
    const body =
      /^[a-zA-Z]*$/.test(firstLine.trim()) && newline !== -1
        ? segment.slice(newline + 1)
        : segment
    return { code: true, body }
  })
}

/**
 * The last fenced code block of an assistant answer — the turn's "final"
 * query when the model ended with SQL instead of calling write_to_editor.
 * Null when the answer has no non-empty fence.
 */
export function lastSqlFence(text: string): string | null {
  const fences = splitFences(text)
    .filter((seg) => seg.code && seg.body.trim())
    .map((seg) => seg.body.trimEnd())
  return fences.length > 0 ? fences[fences.length - 1] : null
}

/** Turn duration for the recap line: "8s", "1m 12s". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** How the turn's final query reached (or can reach) the SQL editor. */
export type RecapEditorState =
  /** write_to_editor (or the auto-load fallback) applied it directly. */
  | 'applied'
  /** A diff review is open in the editor awaiting Accept/Reject. */
  | 'pending'
  /** The editor already holds exactly this SQL. */
  | 'already'
  | null

/** End-of-turn summary appended to the transcript when the loop finishes. */
export interface TurnRecap {
  kind: 'recap'
  status: 'done' | 'stopped' | 'error'
  elapsedMs: number
  toolCount: number
  queryCount: number
  editor: RecapEditorState
  /** Final SQL that is not in the editor yet; renders a load button. */
  finalSql: string | null
}
