import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MutableRefObject, ReactElement } from 'react'

import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL
} from '../../../shared/agent'
import type { AgentEffort, AgentEvent, AgentKeyStatus } from '../../../shared/agent'
import type { QueryResult } from '../../../shared/db'
import type { FileState } from '../files/useFileState'
import type { EditorBridge } from './editorBridge'
import type { QueryTarget } from './useQueryRunner'
import { PlayIcon, PlusThinIcon, SparkleIcon } from './icons'
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
  onAgentQuery
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
  const [allowRun, setAllowRun] = useState(false)
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null)
  const [keyStatus, setKeyStatus] = useState<AgentKeyStatus | null>(null)
  const [input, setInput] = useState('')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const onAgentQueryRef = useRef(onAgentQuery)
  onAgentQueryRef.current = onAgentQuery

  const model =
    AGENT_MODELS.find((m) => m.id === modelId) ?? DEFAULT_AGENT_MODEL
  const target =
    targets.find((t) => targetKey(t) === selectedTargetKey) ?? null

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
        case 'done':
          setBusy(false)
          setThinking(false)
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
            appendPart(prev, { kind: 'error', text: evt.message })
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
      { id: nextId('m'), role: 'user', parts: [{ kind: 'text', text: prompt }] },
      { id: nextId('m'), role: 'assistant', parts: [] }
    ])
    const editor = editorBridge.current?.getActiveSql() ?? null
    void window.dbDesk.agent.send({
      chatId,
      prompt,
      model: model.id,
      effort: effort && model.efforts.includes(effort) ? effort : null,
      allowRun,
      target: target
        ? {
            connId: target.connId,
            connName: target.connName,
            database: target.database
          }
        : null,
      editor
    })
  }, [input, busy, chatId, model, effort, allowRun, target, editorBridge])

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
          <div className="chat__settings">
            <select
              className="toolbar-select"
              title="Model"
              value={model.id}
              onChange={(e) => {
                const next =
                  AGENT_MODELS.find((m) => m.id === e.target.value) ??
                  DEFAULT_AGENT_MODEL
                setModelId(next.id)
                setEffort((cur) =>
                  cur && next.efforts.includes(cur) ? cur : next.defaultEffort
                )
              }}
            >
              {AGENT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              className="toolbar-select"
              title="Reasoning effort"
              value={effort ?? ''}
              disabled={effortOptions.length === 0}
              onChange={(e) =>
                setEffort((e.target.value || null) as AgentEffort | null)
              }
            >
              {effortOptions.length === 0 && <option value="">—</option>}
              {effortOptions.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl}
                </option>
              ))}
            </select>
            <select
              className="toolbar-select chat__target"
              title="Connection and database the agent works against"
              value={selectedTargetKey ?? ''}
              onChange={(e) => setSelectedTargetKey(e.target.value || null)}
              disabled={targets.length === 0}
            >
              {targets.length === 0 && <option value="">No connection</option>}
              {targets.map((t) => (
                <option key={targetKey(t)} value={targetKey(t)}>
                  {t.connName} / {t.database}
                </option>
              ))}
            </select>
          </div>
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
                  see the schema of the selected database and your active
                  editor file{allowRun ? ', and I can run queries to verify results' : ''}.
                </p>
              </div>
            )}
            {transcript.map((msg) => (
              <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
                {msg.parts.map((part, i) => {
                  if (part.kind === 'text') {
                    return msg.role === 'assistant' ? (
                      <AssistantText key={i} text={part.text} onInsert={insertSql} />
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
                        <code>{part.sql.replace(/\s+/g, ' ').slice(0, 60)}</code>
                        <span className="chat-tool__summary">
                          {part.status === 'running' ? 'running…' : part.summary}
                        </span>
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
            {thinking && busy && <div className="chat__thinking">Thinking…</div>}
          </div>
          <div className="chat__composer">
            <label className="chat__allow" title="When enabled, the agent may execute queries against the selected database; each run appears in the results grid so you can verify the output.">
              <input
                type="checkbox"
                checked={allowRun}
                onChange={(e) => setAllowRun(e.target.checked)}
              />
              Allow running queries &amp; validating results in the grid
            </label>
            <textarea
              className="chat__input"
              placeholder={
                target
                  ? `Ask for SQL against ${target.connName}/${target.database}…`
                  : 'Ask for SQL… (no database connected)'
              }
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <div className="chat__actions">
              <span className="chat__hint">⏎ send · ⇧⏎ newline</span>
              {busy ? (
                <button className="btn-run" type="button" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button
                  className="btn-run"
                  type="button"
                  disabled={!input.trim()}
                  onClick={send}
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
