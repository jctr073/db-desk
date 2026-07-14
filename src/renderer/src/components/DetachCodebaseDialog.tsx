import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { CloseIcon, FolderIcon } from './icons'

interface DetachCodebaseDialogProps {
  targetLabel: string
  repoName: string | null
  onClose: () => void
  onConfirm: () => Promise<void>
}

/** Confirms the destructive half of detaching an attached codebase. */
export function DetachCodebaseDialog({
  targetLabel,
  repoName,
  onClose,
  onConfirm
}: DetachCodebaseDialogProps): ReactElement {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !deleting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [deleting, onClose])

  const confirm = useCallback(async (): Promise<void> => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await onConfirm()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDeleting(false)
    }
  }, [deleting, onConfirm])

  return (
    <div className="dialog-overlay">
      <div
        className="dialog detach-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="detach-dialog-title"
        aria-describedby="detach-dialog-description"
      >
        <div className="dialog__header">
          <span className="dialog__icon detach-dialog__icon">
            <FolderIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title" id="detach-dialog-title">
              Detach Codebase?
            </div>
            <div className="dialog__subtitle">{targetLabel}</div>
          </div>
          <button
            className="dialog__close"
            onClick={onClose}
            title="Close"
            type="button"
            disabled={deleting}
          >
            <CloseIcon />
          </button>
        </div>

        <div
          className="dialog__body detach-dialog__body"
          id="detach-dialog-description"
        >
          <p>
            This will detach{' '}
            <strong>{repoName ? `“${repoName}”` : 'the codebase'}</strong> and
            permanently delete all knowledge records for{' '}
            <strong>{targetLabel}</strong>.
          </p>
          <p>This action cannot be undone.</p>
          {error && (
            <div className="mcp-form-error" role="alert">
              Could not detach the codebase: {error}
            </div>
          )}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button
            className="btn-cancel"
            onClick={onClose}
            type="button"
            disabled={deleting}
            autoFocus
          >
            Cancel
          </button>
          <button
            className="btn-danger"
            onClick={() => void confirm()}
            type="button"
            disabled={deleting}
          >
            {deleting ? 'Detaching…' : 'Detach and Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
