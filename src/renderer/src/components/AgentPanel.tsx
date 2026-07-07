import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MutableRefObject, ReactElement } from 'react'

import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL,
  agentContextKey
} from '../../../shared/agent'
import type {
  AgentContextItem,
  AgentEffort,
  AgentEvent,
  AgentKeyStatus,
  AgentModelOption
} from '../../../shared/agent'
import type { DatabaseIntrospection, QueryResult } from '../../../shared/db'
import { NodeIcon } from '../connections/NodeIcon'
import type { FileState } from '../files/useFileState'
import type { EditorBridge } from './editorBridge'
import type { QueryTarget } from './useQueryRunner'
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  PlayIcon,
  PlusThinIcon,
  SearchIcon,
  SparkleIcon,
  StopIcon
} from './icons'
import { FilesPanel } from './FilesPanel'

interface AgentPanelProps {
  files: FileState
  /** Connection id → display name. */
  connNames: Record<string, string>
  targets: QueryTarget[]
  editorBridge: MutableRefObject<EditorBridge | null>
  /** Mirrors an agent-executed query into the results grid. */
  onAgentQuery: (
    sql: string,
    target: QueryTarget,
    result: QueryResult | null,
    error: string | null
  ) => void
  /** Objects attached to the thread as context chips. */
  context: AgentContextItem[]
  onAddContext: (item: AgentContextItem) => void
  onRemoveContext: (key: string) => void
  /** Raw introspection per connection id → database name, for the picker. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  ensureSchema: (connId: string, database: string) => void
}

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

const CHIP_KIND_LABEL: Record<AgentContextItem['kind'], string> = {
  schema: 'schema',
  table: 'table',
  view: 'view',
  matview: 'mat view'
}

type ChatPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      toolId: string
      sql: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }
  | {
      kind: 'approval'
      toolId: string
      sql: string
      status: 'pending' | 'approved' | 'denied'
    }
  | { kind: 'error'; text: string }

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ChatPart[]
}

let idSeq = 0
function nextId(prefix: string): string {
  return `${prefix}${++idSeq}`
}

function targetKey(target: QueryTarget): string {
  return JSON.stringify([target.connId, target.database])
}

/** Appends delta text to the last assistant message, coalescing text parts. */
function appendText(messages: ChatMessage[], delta: string): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return messages
  const parts = [...last.parts]
  const tail = parts[parts.length - 1]
  if (tail && tail.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: tail.text + delta }
  } else {
    parts.push({ kind: 'text', text: delta })
  }
  return [...messages.slice(0, -1), { ...last, parts }]
}

function appendPart(messages: ChatMessage[], part: ChatPart): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    return [...messages, { id: nextId('m'), role: 'assistant', parts: [part] }]
  }
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts, part] }]
}

function updateTool(
  messages: ChatMessage[],
  toolId: string,
  patch: Partial<Extract<ChatPart, { kind: 'tool' }>>
): ChatMessage[] {
  return messages.map((msg) => {
    if (!msg.parts.some((p) => p.kind === 'tool' && p.toolId === toolId)) {
      return msg
    }
    return {
      ...msg,
      parts: msg.parts.map((p) =>
        p.kind === 'tool' && p.toolId === toolId ? { ...p, ...patch } : p
      )
    }
  })
}

function updateApproval(
  messages: ChatMessage[],
  match: (part: Extract<ChatPart, { kind: 'approval' }>) => boolean,
  status: 'approved' | 'denied'
): ChatMessage[] {
  return messages.map((msg) => {
    if (!msg.parts.some((p) => p.kind === 'approval' && match(p))) return msg
    return {
      ...msg,
      parts: msg.parts.map((p) =>
        p.kind === 'approval' && match(p) ? { ...p, status } : p
      )
    }
  })
}

/** Splits assistant text on ``` fences; odd segments are code blocks. */
function splitFences(text: string): { code: boolean; body: string }[] {
  return text.split('```').map((segment, i) => {
    if (i % 2 === 0) return { code: false, body: segment }
    // Strip an optional language tag on the fence line ("sql\n...").
    const newline = segment.indexOf('\n')
    const firstLine = newline === -1 ? segment : segment.slice(0, newline)
    const body =
      /^[a-zA-Z]*$/.test(firstLine.trim()) && newline !== -1
        ? segment.slice(newline + 1)
        : segment
    return { code: true, body }
  })
}

function AssistantText({
  text,
  onInsert
}: {
  text: string
  onInsert: (sql: string) => void
}): ReactElement {
  return (
    <>
      {splitFences(text).map((seg, i) =>
        seg.code ? (
          <div key={i} className="chat-sql">
            <pre>{seg.body.trimEnd()}</pre>
            <div className="chat-sql__actions">
              <button
                type="button"
                title="Insert into the active SQL editor at the cursor"
                onClick={() => onInsert(seg.body.trimEnd())}
              >
                Insert
              </button>
            </div>
          </div>
        ) : (
          seg.body.trim() && (
            <div key={i} className="chat-prose">
              {seg.body.trim()}
            </div>
          )
        )
      )}
    </>
  )
}

export function AgentPanel({
  files,
  connNames,
  targets,
  editorBridge,
  onAgentQuery,
  context,
  onAddContext,
  onRemoveContext,
  schemas,
  ensureSchema
}: AgentPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'files' | 'agent'>('agent')
  const [chatId, setChatId] = useState(() => nextId('chat'))
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [modelId, setModelId] = useState(DEFAULT_AGENT_MODEL.id)
  const [effort, setEffort] = useState<AgentEffort | null>(
    DEFAULT_AGENT_MODEL.defaultEffort
  )
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(
    null
  )
  const [keyStatus, setKeyStatus] = useState<AgentKeyStatus | null>(null)
  const [input, setInput] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFilter, setPickerFilter] = useState('')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const onAgentQueryRef = useRef(onAgentQuery)
  onAgentQueryRef.current = onAgentQuery

  const model =
    AGENT_MODELS.find((m) => m.id === modelId) ?? DEFAULT_AGENT_MODEL
  const target = targets.find((t) => targetKey(t) === selectedTargetKey) ?? null

  // Keep the target selection valid as connections come and go.
  useEffect(() => {
    if (
      selectedTargetKey &&
      targets.some((t) => targetKey(t) === selectedTargetKey)
    ) {
      return
    }
    const fallback = targets.find((t) => t.primary) ?? targets[0]
    setSelectedTargetKey(fallback ? targetKey(fallback) : null)
  }, [targets, selectedTargetKey])

  useEffect(() => {
    void window.dbDesk.agent.keyStatus().then(setKeyStatus)
  }, [])

  useEffect(() => {
    const unsubscribe = window.dbDesk.agent.onEvent((evt: AgentEvent) => {
      if (evt.chatId !== chatIdRef.current) return
      switch (evt.type) {
        case 'turn_start':
          break
        case 'text_delta':
          setThinking(false)
          setMessages((prev) => appendText(prev, evt.text))
          break
        case 'thinking':
          setThinking(evt.active)
          break
        case 'tool_start':
          setThinking(false)
          setMessages((prev) =>
            appendPart(prev, {
              kind: 'tool',
              toolId: evt.toolId,
              sql: evt.sql,
              status: 'running',
              summary: ''
            })
          )
          break
        case 'tool_result':
          setMessages((prev) =>
            updateTool(prev, evt.toolId, {
              status: evt.ok ? 'ok' : 'error',
              summary: evt.summary
            })
          )
          break
        case 'approval_request':
          setThinking(false)
          setMessages((prev) =>
            appendPart(prev, {
              kind: 'approval',
              toolId: evt.toolId,
              sql: evt.sql,
              status: 'pending'
            })
          )
          break
        case 'ran_query': {
          const t = evt.target
          onAgentQueryRef.current(
            evt.sql,
            {
              connId: t.connId,
              connName: t.connName,
              database: t.database,
              primary: false
            },
            evt.result,
            evt.error
          )
          break
        }
        case 'editor_insert':
          editorBridge.current?.insertSql(evt.sql)
          break
        case 'done':
          setBusy(false)
          setThinking(false)
          // A pending approval can no longer be answered once the turn ends.
          setMessages((prev) =>
            updateApproval(prev, (p) => p.status === 'pending', 'denied')
          )
          if (evt.stopReason === 'refusal') {
            setMessages((prev) =>
              appendPart(prev, {
                kind: 'error',
                text: 'The request was declined by the model.'
              })
            )
          }
          break
        case 'error':
          setBusy(false)
          setThinking(false)
          setMessages((prev) =>
            appendPart(
              updateApproval(prev, (p) => p.status === 'pending', 'denied'),
              { kind: 'error', text: evt.message }
            )
          )
          break
      }
    })
    return unsubscribe
  }, [])

  // Follow the stream: keep the transcript pinned to the bottom.
  useEffect(() => {
    const host = scrollRef.current
    if (host) host.scrollTop = host.scrollHeight
  }, [messages, thinking, busy])

  // "Add to Agent Thread" from the connections tree should reveal the chips.
  const prevContextLen = useRef(context.length)
  useEffect(() => {
    if (context.length > prevContextLen.current) setActiveTab('agent')
    prevContextLen.current = context.length
  }, [context.length])

  // Escape dismisses whichever popover is open.
  useEffect(() => {
    if (!modelOpen && !pickerOpen) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setModelOpen(false)
        setPickerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modelOpen, pickerOpen])

  const openPicker = useCallback(() => {
    setPickerFilter('')
    setPickerOpen(true)
    if (target) ensureSchema(target.connId, target.database)
  }, [target, ensureSchema])

  const pickModel = useCallback((next: AgentModelOption) => {
    setModelId(next.id)
    setEffort((cur) =>
      cur && next.efforts.includes(cur) ? cur : next.defaultEffort
    )
    setModelOpen(false)
  }, [])

  /** Everything in the target database the picker can attach, filtered. */
  const intro = target ? schemas[target.connId]?.[target.database] : undefined
  const pickerItems = useMemo(() => {
    if (!intro || !target) return []
    const q = pickerFilter.trim().toLowerCase()
    const existing = new Set(context.map(agentContextKey))
    const out: AgentContextItem[] = []
    const push = (item: AgentContextItem): void => {
      if (existing.has(agentContextKey(item))) return
      const qualified = item.schema ? `${item.schema}.${item.name}` : item.name
      if (q && !qualified.toLowerCase().includes(q)) return
      out.push(item)
    }
    for (const s of intro.schemas) {
      const base = { database: target.database, connId: target.connId }
      push({ kind: 'schema', name: s.name, schema: null, ...base })
      for (const t of s.tables)
        push({ kind: 'table', name: t.name, schema: s.name, ...base })
      for (const v of s.views)
        push({ kind: 'view', name: v.name, schema: s.name, ...base })
      for (const m of s.matviews)
        push({ kind: 'matview', name: m.name, schema: s.name, ...base })
    }
    return out.slice(0, 200)
  }, [intro, target, pickerFilter, context])

  const insertSql = useCallback(
    (sql: string) => {
      editorBridge.current?.insertSql(sql)
    },
    [editorBridge]
  )

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setBusy(true)
    setMessages((prev) => [
      ...prev,
      {
        id: nextId('m'),
        role: 'user',
        parts: [{ kind: 'text', text: prompt }]
      },
      { id: nextId('m'), role: 'assistant', parts: [] }
    ])
    const editor = editorBridge.current?.getActiveSql() ?? null
    void window.dbDesk.agent.send({
      chatId,
      prompt,
      model: model.id,
      effort: effort && model.efforts.includes(effort) ? effort : null,
      target: target
        ? {
            connId: target.connId,
            connName: target.connName,
            database: target.database
          }
        : null,
      editor,
      context
    })
  }, [input, busy, chatId, model, effort, target, editorBridge, context])

  const answerApproval = useCallback(
    (toolId: string, approved: boolean) => {
      setMessages((prev) =>
        updateApproval(
          prev,
          (p) => p.toolId === toolId,
          approved ? 'approved' : 'denied'
        )
      )
      void window.dbDesk.agent.approve(chatId, toolId, approved)
    },
    [chatId]
  )

  const stop = useCallback(() => {
    void window.dbDesk.agent.stop(chatId)
  }, [chatId])

  const newChat = useCallback(() => {
    void window.dbDesk.agent.reset(chatId)
    setChatId(nextId('chat'))
    setMessages([])
    setBusy(false)
    setThinking(false)
  }, [chatId])

  const onComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        send()
      }
    },
    [send]
  )

  const effortOptions = model.efforts
  const keyMissing = keyStatus !== null && !keyStatus.found

  const transcript = useMemo(
    () => messages.filter((m) => m.role === 'user' || m.parts.length > 0),
    [messages]
  )

  return (
    <section className="agent-panel">
      <div className="agent-tabbar">
        <button
          className={`agent-tab${activeTab === 'files' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('files')}
        >
          SQL Files
        </button>
        <button
          className={`agent-tab${activeTab === 'agent' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('agent')}
        >
          <SparkleIcon />
          AI Agent
        </button>
        <div className="agent-tabbar__spacer" />
        <button
          className="icon-btn icon-btn--sm"
          title={activeTab === 'agent' ? 'New chat' : 'New query file'}
          type="button"
          onClick={() => {
            if (activeTab === 'agent') newChat()
            else files.createFile(null, null)
          }}
        >
          <PlusThinIcon />
        </button>
      </div>
      {activeTab === 'files' ? (
        <FilesPanel files={files} connNames={connNames} />
      ) : (
        <div className="chat">
          {keyMissing && (
            <div className="chat__notice">
              No API key found — add <code>export ANTHROPIC_API_KEY=…</code> to{' '}
              <code>~/.zshrc</code>.
            </div>
          )}
          <div className="chat__scroll" ref={scrollRef}>
            {transcript.length === 0 && (
              <div className="chat__empty">
                <SparkleIcon size={18} />
                <p>
                  Describe the data you need and I&apos;ll write the SQL. I can
                  see the schema of the selected database and your active editor
                  file, and I can run read-only queries to verify results —
                  changes to your data always ask for approval first.
                </p>
              </div>
            )}
            {transcript.map((msg) => (
              <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
                {msg.parts.map((part, i) => {
                  if (part.kind === 'text') {
                    return msg.role === 'assistant' ? (
                      <AssistantText
                        key={i}
                        text={part.text}
                        onInsert={insertSql}
                      />
                    ) : (
                      <div key={i} className="chat-prose">
                        {part.text}
                      </div>
                    )
                  }
                  if (part.kind === 'tool') {
                    return (
                      <div
                        key={i}
                        className={`chat-tool chat-tool--${part.status}`}
                        title={part.sql}
                      >
                        <PlayIcon size={9} />
                        <code>
                          {part.sql.replace(/\s+/g, ' ').slice(0, 60)}
                        </code>
                        <span className="chat-tool__summary">
                          {part.status === 'running'
                            ? 'running…'
                            : part.summary}
                        </span>
                      </div>
                    )
                  }
                  if (part.kind === 'approval') {
                    return (
                      <div
                        key={i}
                        className={`chat-approval chat-approval--${part.status}`}
                      >
                        <div className="chat-approval__title">
                          This statement modifies the database
                        </div>
                        <pre>{part.sql}</pre>
                        {part.status === 'pending' ? (
                          <div className="chat-approval__actions">
                            <button
                              type="button"
                              className="btn-run"
                              onClick={() => answerApproval(part.toolId, true)}
                            >
                              Run it
                            </button>
                            <button
                              type="button"
                              onClick={() => answerApproval(part.toolId, false)}
                            >
                              Deny
                            </button>
                          </div>
                        ) : (
                          <div className="chat-approval__status">
                            {part.status === 'approved' ? 'Approved' : 'Denied'}
                          </div>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div key={i} className="chat-error">
                      {part.text}
                    </div>
                  )
                })}
              </div>
            ))}
            {thinking && busy && (
              <div className="chat__thinking">Thinking…</div>
            )}
          </div>
          <div className="chat__composer">
            <div className="composer__box">
              <div className="composer__chips">
                {context.map((item) => {
                  const key = agentContextKey(item)
                  const qualified = item.schema
                    ? `${item.schema}.${item.name}`
                    : item.name
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
                      <span className="chip__sub">
                        {CHIP_KIND_LABEL[item.kind]}
                      </span>
                      <button
                        type="button"
                        className="chip__x"
                        title="Remove from thread"
                        onClick={() => onRemoveContext(key)}
                      >
                        <CloseIcon size={10} />
                      </button>
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
              <textarea
                className="composer__input"
                placeholder={
                  target
                    ? `Ask for SQL against ${target.connName}/${target.database}…`
                    : 'Ask for SQL… (no database connected)'
                }
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
                        <span className="model-pill__effort">
                          {EFFORT_LABEL[effort]}
                        </span>
                      </>
                    )}
                    <ChevronDownIcon size={10} />
                  </button>
                  {modelOpen && (
                    <>
                      <div
                        className="ctx-overlay"
                        onMouseDown={() => setModelOpen(false)}
                      />
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
                            <div className="model-pop__heading">
                              Reasoning effort
                            </div>
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
                <select
                  className="toolbar-select composer__target"
                  title="Connection and database the agent works against"
                  value={selectedTargetKey ?? ''}
                  onChange={(e) => setSelectedTargetKey(e.target.value || null)}
                  disabled={targets.length === 0}
                >
                  {targets.length === 0 && (
                    <option value="">No connection</option>
                  )}
                  {targets.map((t) => (
                    <option key={targetKey(t)} value={targetKey(t)}>
                      {t.connName} / {t.database}
                    </option>
                  ))}
                </select>
                <div className="composer__spacer" />
                {busy ? (
                  <button
                    type="button"
                    className="composer__send"
                    title="Stop"
                    onClick={stop}
                  >
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="composer__send"
                    title="Send (⏎)"
                    disabled={!input.trim()}
                    onClick={send}
                  >
                    <ArrowUpIcon />
                  </button>
                )}
              </div>
              {pickerOpen && (
                <>
                  <div
                    className="ctx-overlay"
                    onMouseDown={() => setPickerOpen(false)}
                  />
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
                          {intro
                            ? 'Nothing left to add'
                            : 'Loading schema objects…'}
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
                            {item.schema
                              ? `${item.schema}.${item.name}`
                              : item.name}
                          </span>
                          <span className="picker-pop__kind">
                            {CHIP_KIND_LABEL[item.kind]}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
