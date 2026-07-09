import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { McpServerConfig, McpServerStatus } from '../../../shared/mcp'
import { CloseIcon, PlugIcon, RefreshIcon } from './icons'

/** Split a command line into tokens, honoring single and double quotes. */
function splitCommandLine(line: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

function quoteToken(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token
}

function commandLineFor(config: McpServerConfig): string {
  return [config.command, ...config.args].map(quoteToken).join(' ')
}

function envTextFor(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** Parse KEY=VALUE lines; returns an error message for a malformed line. */
function parseEnvText(
  text: string
): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      return { error: `Environment line "${line}" is not KEY=VALUE.` }
    }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return { env }
}

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  stopped: 'stopped',
  starting: 'starting…',
  running: 'running',
  error: 'failed'
}

interface FormState {
  id: string | null
  name: string
  commandLine: string
  envText: string
  enabled: boolean
}

interface McpSettingsDialogProps {
  onClose: () => void
}

export function McpSettingsDialog({
  onClose
}: McpSettingsDialogProps): ReactElement {
  const [statuses, setStatuses] = useState<McpServerStatus[] | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.dbDesk.mcp.list().then(setStatuses)
    return window.dbDesk.mcp.onChanged(setStatuses)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const openForm = useCallback((config: McpServerConfig | null) => {
    setFormError(null)
    setForm(
      config
        ? {
            id: config.id,
            name: config.name,
            commandLine: commandLineFor(config),
            envText: envTextFor(config.env),
            enabled: config.enabled
          }
        : { id: null, name: '', commandLine: '', envText: '', enabled: true }
    )
  }, [])

  const saveForm = useCallback(async () => {
    if (!form || saving) return
    const name = form.name.trim()
    const tokens = splitCommandLine(form.commandLine)
    const parsedEnv = parseEnvText(form.envText)
    if (!name) {
      setFormError('Name is required.')
      return
    }
    if (tokens.length === 0) {
      setFormError('Command is required.')
      return
    }
    if ('error' in parsedEnv) {
      setFormError(parsedEnv.error)
      return
    }
    setFormError(null)
    setSaving(true)
    const next = await window.dbDesk.mcp.save({
      id: form.id ?? crypto.randomUUID(),
      name,
      command: tokens[0],
      args: tokens.slice(1),
      env: parsedEnv.env,
      enabled: form.enabled
    })
    setStatuses(next)
    setSaving(false)
    setForm(null)
  }, [form, saving])

  const toggleEnabled = useCallback(async (status: McpServerStatus) => {
    setStatuses(
      await window.dbDesk.mcp.save({
        ...status.config,
        enabled: !status.config.enabled
      })
    )
  }, [])

  const removeServer = useCallback(async (status: McpServerStatus) => {
    if (
      !window.confirm(`Remove MCP server "${status.config.name}"?`)
    ) {
      return
    }
    setStatuses(await window.dbDesk.mcp.delete(status.config.id))
  }, [])

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the connection dialog).
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="MCP servers"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <PlugIcon size={18} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">MCP Servers</div>
            <div className="dialog__subtitle">
              External tools for the AI agent
            </div>
          </div>
          <button
            className="dialog__close"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body">
          {form ? (
            <div>
              <label className="field-label" htmlFor="mcp-name">
                NAME
              </label>
              <input
                id="mcp-name"
                className="text-input"
                placeholder="github"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
              <div style={{ marginTop: 11 }}>
                <label className="field-label" htmlFor="mcp-command">
                  COMMAND
                </label>
                <input
                  id="mcp-command"
                  className="text-input text-input--mono"
                  placeholder="npx -y @modelcontextprotocol/server-github"
                  value={form.commandLine}
                  onChange={(event) =>
                    setForm({ ...form, commandLine: event.target.value })
                  }
                />
                <div className="url-hint">
                  Executable and arguments, launched as a stdio MCP server.
                  Quote arguments that contain spaces.
                </div>
              </div>
              <div style={{ marginTop: 11 }}>
                <label className="field-label" htmlFor="mcp-env">
                  ENVIRONMENT VARIABLES
                </label>
                <textarea
                  id="mcp-env"
                  className="text-input text-input--mono mcp-env-input"
                  placeholder={'GITHUB_TOKEN=ghp_…\nONE_PER_LINE=value'}
                  rows={3}
                  value={form.envText}
                  onChange={(event) =>
                    setForm({ ...form, envText: event.target.value })
                  }
                />
                <div className="url-hint">
                  KEY=VALUE per line. Stored encrypted with your OS keychain.
                </div>
              </div>
              <label className="save-pwd">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={() => setForm({ ...form, enabled: !form.enabled })}
                />
                Enabled — start this server and offer its tools to the agent
              </label>
              {formError && <div className="mcp-form-error">{formError}</div>}
            </div>
          ) : (
            <div className="mcp-list">
              {statuses === null && (
                <div className="mcp-empty">Loading…</div>
              )}
              {statuses !== null && statuses.length === 0 && (
                <div className="mcp-empty">
                  No MCP servers configured. Add one to give the agent tools
                  beyond the database — its access to external systems is
                  whatever you grant the server; the database access mode
                  applies only to the built-in SQL tools.
                </div>
              )}
              {statuses?.map((status) => (
                <div key={status.config.id} className="mcp-row">
                  <span
                    className={`mcp-dot mcp-dot--${status.state}`}
                    title={STATE_LABEL[status.state]}
                  />
                  <div className="mcp-row__text">
                    <div className="mcp-row__name">
                      {status.config.name}
                      <span className="mcp-row__state">
                        {status.state === 'running'
                          ? `${status.tools.length} tool${status.tools.length === 1 ? '' : 's'}`
                          : STATE_LABEL[status.state]}
                      </span>
                    </div>
                    <div
                      className="mcp-row__detail"
                      title={
                        status.state === 'running'
                          ? status.tools.map((t) => t.name).join(', ')
                          : (status.error ?? undefined)
                      }
                    >
                      {status.state === 'error' && status.error
                        ? status.error
                        : commandLineFor(status.config)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    title="Restart server"
                    onClick={() => {
                      void window.dbDesk.mcp
                        .restart(status.config.id)
                        .then(setStatuses)
                    }}
                    disabled={!status.config.enabled}
                  >
                    <RefreshIcon />
                  </button>
                  <button
                    type="button"
                    className="mcp-row__action"
                    onClick={() => openForm(status.config)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="mcp-row__action"
                    onClick={() => void removeServer(status)}
                  >
                    Remove
                  </button>
                  <label
                    className="mcp-row__toggle"
                    title={
                      status.config.enabled
                        ? 'Enabled — tools are offered to the agent'
                        : 'Disabled — kept configured, never started'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={status.config.enabled}
                      onChange={() => void toggleEnabled(status)}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          {form ? (
            <>
              <button
                className="btn-cancel"
                onClick={() => setForm(null)}
                type="button"
              >
                Back
              </button>
              <button
                className="btn-primary"
                onClick={() => void saveForm()}
                disabled={saving}
                type="button"
              >
                {saving && <span className="spinner" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button className="btn-cancel" onClick={onClose} type="button">
                Close
              </button>
              <button
                className="btn-primary"
                onClick={() => openForm(null)}
                type="button"
              >
                Add Server
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
