import { useCallback, useMemo } from 'react'
import type { Dispatch, KeyboardEvent, ReactElement, SetStateAction } from 'react'

import {
  AGENT_MODELS,
  AGENT_MODES,
  AGENT_SLASH_COMMANDS,
  agentContextKey
} from '../../../../shared/agent'
import type {
  AgentContextItem,
  AgentDbObjectItem,
  AgentDbObjectKind,
  AgentEffort,
  AgentModeOption,
  AgentModelOption
} from '../../../../shared/agent'
import type { DatabaseIntrospection } from '../../../../shared/db'
import type { McpServerStatus } from '../../../../shared/mcp'
import { NodeIcon } from '../../connections/NodeIcon'
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CogIcon,
  GlobeIcon,
  HistoryIcon,
  NewChatIcon,
  PlayIcon,
  PlusThinIcon,
  SearchIcon,
  ShieldIcon,
  SparkleIcon,
  SqlFileIcon,
  StopIcon
} from '../icons'
import type { QueryTarget } from '../useQueryRunner'
import { ContextGauge } from './ChatTranscript'
import type { ArchivedChat, ChatMessage, ChatSession } from './useChatSession'

const EFFORT_LABEL: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

const EFFORT_SHORT: Record<AgentEffort, string> = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhi',
  max: 'max'
}

const CHIP_KIND_LABEL: Record<AgentDbObjectKind, string> = {
  schema: 'schema',
  table: 'table',
  view: 'view',
  matview: 'mat view'
}

function chatTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user')
  const text = firstUser?.parts.find((part) => part.kind === 'text')
  if (!text || text.kind !== 'text') return 'New chat'
  return text.text.replace(/\s+/g, ' ').trim() || 'New chat'
}

function chatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The chat header row: history popover + "New chat", above the transcript. */
export function ChatSessionBar({
  messages,
  chatHistory,
  busy,
  compacting,
  historyOpen,
  setHistoryOpen,
  onNewChat,
  onOpenChat
}: {
  messages: ChatMessage[]
  chatHistory: ArchivedChat[]
  busy: boolean
  compacting: boolean
  historyOpen: boolean
  setHistoryOpen: Dispatch<SetStateAction<boolean>>
  onNewChat: () => void
  onOpenChat: (chat: ArchivedChat) => void
}): ReactElement {
  return (
    <div className="chat__session-bar">
      <div className="chat-history-ctl">
        <button
          type="button"
          className={`chat-session-btn${historyOpen ? ' is-active' : ''}`}
          title="Chat history"
          aria-label="Chat history"
          aria-expanded={historyOpen}
          disabled={busy || compacting}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <HistoryIcon size={17} />
        </button>
        {historyOpen && (
          <>
            <div className="ctx-overlay" onMouseDown={() => setHistoryOpen(false)} />
            <div className="chat-history-pop">
              <div className="chat-history-pop__heading">Chat history</div>
              <button type="button" className="chat-history-item is-active" disabled>
                <span className="chat-history-item__title">{chatTitle(messages)}</span>
                <span className="chat-history-item__meta">Current</span>
              </button>
              {chatHistory.length > 0 ? (
                chatHistory.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className="chat-history-item"
                    onClick={() => onOpenChat(chat)}
                  >
                    <span className="chat-history-item__title">{chatTitle(chat.messages)}</span>
                    <span className="chat-history-item__meta">{chatTime(chat.updatedAt)}</span>
                  </button>
                ))
              ) : (
                <div className="chat-history-pop__empty">Previous chats will appear here.</div>
              )}
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        className="chat-session-btn"
        title="New chat"
        aria-label="New chat"
        disabled={busy || compacting}
        onClick={onNewChat}
      >
        <NewChatIcon size={18} />
      </button>
    </div>
  )
}

/** The target row's agent access-mode pill + popover. */
export function ModeControl({
  mode,
  modeOpen,
  setModeOpen,
  onPickMode
}: {
  mode: ChatSession['mode']
  modeOpen: boolean
  setModeOpen: Dispatch<SetStateAction<boolean>>
  onPickMode: (next: AgentModeOption) => void
}): ReactElement {
  const modeOption = AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[0]
  return (
    <div className="mode-ctl">
      <button
        type="button"
        className="model-pill"
        title="Agent access mode"
        onClick={() => setModeOpen((open) => !open)}
      >
        <ShieldIcon size={12} />
        <span className="model-pill__name">{modeOption.label}</span>
        <ChevronDownIcon size={10} />
      </button>
      {modeOpen && (
        <>
          <div className="ctx-overlay" onMouseDown={() => setModeOpen(false)} />
          <div className="model-pop mode-pop">
            {AGENT_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-pop__row mode-pop__row${m.id === mode ? ' is-active' : ''}`}
                disabled={!m.enabled}
                title={
                  m.id === 'write-admin'
                    ? 'Structure and data changes by the agent are disabled in this version.'
                    : undefined
                }
                onClick={() => onPickMode(m)}
              >
                <span className="mode-pop__text">
                  <span className="mode-pop__label">{m.label}</span>
                  <span className="mode-pop__desc">{m.description}</span>
                </span>
                {m.id === mode && <CheckIcon size={13} />}
              </button>
            ))}
            <div className="mode-pop__note">
              For maximum safety, connect with a read-only database role.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

interface ComposerProps {
  session: ChatSession
  /** The app-wide active connection + database the chat runs against. */
  target: QueryTarget | null
  /** Raw introspection per connection id → database name, for the picker. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  context: AgentContextItem[]
  onAddContext: (item: AgentContextItem) => void
  onRemoveContext: (key: string) => void
  // Popover state lives in AgentPanel so it survives tab switches exactly as
  // it did before the composer was extracted (the chat subtree unmounts when
  // another tab is shown).
  modelOpen: boolean
  setModelOpen: Dispatch<SetStateAction<boolean>>
  pickerOpen: boolean
  setPickerOpen: Dispatch<SetStateAction<boolean>>
  pickerFilter: string
  setPickerFilter: Dispatch<SetStateAction<string>>
  agentToolsOpen: boolean
  setAgentToolsOpen: Dispatch<SetStateAction<boolean>>
  slashIndex: number
  setSlashIndex: Dispatch<SetStateAction<number>>
  openPicker: () => void
  pickModel: (next: AgentModelOption) => void
  mcpStatuses: McpServerStatus[]
  onOpenMcp: () => void
}

/** The chat composer: chips, slash menu, textarea, and the toolbar popovers. */
export function Composer({
  session,
  target,
  schemas,
  context,
  onAddContext,
  onRemoveContext,
  modelOpen,
  setModelOpen,
  pickerOpen,
  setPickerOpen,
  pickerFilter,
  setPickerFilter,
  agentToolsOpen,
  setAgentToolsOpen,
  slashIndex,
  setSlashIndex,
  openPicker,
  pickModel,
  mcpStatuses,
  onOpenMcp
}: ComposerProps): ReactElement {
  const {
    busy,
    compacting,
    contextTokens,
    model,
    effort,
    setEffort,
    input,
    setInput,
    setDraftIntent,
    webSearch,
    setWebSearch,
    send,
    stop,
    newChat,
    runCompact
  } = session

  /** Everything in the target database the picker can attach, filtered. */
  const intro = target ? schemas[target.connId]?.[target.database] : undefined
  const pickerItems = useMemo(() => {
    if (!intro || !target) return []
    const q = pickerFilter.trim().toLowerCase()
    const existing = new Set(context.map(agentContextKey))
    const out: AgentDbObjectItem[] = []
    const push = (item: AgentDbObjectItem): void => {
      if (existing.has(agentContextKey(item))) return
      const qualified = item.schema ? `${item.schema}.${item.name}` : item.name
      if (q && !qualified.toLowerCase().includes(q)) return
      out.push(item)
    }
    for (const s of intro.schemas) {
      const base = { database: target.database, connId: target.connId }
      push({ kind: 'schema', name: s.name, schema: null, ...base })
      for (const t of s.tables) push({ kind: 'table', name: t.name, schema: s.name, ...base })
      for (const v of s.views) push({ kind: 'view', name: v.name, schema: s.name, ...base })
      for (const m of s.matviews) push({ kind: 'matview', name: m.name, schema: s.name, ...base })
    }
    return out.slice(0, 200)
  }, [intro, target, pickerFilter, context])

  // Slash-command menu: open while the input is nothing but "/" + letters.
  const slashMatches = useMemo(() => {
    const m = /^\/([a-z]*)$/i.exec(input)
    if (!m) return []
    const q = m[1].toLowerCase()
    return AGENT_SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  }, [input])
  const slashSel = slashMatches.length > 0 ? Math.min(slashIndex, slashMatches.length - 1) : 0

  const runSlashCommand = useCallback(
    (name: string) => {
      setInput('')
      setDraftIntent('chat')
      if (name === 'clear') newChat()
      else if (name === 'compact') void runCompact()
    },
    [setInput, setDraftIntent, newChat, runCompact]
  )

  const onComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashIndex((slashSel + 1) % slashMatches.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashIndex((slashSel - 1 + slashMatches.length) % slashMatches.length)
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          setInput(`/${slashMatches[slashSel].name}`)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setInput('')
          return
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          runSlashCommand(slashMatches[slashSel].name)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        send()
      }
    },
    [send, slashMatches, slashSel, runSlashCommand, setInput, setSlashIndex]
  )

  const effortOptions = model.efforts

  return (
    <div className="chat__composer">
      <div className="composer__box">
        <div className="composer__chips">
          {context.map((item) => {
            const key = agentContextKey(item)
            const remove = (
              <button
                type="button"
                className="chip__x"
                title="Remove from thread"
                onClick={() => onRemoveContext(key)}
              >
                <CloseIcon size={10} />
              </button>
            )
            if (item.kind === 'editor-selection') {
              const lineCount = item.endLine - item.startLine + 1
              return (
                <span
                  key={key}
                  className="chip"
                  title={`${item.fileName ?? 'editor'} lines ${item.startLine}–${item.endLine} (snapshot):\n${item.sql.slice(0, 400)}`}
                >
                  <SqlFileIcon size={12} />
                  <span className="chip__label">{item.fileName ?? 'selection'}</span>
                  <span className="chip__sub">
                    {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                  </span>
                  {remove}
                </span>
              )
            }
            if (item.kind === 'result') {
              return (
                <span
                  key={key}
                  className="chip"
                  title={`${item.title} · ${item.database}\n${item.error ? `failed: ${item.error.slice(0, 200)}` : item.scope}\n${item.sql.slice(0, 300)}`}
                >
                  <PlayIcon size={11} />
                  <span className="chip__label">{item.title}</span>
                  <span className="chip__sub">
                    {item.error ? 'error' : `${item.rows.length} rows`}
                  </span>
                  {remove}
                </span>
              )
            }
            const qualified = item.schema ? `${item.schema}.${item.name}` : item.name
            return (
              <span
                key={key}
                className="chip"
                title={`${CHIP_KIND_LABEL[item.kind]} ${qualified} · ${item.database}`}
              >
                <NodeIcon
                  node={{ id: '', kind: item.kind, label: item.name }}
                  color="var(--accent-strong)"
                />
                <span className="chip__label">{item.name}</span>
                <span className="chip__sub">{CHIP_KIND_LABEL[item.kind]}</span>
                {remove}
              </span>
            )
          })}
          <button
            type="button"
            className="chip-add"
            onClick={openPicker}
            disabled={!target}
            title={
              target
                ? 'Attach tables, views, or schemas as context'
                : 'Connect to a database to add context'
            }
          >
            <PlusThinIcon size={12} />
            Add context
          </button>
        </div>
        {slashMatches.length > 0 && (
          <div className="slash-pop">
            {slashMatches.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                className={`slash-pop__item${i === slashSel ? ' is-active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => runSlashCommand(cmd.name)}
              >
                <span className="slash-pop__name">/{cmd.name}</span>
                <span className="slash-pop__desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          className="composer__input"
          placeholder={
            target
              ? `Ask for SQL against ${target.connName}/${target.database}…`
              : 'Ask for SQL… (no database connected)'
          }
          rows={2}
          value={input}
          onChange={(e) => {
            const next = e.target.value
            setInput(next)
            if (!next.trim()) setDraftIntent('chat')
            setSlashIndex(0)
          }}
          onKeyDown={onComposerKeyDown}
        />
        <div className="composer__toolbar">
          <button
            type="button"
            className="composer__at"
            title="Add context"
            onClick={openPicker}
            disabled={!target}
          >
            @
          </button>
          <div className="model-ctl">
            <button
              type="button"
              className="model-pill"
              title="Model and reasoning effort"
              onClick={() => setModelOpen((open) => !open)}
            >
              <SparkleIcon size={12} />
              <span className="model-pill__name">{model.label}</span>
              {effort && model.efforts.includes(effort) && (
                <>
                  <span className="model-pill__dot" />
                  <span className="model-pill__effort">{EFFORT_LABEL[effort]}</span>
                </>
              )}
              <ChevronDownIcon size={10} />
            </button>
            {modelOpen && (
              <>
                <div className="ctx-overlay" onMouseDown={() => setModelOpen(false)} />
                <div className="model-pop">
                  <div className="model-pop__heading">Model</div>
                  {AGENT_MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`model-pop__row${m.id === model.id ? ' is-active' : ''}`}
                      onClick={() => pickModel(m)}
                    >
                      <span>{m.label}</span>
                      {m.id === model.id && <CheckIcon size={13} />}
                    </button>
                  ))}
                  {effortOptions.length > 0 && (
                    <>
                      <div className="model-pop__sep" />
                      <div className="model-pop__heading">Reasoning effort</div>
                      <div className="model-pop__segs">
                        {effortOptions.map((lvl) => (
                          <button
                            key={lvl}
                            type="button"
                            className={`model-pop__seg${lvl === effort ? ' is-active' : ''}`}
                            onClick={() => setEffort(lvl)}
                          >
                            {EFFORT_SHORT[lvl]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <ContextGauge tokens={contextTokens} windowSize={model.contextWindow} />
          <div className="agent-tools-ctl">
            <button
              type="button"
              className="composer__web"
              title="Agent tools"
              aria-label="Agent tools"
              aria-haspopup="menu"
              aria-expanded={agentToolsOpen}
              onClick={() => {
                setModelOpen(false)
                setAgentToolsOpen((open) => !open)
              }}
            >
              <CogIcon size={14} />
            </button>
            {agentToolsOpen && (
              <>
                <div className="ctx-overlay" onMouseDown={() => setAgentToolsOpen(false)} />
                <div
                  className="model-pop mcp-pop agent-tools-pop"
                  role="menu"
                  aria-label="Agent tools"
                >
                  <div className="model-pop__heading">Agent tools</div>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={webSearch}
                    className={`model-pop__row agent-tools-pop__row${
                      webSearch ? ' is-active' : ''
                    }`}
                    onClick={() => setWebSearch((on) => !on)}
                  >
                    <span className="agent-tools-pop__label">
                      <GlobeIcon size={14} />
                      Web browsing
                    </span>
                    <span className="agent-tools-pop__state">{webSearch ? 'On' : 'Off'}</span>
                  </button>
                  <div className="model-pop__sep" />
                  <div className="model-pop__heading">MCP servers</div>
                  {mcpStatuses.length === 0 && (
                    <div className="mcp-pop__empty">No MCP servers configured.</div>
                  )}
                  {mcpStatuses.map((status) => (
                    <button
                      key={status.config.id}
                      type="button"
                      role="menuitem"
                      className="model-pop__row mcp-pop__row"
                      title={
                        status.state === 'error'
                          ? (status.error ?? 'failed')
                          : status.tools.map((t) => t.name).join(', ')
                      }
                      onClick={() => {
                        setAgentToolsOpen(false)
                        onOpenMcp()
                      }}
                    >
                      <span className={`mcp-dot mcp-dot--${status.state}`} />
                      <span className="mcp-pop__name">{status.config.name}</span>
                      <span className="mcp-pop__state">
                        {!status.config.enabled
                          ? 'disabled'
                          : status.state === 'running'
                            ? `${status.tools.length} tool${status.tools.length === 1 ? '' : 's'}`
                            : status.state === 'starting'
                              ? 'starting…'
                              : status.state === 'error'
                                ? 'failed'
                                : 'stopped'}
                      </span>
                    </button>
                  ))}
                  <div className="model-pop__sep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="model-pop__row"
                    onClick={() => {
                      setAgentToolsOpen(false)
                      onOpenMcp()
                    }}
                  >
                    Manage servers…
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="composer__spacer" />
          {busy ? (
            <button type="button" className="composer__send" title="Stop" onClick={stop}>
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              title="Send (⏎)"
              disabled={!input.trim() || compacting}
              onClick={send}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
        {pickerOpen && (
          <>
            <div className="ctx-overlay" onMouseDown={() => setPickerOpen(false)} />
            <div className="picker-pop">
              <div className="picker-pop__search">
                <SearchIcon />
                <input
                  autoFocus
                  value={pickerFilter}
                  onChange={(e) => setPickerFilter(e.target.value)}
                  placeholder="Filter tables, views, schemas…"
                  aria-label="Filter context objects"
                />
              </div>
              <div className="picker-pop__list">
                {pickerItems.length === 0 && (
                  <div className="picker-pop__empty">
                    {intro ? 'Nothing left to add' : 'Loading schema objects…'}
                  </div>
                )}
                {pickerItems.map((item) => (
                  <button
                    key={agentContextKey(item)}
                    type="button"
                    className="picker-pop__item"
                    onClick={() => onAddContext(item)}
                  >
                    <NodeIcon
                      node={{ id: '', kind: item.kind, label: item.name }}
                      color="var(--text-dim)"
                    />
                    <span className="picker-pop__name">
                      {item.schema ? `${item.schema}.${item.name}` : item.name}
                    </span>
                    <span className="picker-pop__kind">{CHIP_KIND_LABEL[item.kind]}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
