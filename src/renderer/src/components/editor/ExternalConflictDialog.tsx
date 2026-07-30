import type { ReactElement } from 'react'

import { SaveIcon } from '../icons'
import { useEscapeKey } from '../../useEscapeKey'

/** A watched-file save that hit a newer on-disk version. */
export interface SaveConflict {
  path: string
  name: string
  /** The on-disk mtime the write refused against; overwriting passes it back. */
  diskMtimeMs: number
}

interface ExternalConflictDialogProps {
  conflict: SaveConflict
  /** True while an overwrite/reload is in flight; disables every action. */
  busy: boolean
  onOverwrite: () => void
  onReload: () => void
  onCancel: () => void
}

/** Prompt shown when ⌘S finds the file changed on disk since it was loaded. */
export function ExternalConflictDialog({
  conflict,
  busy,
  onOverwrite,
  onReload,
  onCancel
}: ExternalConflictDialogProps): ReactElement {
  useEscapeKey(!busy, onCancel)

  return (
    <div className="dialog-overlay">
      <div
        className="dialog close-queries-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="File changed on disk"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <SaveIcon />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">File changed on disk</div>
            <div className="dialog__subtitle">{conflict.path}</div>
          </div>
        </div>
        <div className="dialog__body close-queries-dialog__body">
          <p>
            <strong>{conflict.name}</strong> was modified outside DB Desk after you opened it.
            Overwrite the on-disk version with your changes, or reload it and discard them?
          </p>
        </div>
        <div className="dialog__footer">
          <button
            className="btn-cancel close-queries-dialog__discard"
            type="button"
            disabled={busy}
            onClick={onReload}
          >
            Reload From Disk
          </button>
          <div className="test-msg" />
          <button className="btn-cancel" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="button"
            autoFocus
            disabled={busy}
            onClick={onOverwrite}
          >
            {busy && <span className="spinner" />}
            Overwrite
          </button>
        </div>
      </div>
    </div>
  )
}
