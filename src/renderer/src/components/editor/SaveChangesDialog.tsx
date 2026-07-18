import { useEffect } from 'react'
import type { ReactElement } from 'react'

import type { QueryFile } from '../../files/useFileState'
import { SaveIcon } from '../icons'

/** A close request that may need a save prompt before it completes. */
export interface PendingClose {
  label: string
  fileIds: string[]
  resultTabIds: string[]
  dirtyFiles: QueryFile[]
  groupKey: string | null
}

interface SaveChangesDialogProps {
  pendingClose: PendingClose
  /** True while "Save (All)" is writing files; disables every action. */
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** "Save changes?" prompt shown when closing tabs with unsaved edits. */
export function SaveChangesDialog({
  pendingClose,
  saving,
  onSave,
  onDiscard,
  onCancel
}: SaveChangesDialogProps): ReactElement {
  useEffect(() => {
    if (saving) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving, onCancel])

  return (
    <div className="dialog-overlay">
      <div
        className="dialog close-queries-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save query changes"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <SaveIcon />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Save changes?</div>
            <div className="dialog__subtitle">{pendingClose.label}</div>
          </div>
        </div>
        <div className="dialog__body close-queries-dialog__body">
          {pendingClose.dirtyFiles.length === 1 ? (
            <p>
              <strong>{pendingClose.dirtyFiles[0].name}</strong> has unsaved changes. Save them
              before closing?
            </p>
          ) : (
            <>
              <p>
                {pendingClose.dirtyFiles.length} query tabs have unsaved changes. Save them before
                closing?
              </p>
              <ul className="close-queries-dialog__files">
                {pendingClose.dirtyFiles.map((file) => (
                  <li key={file.id}>{file.name}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="dialog__footer">
          <button
            className="btn-cancel close-queries-dialog__discard"
            type="button"
            disabled={saving}
            onClick={onDiscard}
          >
            Don’t Save
          </button>
          <div className="test-msg" />
          <button className="btn-cancel" type="button" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="button"
            autoFocus
            disabled={saving}
            onClick={onSave}
          >
            {saving && <span className="spinner" />}
            {saving ? 'Saving…' : pendingClose.dirtyFiles.length === 1 ? 'Save' : 'Save All'}
          </button>
        </div>
      </div>
    </div>
  )
}
