import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { CONNECTION_ENVIRONMENTS } from '../../../shared/db'
import type { ConnectionEnvironment } from '../../../shared/db'
import { CloseIcon, ShieldIcon } from '../components/icons'

const ENVIRONMENT_LABELS: Record<ConnectionEnvironment, string> = {
  dev: 'Dev',
  stage: 'Stage',
  prod: 'Prod'
}

interface EnvironmentPromptDialogProps {
  onChoose: (environment: ConnectionEnvironment) => void
  onCancel: () => void
}

/**
 * Forced pick for a connection saved before environments existed
 * (`useConnectionState.connectSaved`'s pre-flight): connecting is blocked
 * until one is chosen. Follows the house dialog pattern (see BaseNameDialog).
 */
export function EnvironmentPromptDialog({
  onChoose,
  onCancel
}: EnvironmentPromptDialogProps): ReactElement {
  const [environment, setEnvironment] = useState<ConnectionEnvironment | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    // No click-to-close on the overlay: same rule as the other dialogs — a
    // stray click must not silently cancel the connect attempt.
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Choose environment">
        <div className="dialog__header">
          <span className="dialog__icon">
            <ShieldIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Choose environment</div>
            <div className="dialog__subtitle">
              This connection was saved before environments existed.
            </div>
          </div>
          <button className="dialog__close" onClick={onCancel} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body">
          <p className="url-hint">Pick one to connect — prod adds extra agent safeguards.</p>
          <div className="dtabs dtabs--type" role="radiogroup" aria-label="Environment">
            {CONNECTION_ENVIRONMENTS.map((env) => (
              <button
                key={env}
                type="button"
                role="radio"
                aria-checked={environment === env}
                className={`dtab${environment === env ? ' is-active' : ''}`}
                onClick={() => setEnvironment(env)}
              >
                {ENVIRONMENT_LABELS[env]}
              </button>
            ))}
          </div>
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => environment && onChoose(environment)}
            disabled={!environment}
            type="button"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
