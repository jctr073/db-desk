import { useEffect } from 'react'
import type { ReactElement } from 'react'

import { CONNECTION_TYPES, DIALECTS, dialectFor } from '../../../shared/dialect'
import { CheckIcon, CloseIcon, DatabaseIcon, EyeIcon } from '../components/icons'
import { databaseFieldError } from './connectionValidation'
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

  const dialect = dialectFor(state.form.type)
  const layout = dialect.form
  const isParams = state.dialogTab === 'params' || !dialect.supportsUrl
  const editing = state.editingId !== null
  const dbError = databaseFieldError(dialect, isParams, state.form.database, state.form.url)

  const secretField = (
    <div style={{ flex: 1 }}>
      <label className="field-label" htmlFor="conn-pwd">
        {layout.secretLabel}
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
          title={state.showPwd ? 'Hide' : 'Show'}
        >
          <EyeIcon />
        </button>
      </div>
    </div>
  )

  return (
    // Deliberately no click-to-close on the overlay: a stray click (e.g. when
    // refocusing the window) must not throw away a half-filled form.
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="New connection">
        <div className="dialog__header">
          <span className="dialog__icon">
            <DatabaseIcon size={18} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">{editing ? 'Edit Connection' : 'New Connection'}</div>
            <div className="dialog__subtitle">{dialect.dialogSubtitle}</div>
          </div>
          <button className="dialog__close" onClick={closeDialog} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__top">
          <label className="field-label">DATABASE TYPE</label>
          <div className="dtabs dtabs--type" role="radiogroup" aria-label="Database type">
            {CONNECTION_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={state.form.type === type}
                className={`dtab${state.form.type === type ? ' is-active' : ''}`}
                disabled={editing}
                onClick={() => state.setDialogType(type)}
              >
                {DIALECTS[type].label}
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="conn-name">
            CONNECTION NAME
          </label>
          <input
            id="conn-name"
            className="text-input"
            value={state.form.name}
            onChange={(event) => state.updateForm('name', event.target.value)}
          />

          {dialect.supportsUrl && (
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
          )}
        </div>

        <div className="dialog__body">
          {isParams ? (
            <div>
              <div className="field-row">
                <div style={{ flex: 1 }}>
                  <label className="field-label" htmlFor="conn-host">
                    {layout.hostLabel}
                  </label>
                  <input
                    id="conn-host"
                    className="text-input"
                    placeholder={layout.hostPlaceholder}
                    value={state.form.host}
                    onChange={(event) => state.updateForm('host', event.target.value)}
                  />
                </div>
                {layout.showPort && (
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
                )}
              </div>
              {layout.showHttpPath && (
                <div style={{ marginTop: 11 }}>
                  <label className="field-label" htmlFor="conn-http-path">
                    HTTP PATH
                  </label>
                  <input
                    id="conn-http-path"
                    className="text-input text-input--mono"
                    placeholder={layout.httpPathPlaceholder}
                    value={state.form.httpPath}
                    onChange={(event) => state.updateForm('httpPath', event.target.value)}
                  />
                </div>
              )}
              <div style={{ marginTop: 11 }}>
                <label className="field-label" htmlFor="conn-db">
                  {layout.databaseLabel}
                </label>
                <input
                  id="conn-db"
                  className={`text-input${dbError ? ' text-input--error' : ''}`}
                  aria-invalid={!!dbError}
                  value={state.form.database}
                  onChange={(event) => state.updateForm('database', event.target.value)}
                />
                {dbError && (
                  <div className="mcp-form-error" role="alert">
                    {dbError}
                  </div>
                )}
              </div>
              <div className="field-row" style={{ marginTop: 11 }}>
                {layout.showUser && (
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
                )}
                {secretField}
              </div>
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="conn-url">
                CONNECTION URL
              </label>
              <input
                id="conn-url"
                className={`text-input text-input--mono${dbError ? ' text-input--error' : ''}`}
                aria-invalid={!!dbError}
                value={state.form.url}
                onChange={(event) => state.updateForm('url', event.target.value)}
              />
              <div className="url-hint">
                Format: <span className="url-hint__mono">{dialect.urlExample}</span>
              </div>
              {dbError && (
                <div className="mcp-form-error" role="alert">
                  {dbError}
                </div>
              )}
            </div>
          )}

          <label className="save-pwd">
            <input type="checkbox" checked={state.form.savePwd} onChange={state.toggleSavePwd} />
            {layout.savePwdLabel}
          </label>
        </div>

        <div className="dialog__footer">
          <button
            className="btn-test"
            onClick={state.testConnection}
            disabled={state.testState === 'testing' || state.connecting}
            type="button"
          >
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
            {state.testState === 'error' && <span className="test-msg--err">{state.testMsg}</span>}
          </div>
          <button className="btn-cancel" onClick={closeDialog} type="button">
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={state.connect}
            disabled={state.connecting || !!dbError}
            title={dbError ?? undefined}
            type="button"
          >
            {state.connecting && <span className="spinner" />}
            {state.connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
