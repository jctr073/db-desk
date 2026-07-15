import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { CloseIcon, FolderIcon } from './icons'

interface DetachCodebaseDialogProps {
  targetLabel: string
  repoName: string | null
  /** Name of the knowledge base the codebase is attached to. */
  baseName: string | null
  onClose: () => void
  /** Detach the codebase but keep the knowledge base and its records. */
  onDetach: () => Promise<void>
  /** Detach the codebase and delete the base everywhere it is linked. */
  onDetachAndDelete: () => Promise<void>
}

type Pending = 'detach' | 'delete' | null

/**
 * Offers the two ways to detach an attached codebase: keep the knowledge base
 * (just clear the repo), or also delete the base — which removes it from every
 * database it is linked to, not only this one.
 */
export function DetachCodebaseDialog({
  targetLabel,
  repoName,
  baseName,
  onClose,
  onDetach,
  onDetachAndDelete
}: DetachCodebaseDialogProps): ReactElement {
  const [pending, setPending] = useState<Pending>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = pending !== null

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const run = useCallback(
    async (which: 'detach' | 'delete'): Promise<void> => {
      if (busy) return
      setPending(which)
      setError(null)
      try {
        await (which === 'detach' ? onDetach() : onDetachAndDelete())
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setPending(null)
      }
    },
    [busy, onDetach, onDetachAndDelete]
  )

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
            disabled={busy}
          >
            <CloseIcon />
          </button>
        </div>

        <div
          className="dialog__body detach-dialog__body"
          id="detach-dialog-description"
        >
          <p>
            <strong>Detach codebase</strong> clears{' '}
            <strong>{repoName ? `“${repoName}”` : 'the codebase'}</strong> from{' '}
            <strong>{baseName ? `“${baseName}”` : 'this knowledge base'}</strong>
            . The base and its knowledge records are kept.
          </p>
          <p>
            <strong>Detach &amp; delete</strong> also permanently deletes the
            base and everything in it — removing it from every database it is
            linked to, not only <strong>{targetLabel}</strong>. This cannot be
            undone.
          </p>
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
            disabled={busy}
            autoFocus
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void run('detach')}
            type="button"
            disabled={busy}
          >
            {pending === 'detach' ? 'Detaching…' : 'Detach Codebase'}
          </button>
          <button
            className="btn-danger"
            onClick={() => void run('delete')}
            type="button"
            disabled={busy}
          >
            {pending === 'delete' ? 'Deleting…' : 'Detach & Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
