import { useEffect } from 'react'
import type { ReactElement } from 'react'

import { CloseIcon, ShieldIcon } from '../components/icons'

interface WritableWarningDialogProps {
  connName: string
  /** Empty means a role-attribute clamp (superuser/BYPASSRLS write everywhere). */
  writableSchemas: string[]
  onContinue: () => void
  onDisconnect: () => void
}

/**
 * Informational — enforcement already happened in main before the renderer
 * saw the connect result. Shown on every writable-verdict prod connect
 * (`useConnectionState.writableWarning`); dismissing it changes nothing.
 */
export function WritableWarningDialog({
  connName,
  writableSchemas,
  onContinue,
  onDisconnect
}: WritableWarningDialogProps): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onContinue()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onContinue])

  return (
    // No click-to-close on the overlay: same rule as the other connection
    // dialogs — force an explicit Continue/Disconnect choice.
    <div className="dialog-overlay">
      <div
        className="dialog writable-warning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="writable-warning-title"
        aria-describedby="writable-warning-description"
      >
        <div className="dialog__header">
          <span className="dialog__icon writable-warning-dialog__icon">
            <ShieldIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title" id="writable-warning-title">
              Production database with write access
            </div>
            <div className="dialog__subtitle">{connName}</div>
          </div>
          <button className="dialog__close" onClick={onContinue} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div
          className="dialog__body writable-warning-dialog__body"
          id="writable-warning-description"
        >
          {writableSchemas.length > 0 ? (
            <p>
              This connection reaches a production database whose hot schema
              {writableSchemas.length > 1 ? 's' : ''} —{' '}
              {writableSchemas.map((schema, index) => (
                <span key={schema}>
                  {index > 0 && ', '}
                  <strong>{schema}</strong>
                </span>
              ))}{' '}
              — {writableSchemas.length > 1 ? 'are' : 'is'} writable by the connecting role.
            </p>
          ) : (
            <p>
              This connection reaches a production database. The connecting role itself can write
              everywhere (<strong>superuser</strong> / <strong>BYPASSRLS</strong>).
            </p>
          )}
          <p>
            The AI agent has been downgraded to <strong>Metadata Only</strong> for safety on this
            connection.
          </p>
          <p className="writable-warning-dialog__advice">
            Reconnect with a read-only role to restore agent Read & Run mode.
          </p>
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onDisconnect} type="button">
            Disconnect
          </button>
          <button className="btn-primary" onClick={onContinue} type="button" autoFocus>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
