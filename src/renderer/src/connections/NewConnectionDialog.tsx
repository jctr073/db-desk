import { useEffect } from 'react'
import type { ReactElement } from 'react'

import { CheckIcon, CloseIcon, DatabaseIcon, EyeIcon } from '../components/icons'
import type { ConnectionState } from './useConnectionState'

interface NewConnectionDialogProps {
  state: ConnectionState
}

export function NewConnectionDialog({ state }: NewConnectionDialogProps): ReactElement | null {
  const { closeDialog } = state

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [closeDialog])

  if (!state.dialogOpen) return null

  const isParams = state.dialogTab === 'params'

  return (
    <div className="dialog-overlay" onClick={closeDialog}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New connection"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <DatabaseIcon size={18} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">New Connection</div>
            <div className="dialog__subtitle">Connect to a PostgreSQL database</div>
          </div>
          <button className="dialog__close" onClick={closeDialog} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__top">
          <label className="field-label" htmlFor="conn-name">
            CONNECTION NAME
          </label>
          <input
            id="conn-name"
            className="text-input"
            value={state.form.name}
            onChange={(event) => state.updateForm('name', event.target.value)}
          />

          <div className="dtabs">
            <button
              type="button"
              className={`dtab${isParams ? ' is-active' : ''}`}
              onClick={() => state.setDialogTab('params')}
            >
              Parameters
            </button>
            <button
              type="button"
              className={`dtab${!isParams ? ' is-active' : ''}`}
              onClick={() => state.setDialogTab('url')}
            >
              Connection URL
            </button>
          </div>
        </div>

        <div className="dialog__body">
          {isParams ? (
            <div>
              <div className="field-row">
                <div style={{ flex: 1 }}>
                  <label className="field-label" htmlFor="conn-host">
                    HOST
                  </label>
                  <input
                    id="conn-host"
                    className="text-input"
                    value={state.form.host}
                    onChange={(event) => state.updateForm('host', event.target.value)}
                  />
                </div>
                <div style={{ width: 96 }}>
                  <label className="field-label" htmlFor="conn-port">
                    PORT
                  </label>
                  <input
                    id="conn-port"
                    className="text-input"
                    value={state.form.port}
                    onChange={(event) => state.updateForm('port', event.target.value)}
                  />
                </div>
              </div>
              <div style={{ marginTop: 11 }}>
                <label className="field-label" htmlFor="conn-db">
                  DATABASE
                </label>
                <input
                  id="conn-db"
                  className="text-input"
                  value={state.form.database}
                  onChange={(event) => state.updateForm('database', event.target.value)}
                />
              </div>
              <div className="field-row" style={{ marginTop: 11 }}>
                <div style={{ flex: 1 }}>
                  <label className="field-label" htmlFor="conn-user">
                    USERNAME
                  </label>
                  <input
                    id="conn-user"
                    className="text-input"
                    value={state.form.user}
                    onChange={(event) => state.updateForm('user', event.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label" htmlFor="conn-pwd">
                    PASSWORD
                  </label>
                  <div className="pwd-wrap">
                    <input
                      id="conn-pwd"
                      className="text-input"
                      type={state.showPwd ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={state.form.password}
                      onChange={(event) => state.updateForm('password', event.target.value)}
                    />
                    <button
                      type="button"
                      className="pwd-toggle"
                      onClick={state.togglePwd}
                      title={state.showPwd ? 'Hide password' : 'Show password'}
                    >
                      <EyeIcon />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="conn-url">
                CONNECTION URL
              </label>
              <input
                id="conn-url"
                className="text-input text-input--mono"
                value={state.form.url}
                onChange={(event) => state.updateForm('url', event.target.value)}
              />
              <div className="url-hint">
                Format: <span className="url-hint__mono">postgresql://user:password@host:port/database</span>
              </div>
            </div>
          )}

          <label className="save-pwd">
            <input
              type="checkbox"
              checked={state.form.savePwd}
              onChange={state.toggleSavePwd}
            />
            Save password
          </label>
        </div>

        <div className="dialog__footer">
          <button className="btn-test" onClick={state.testConnection} type="button">
            {state.testState === 'testing' && <span className="spinner" />}
            Test
          </button>
          <div className="test-msg">
            {state.testState === 'ok' && (
              <span className="test-msg--ok">
                <CheckIcon />
                {state.testMsg}
              </span>
            )}
            {state.testState === 'testing' && (
              <span className="test-msg--pending">{state.testMsg}</span>
            )}
          </div>
          <button className="btn-cancel" onClick={closeDialog} type="button">
            Cancel
          </button>
          <button className="btn-primary" onClick={state.connect} type="button">
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}
