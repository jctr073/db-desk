import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { AppSettingsInfo } from '../../../shared/settings'
import { isValidVarName } from '../../../shared/settings'
import type { ThemePreference } from '../theme'
import { CloseIcon, CogIcon } from './icons'

type SettingsTab = 'appearance' | 'files' | 'api'

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'files', label: 'Files' },
  { id: 'api', label: 'API Keys' }
]

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; hint: string }> = [
  { id: 'light', label: 'Light', hint: 'Always use the light theme' },
  { id: 'dark', label: 'Dark', hint: 'Always use the dark theme' },
  { id: 'system', label: 'System', hint: 'Follow the OS appearance' }
]

/** "Error invoking remote method 'x': Error: msg" → "msg". */
function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

interface SettingsDialogProps {
  themePreference: ThemePreference
  onThemePreference: (preference: ThemePreference) => void
  onClose: () => void
}

export function SettingsDialog({
  themePreference,
  onThemePreference,
  onClose
}: SettingsDialogProps): ReactElement {
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [info, setInfo] = useState<AppSettingsInfo | null>(null)

  // Files tab
  const [dirBusy, setDirBusy] = useState(false)
  const [dirMsg, setDirMsg] = useState<string | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)

  // API tab: stored-key form + variable-name form
  const [keyDraft, setKeyDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [varDraft, setVarDraft] = useState<string | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)

  useEffect(() => {
    void window.dbDesk.settings.get().then(setInfo)
    return window.dbDesk.settings.onChanged(() => {
      void window.dbDesk.settings.get().then(setInfo)
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const varName = varDraft ?? info?.apiKey.varName ?? ''

  const chooseDir = useCallback(async () => {
    if (dirBusy) return
    setDirBusy(true)
    setDirMsg(null)
    setDirError(null)
    const result = await window.dbDesk.settings.chooseSqlDir()
    setDirBusy(false)
    if (result.status === 'moved') {
      setDirMsg(result.movedFiles === 1 ? 'Moved 1 file.' : `Moved ${result.movedFiles} files.`)
    } else if (result.status === 'error') {
      setDirError(result.error)
    }
  }, [dirBusy])

  const addFolder = useCallback(async () => {
    if (folderBusy) return
    setFolderBusy(true)
    setFolderError(null)
    try {
      setInfo(await window.dbDesk.settings.addWatchedFolder())
    } catch (error) {
      setFolderError(ipcErrorMessage(error))
    } finally {
      setFolderBusy(false)
    }
  }, [folderBusy])

  const removeFolder = useCallback(
    async (id: string) => {
      if (folderBusy) return
      setFolderBusy(true)
      setFolderError(null)
      try {
        setInfo(await window.dbDesk.settings.removeWatchedFolder(id))
      } catch (error) {
        setFolderError(ipcErrorMessage(error))
      } finally {
        setFolderBusy(false)
      }
    },
    [folderBusy]
  )

  const saveStoredKey = useCallback(async () => {
    if (!keyDraft.trim()) {
      setApiError('Paste an API key first.')
      return
    }
    setApiError(null)
    try {
      setInfo(await window.dbDesk.settings.setStoredApiKey(keyDraft, labelDraft))
      setKeyDraft('')
      setLabelDraft('')
      setReplacingKey(false)
    } catch (error) {
      setApiError(ipcErrorMessage(error))
    }
  }, [keyDraft, labelDraft])

  const removeStoredKey = useCallback(async () => {
    if (!window.confirm('Remove the stored API key?')) return
    setApiError(null)
    setInfo(await window.dbDesk.settings.clearStoredApiKey())
  }, [])

  const saveVarName = useCallback(async () => {
    const name = varName.trim()
    if (!isValidVarName(name)) {
      setApiError(
        'Variable name must be letters, digits, or underscores, and cannot start with a digit.'
      )
      return
    }
    setApiError(null)
    try {
      setInfo(await window.dbDesk.settings.setApiKeyVar(name))
      setVarDraft(null)
    } catch (error) {
      setApiError(ipcErrorMessage(error))
    }
  }, [varName])

  const apiKey = info?.apiKey
  const sourceText =
    apiKey == null
      ? 'Loading…'
      : apiKey.activeSource === 'keychain'
        ? `Using the stored key${apiKey.keyLabel ? ` “${apiKey.keyLabel}”` : ''}.`
        : apiKey.activeSource === 'zshrc'
          ? `Using ${apiKey.varName} from ~/.zshrc.`
          : apiKey.activeSource === 'env'
            ? `Using ${apiKey.varName} from the environment.`
            : 'No API key found — the AI agent is unavailable until one is set.'

  const showKeyForm = apiKey != null && (!apiKey.hasStoredKey || replacingKey)

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the connection dialog).
    <div className="dialog-overlay">
      <div
        className="dialog dialog--settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <CogIcon size={18} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Settings</div>
            <div className="dialog__subtitle">Appearance, file storage, and API keys</div>
          </div>
          <button className="dialog__close" onClick={onClose} title="Close" type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="settings-layout">
          <div className="settings-rail" role="tablist" aria-label="Settings sections">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={`settings-rail__tab${tab === entry.id ? ' is-active' : ''}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="settings-pane">
            {tab === 'appearance' && (
              <div>
                <div className="field-label">THEME</div>
                <div className="settings-radios">
                  {THEME_OPTIONS.map((option) => (
                    <label key={option.id} className="settings-radio">
                      <input
                        type="radio"
                        name="theme-preference"
                        checked={themePreference === option.id}
                        onChange={() => onThemePreference(option.id)}
                      />
                      <span className="settings-radio__text">
                        {option.label}
                        <span className="settings-radio__hint">{option.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {tab === 'files' && (
              <div>
                <div className="field-label">SQL FILES DIRECTORY</div>
                <div className="settings-path" title={info?.sqlDir}>
                  {info?.sqlDir ?? 'Loading…'}
                  {info != null && info.sqlDir === info.defaultSqlDir && (
                    <span className="settings-path__badge">default</span>
                  )}
                </div>
                <div className="url-hint">
                  Where your query files and their index live. Changing it moves the existing files
                  to the new directory.
                </div>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn-test"
                    onClick={() => void chooseDir()}
                    disabled={dirBusy || info == null}
                  >
                    {dirBusy && <span className="spinner" />}
                    {dirBusy ? 'Moving…' : 'Change…'}
                  </button>
                  {dirMsg && <span className="settings-msg">{dirMsg}</span>}
                  {dirError && <span className="settings-err">{dirError}</span>}
                </div>

                <div className="settings-section">
                  <div className="field-label">WATCHED FOLDERS</div>
                  <div className="url-hint">
                    Supported files in these folders show up in the Files panel for any connection.
                  </div>
                  {info != null && info.watchedFolders.length > 0 ? (
                    <div className="settings-folder-list">
                      {info.watchedFolders.map((folder) => (
                        <div className="settings-keyrow" key={folder.id}>
                          <span className="settings-keyrow__name">
                            <span className="settings-keyrow__label">{folder.label}</span>
                            <span className="settings-keyrow__path" title={folder.path}>
                              {folder.path}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="mcp-row__action"
                            onClick={() => void removeFolder(folder.id)}
                            disabled={folderBusy}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    info != null && <div className="settings-msg">No watched folders yet.</div>
                  )}
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="btn-test"
                      onClick={() => void addFolder()}
                      disabled={folderBusy || info == null}
                    >
                      {folderBusy && <span className="spinner" />}
                      Add folder…
                    </button>
                    {folderError && <span className="settings-err">{folderError}</span>}
                  </div>
                </div>
              </div>
            )}

            {tab === 'api' && (
              <div>
                <div
                  className={`settings-source${
                    apiKey != null && apiKey.activeSource === null
                      ? ' settings-source--missing'
                      : ''
                  }`}
                >
                  {sourceText}
                </div>

                <div className="settings-section">
                  <div className="field-label">STORED KEY</div>
                  {apiKey?.hasStoredKey && !replacingKey ? (
                    <div className="settings-keyrow">
                      <span className="settings-keyrow__name">
                        {apiKey.keyLabel ?? 'API key'}
                        <span className="settings-keyrow__mask">••••••••</span>
                      </span>
                      <button
                        type="button"
                        className="mcp-row__action"
                        onClick={() => setReplacingKey(true)}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        className="mcp-row__action"
                        onClick={() => void removeStoredKey()}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                  {showKeyForm && (
                    <>
                      <input
                        className="text-input text-input--mono"
                        type="password"
                        placeholder="sk-ant-…"
                        value={keyDraft}
                        onChange={(event) => setKeyDraft(event.target.value)}
                        disabled={!apiKey.encryptionAvailable}
                      />
                      <div style={{ marginTop: 8 }}>
                        <input
                          className="text-input"
                          placeholder="Label (optional), e.g. personal"
                          value={labelDraft}
                          onChange={(event) => setLabelDraft(event.target.value)}
                          disabled={!apiKey.encryptionAvailable}
                        />
                      </div>
                      <div className="url-hint">
                        {apiKey.encryptionAvailable
                          ? 'Stored encrypted with your OS keychain. A stored key takes priority over the shell variable below.'
                          : 'Encrypted storage is unavailable on this system — use the shell variable below instead.'}
                      </div>
                      <div className="settings-actions">
                        <button
                          type="button"
                          className="btn-test"
                          onClick={() => void saveStoredKey()}
                          disabled={!apiKey.encryptionAvailable || !keyDraft.trim()}
                        >
                          Save Key
                        </button>
                        {replacingKey && (
                          <button
                            type="button"
                            className="mcp-row__action"
                            onClick={() => {
                              setReplacingKey(false)
                              setKeyDraft('')
                              setLabelDraft('')
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="settings-section">
                  <div className="field-label">SHELL VARIABLE</div>
                  <input
                    className="text-input text-input--mono"
                    value={varName}
                    onChange={(event) => setVarDraft(event.target.value)}
                    spellCheck={false}
                  />
                  <div className="url-hint">
                    Looked up in <span className="url-hint__mono">~/.zshrc</span> and the
                    environment when no stored key is set.
                  </div>
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="btn-test"
                      onClick={() => void saveVarName()}
                      disabled={info == null || varName.trim() === info.apiKey.varName}
                    >
                      Save Name
                    </button>
                  </div>
                </div>

                {apiError && <div className="mcp-form-error">{apiError}</div>}
              </div>
            )}
          </div>
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
