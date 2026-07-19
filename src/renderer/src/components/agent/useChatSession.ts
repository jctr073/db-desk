import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'

import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODE,
  DEFAULT_AGENT_MODEL,
  resolveAgentMode
} from '../../../../shared/agent'
import type {
  AgentContextItem,
  AgentEffort,
  AgentEvent,
  AgentMode,
  AgentPromptIntent
} from '../../../../shared/agent'
import type { AgentCapability, QueryResult } from '../../../../shared/db'
import type { RepoStatus } from '../../../../shared/repo'
import { lastSqlFence } from '../agentTurn'
import type { TurnRecap } from '../agentTurn'
import type { EditorBridge } from '../editorBridge'
import type { QueryTarget } from '../useQueryRunner'
import { effectiveAgentMode } from './agentMode'

export type ChatPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      toolId: string
      /** Tool name from the wire event (e.g. "run_sql", "search_knowledge"). */
      name: string
      sql: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string }
  | TurnRecap

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ChatPart[]
}

export interface ArchivedChat {
  id: string
  messages: ChatMessage[]
  contextTokens: number
  createdAt: number
  updatedAt: number
  modelId: string
  effort: AgentEffort | null
  mode: AgentMode
  webSearch: boolean
  repoEnabled: boolean
  draft: string
  draftIntent: AgentPromptIntent
}

let idSeq = 0
function nextId(prefix: string): string {
  return `${prefix}${++idSeq}`
}

export const MODE_STORAGE_KEY = 'agent.mode'

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

interface ChatSessionParams {
  /** The app-wide active connection + database; the session follows this. */
  target: QueryTarget | null
  /** Objects attached to the thread as context chips. */
  context: AgentContextItem[]
  editorBridge: MutableRefObject<EditorBridge | null>
  /** Mirrors an agent-executed query into the results grid. */
  onAgentQuery: (
    sql: string,
    target: QueryTarget,
    result: QueryResult | null,
    error: string | null
  ) => void
  /**
   * Called when a turn that ran at least one query finishes, so the results
   * grid can mark the turn's last run as the final one.
   */
  onAgentTurnEnd?: () => void
  /** The codebase status of a target's default base, or null when it has none. */
  repoStatusFor: (connId: string | undefined, database: string | undefined) => RepoStatus | null
  /**
   * Agent access decided for the active connection; null when there is none
   * or it isn't connected. Drives `effectiveMode` — the clamp itself is
   * enforced authoritatively in main, this only keeps the UI honest about it.
   */
  agentCapability: AgentCapability | null
}

export type ChatSession = ReturnType<typeof useChatSession>

/**
 * The agent chat session: transcript state, the once-registered agent event
 * subscription, per-chat settings (model, mode, tools), and the chat-history
 * archive. Extracted from AgentPanel; the panel and the composer render it.
 * The return type is inferred so ChatSession stays in sync with the body.
 */
export function useChatSession({
  target,
  context,
  editorBridge,
  onAgentQuery,
  onAgentTurnEnd,
  repoStatusFor,
  agentCapability
}: ChatSessionParams) {
  const [chatId, setChatId] = useState(() => nextId('chat'))
  const [chatCreatedAt, setChatCreatedAt] = useState(() => Date.now())
  const [chatUpdatedAt, setChatUpdatedAt] = useState(() => Date.now())
  const [chatHistory, setChatHistory] = useState<ArchivedChat[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [contextTokens, setContextTokens] = useState(0)
  const [modelId, setModelId] = useState(DEFAULT_AGENT_MODEL.id)
  const [effort, setEffort] = useState<AgentEffort | null>(DEFAULT_AGENT_MODEL.defaultEffort)
  const [input, setInput] = useState('')
  const [draftIntent, setDraftIntent] = useState<AgentPromptIntent>('chat')
  const [mode, setMode] = useState<AgentMode>(() => {
    try {
      return resolveAgentMode(localStorage.getItem(MODE_STORAGE_KEY))
    } catch {
      return DEFAULT_AGENT_MODE
    }
  })
  // Off by default: web browsing is opt-in per session.
  const [webSearch, setWebSearch] = useState(false)
  // On by default: once a codebase is attached, using it is opt-out per chat.
  const [repoEnabled, setRepoEnabled] = useState(true)

  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const onAgentQueryRef = useRef(onAgentQuery)
  onAgentQueryRef.current = onAgentQuery
  const onAgentTurnEndRef = useRef(onAgentTurnEnd)
  onAgentTurnEndRef.current = onAgentTurnEnd
  /**
   * Running tally of the in-flight turn, kept in refs so the event handler
   * (mounted once) can build the end-of-turn recap without touching state.
   * Reset by sendPrompt; the assistant's streamed text is accumulated so the
   * final SQL fence can be recovered when write_to_editor was never called.
   */
  const turnStats = useRef({
    startedAt: 0,
    toolCount: 0,
    queryCount: 0,
    text: '',
    editorProposal: null as 'applied' | 'pending' | null
  })

  const model = AGENT_MODELS.find((m) => m.id === modelId) ?? DEFAULT_AGENT_MODEL
  /**
   * What actually runs: `mode` (and its localStorage mirror) stay untouched
   * by clamping, so a stored Read-Only preference survives a round trip
   * through a clamped production connection.
   */
  const effectiveMode = useMemo(
    () => effectiveAgentMode(mode, agentCapability),
    [mode, agentCapability]
  )

  useEffect(() => {
    const unsubscribe = window.dbDesk.agent.onEvent((evt: AgentEvent) => {
      if (evt.chatId !== chatIdRef.current) return
      switch (evt.type) {
        case 'turn_start':
          break
        case 'text_delta':
          setThinking(false)
          turnStats.current.text += evt.text
          setMessages((prev) => appendText(prev, evt.text))
          break
        case 'thinking':
          setThinking(evt.active)
          break
        case 'tool_start':
          setThinking(false)
          turnStats.current.toolCount += 1
          setMessages((prev) =>
            appendPart(prev, {
              kind: 'tool',
              toolId: evt.toolId,
              name: evt.name,
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
          turnStats.current.queryCount += 1
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
        case 'editor_proposal': {
          const outcome = editorBridge.current?.proposeSql(evt.sql) ?? 'unavailable'
          if (outcome === 'applied' || outcome === 'pending') {
            turnStats.current.editorProposal = outcome
          }
          setMessages((prev) =>
            appendPart(
              prev,
              outcome === 'applied'
                ? { kind: 'notice', text: 'SQL written to the editor.' }
                : outcome === 'pending'
                  ? {
                      kind: 'notice',
                      text: 'Edit proposed — review the diff in the editor and Accept or Reject.'
                    }
                  : {
                      kind: 'error',
                      text: 'No SQL editor available to write into — use Insert on the code block instead.'
                    }
            )
          )
          break
        }
        case 'done': {
          setBusy(false)
          setThinking(false)
          if (evt.contextTokens !== null) setContextTokens(evt.contextTokens)
          if (evt.stopReason === 'refusal') {
            setMessages((prev) =>
              appendPart(prev, {
                kind: 'error',
                text: 'The request was declined by the model.'
              })
            )
          }
          const stats = turnStats.current
          let editor: TurnRecap['editor'] = stats.editorProposal
          let finalSql: string | null = null
          // The model ended with SQL in prose instead of write_to_editor:
          // load it into a blank editor directly (same review path as the
          // tool), or surface a one-click load button in the recap.
          if (!editor && evt.stopReason === 'end_turn') {
            const fence = lastSqlFence(stats.text)
            if (fence) {
              const live = editorBridge.current?.getActiveSql() ?? null
              if (live && live.sql.trim() === fence.trim()) {
                editor = 'already'
              } else if (live && live.sql.trim() === '') {
                const outcome = editorBridge.current?.proposeSql(fence)
                if (outcome === 'applied' || outcome === 'pending') {
                  editor = outcome
                } else {
                  finalSql = fence
                }
              } else {
                finalSql = fence
              }
            }
          }
          setMessages((prev) =>
            appendPart(prev, {
              kind: 'recap',
              status: evt.stopReason === 'aborted' ? 'stopped' : 'done',
              elapsedMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
              toolCount: stats.toolCount,
              queryCount: stats.queryCount,
              editor,
              finalSql
            })
          )
          if (stats.queryCount > 0) onAgentTurnEndRef.current?.()
          break
        }
        case 'error': {
          setBusy(false)
          setThinking(false)
          setMessages((prev) => appendPart(prev, { kind: 'error', text: evt.message }))
          // Only recap turns that got somewhere; an immediate failure (e.g.
          // missing API key) is fully told by the error box alone.
          const stats = turnStats.current
          if (stats.toolCount > 0 || stats.text) {
            setMessages((prev) =>
              appendPart(prev, {
                kind: 'recap',
                status: 'error',
                elapsedMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
                toolCount: stats.toolCount,
                queryCount: stats.queryCount,
                editor: stats.editorProposal,
                finalSql: null
              })
            )
          }
          break
        }
      }
    })
    return unsubscribe
  }, [editorBridge])

  /** "Load final query" on a recap: same review path as write_to_editor. */
  const loadFinalSql = useCallback(
    (recap: TurnRecap) => {
      if (!recap.finalSql) return
      const outcome = editorBridge.current?.proposeSql(recap.finalSql) ?? 'unavailable'
      if (outcome === 'unavailable') return
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          parts: msg.parts.map((p) =>
            p === recap ? { ...recap, editor: outcome, finalSql: null } : p
          )
        }))
      )
    },
    [editorBridge]
  )

  /** The user's most recent prompt, prefilled as the exemplar's question. */
  const lastUserPrompt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'user') continue
      const text = msg.parts.find((p) => p.kind === 'text')
      if (text && text.kind === 'text') return text.text
    }
    return ''
  }, [messages])

  /** Sends `prompt` as a normal user turn; shared by the composer and the
   * "Scan codebase" action so a scan appears in the transcript exactly as if
   * typed. */
  const sendPrompt = useCallback(
    (
      prompt: string,
      promptTarget: QueryTarget | null = target,
      forceRepo = false,
      intent: AgentPromptIntent = 'chat',
      /** Active base for the turn; scans set it so writes land in the right base. */
      kbId: string | null = null
    ) => {
      if (!prompt || busy || compacting) return
      setBusy(true)
      turnStats.current = {
        startedAt: Date.now(),
        toolCount: 0,
        queryCount: 0,
        text: '',
        editorProposal: null
      }
      setChatUpdatedAt(Date.now())
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
      const editorSelection = editorBridge.current?.getSelection() ?? null
      void window.dbDesk.agent.send({
        chatId,
        prompt,
        intent,
        model: model.id,
        effort: effort && model.efforts.includes(effort) ? effort : null,
        mode: effectiveMode,
        webSearch,
        repo:
          !!promptTarget &&
          !!repoStatusFor(promptTarget.connId, promptTarget.database)?.root &&
          (forceRepo || repoEnabled),
        target: promptTarget
          ? {
              connId: promptTarget.connId,
              connName: promptTarget.connName,
              database: promptTarget.database,
              ...(kbId ? { kbId } : {})
            }
          : null,
        editor,
        editorSelection,
        context
      })
    },
    [
      busy,
      compacting,
      chatId,
      model,
      effort,
      effectiveMode,
      webSearch,
      repoStatusFor,
      repoEnabled,
      target,
      editorBridge,
      context
    ]
  )

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || busy || compacting) return
    setInput('')
    setDraftIntent('chat')
    sendPrompt(prompt, target, false, draftIntent)
  }, [input, busy, compacting, sendPrompt, target, draftIntent])

  const stop = useCallback(() => {
    void window.dbDesk.agent.stop(chatId)
  }, [chatId])

  const currentChatSnapshot = useCallback(
    (): ArchivedChat => ({
      id: chatId,
      messages,
      contextTokens,
      createdAt: chatCreatedAt,
      updatedAt: chatUpdatedAt,
      modelId,
      effort,
      mode,
      webSearch,
      repoEnabled,
      draft: input,
      draftIntent
    }),
    [
      chatId,
      messages,
      contextTokens,
      chatCreatedAt,
      chatUpdatedAt,
      modelId,
      effort,
      mode,
      webSearch,
      repoEnabled,
      input,
      draftIntent
    ]
  )

  const newChat = useCallback(() => {
    if (busy || compacting) return
    const current = currentChatSnapshot()
    if (current.messages.length > 0 || current.draft.trim()) {
      setChatHistory((previous) => [current, ...previous.filter((chat) => chat.id !== current.id)])
    }
    const now = Date.now()
    setChatId(nextId('chat'))
    setChatCreatedAt(now)
    setChatUpdatedAt(now)
    setMessages([])
    setBusy(false)
    setThinking(false)
    setContextTokens(0)
    setInput('')
    setDraftIntent('chat')
    setHistoryOpen(false)
  }, [busy, compacting, currentChatSnapshot])

  const openChat = useCallback(
    (nextChat: ArchivedChat) => {
      if (busy || compacting || nextChat.id === chatId) return
      const current = currentChatSnapshot()
      setChatHistory((previous) => {
        const withoutNext = previous.filter(
          (chat) => chat.id !== nextChat.id && chat.id !== current.id
        )
        return current.messages.length > 0 || current.draft.trim()
          ? [current, ...withoutNext]
          : withoutNext
      })
      setChatId(nextChat.id)
      setChatCreatedAt(nextChat.createdAt)
      setChatUpdatedAt(nextChat.updatedAt)
      setMessages(nextChat.messages)
      setContextTokens(nextChat.contextTokens)
      setModelId(nextChat.modelId)
      setEffort(nextChat.effort)
      setMode(nextChat.mode)
      setWebSearch(nextChat.webSearch)
      setRepoEnabled(nextChat.repoEnabled)
      setInput(nextChat.draft)
      setDraftIntent(nextChat.draftIntent ?? 'chat')
      setBusy(false)
      setThinking(false)
      setCompacting(false)
      setHistoryOpen(false)
    },
    [busy, compacting, chatId, currentChatSnapshot]
  )

  const runCompact = useCallback(async () => {
    if (busy || compacting) return
    const id = chatId
    setCompacting(true)
    const res = await window.dbDesk.agent.compact(id, model.id)
    setCompacting(false)
    // The chat may have been cleared while the summary was being written.
    if (chatIdRef.current !== id) return
    if (res.ok) {
      setContextTokens(res.contextTokens)
      setMessages((prev) => [
        ...prev,
        {
          id: nextId('m'),
          role: 'assistant',
          parts: [{ kind: 'notice', text: 'Context compacted' }]
        }
      ])
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId('m'),
          role: 'assistant',
          parts: [{ kind: 'error', text: res.error }]
        }
      ])
    }
  }, [busy, compacting, chatId, model.id])

  return {
    messages,
    chatHistory,
    historyOpen,
    setHistoryOpen,
    busy,
    thinking,
    compacting,
    contextTokens,
    model,
    setModelId,
    effort,
    setEffort,
    input,
    setInput,
    draftIntent,
    setDraftIntent,
    mode,
    setMode,
    effectiveMode,
    webSearch,
    setWebSearch,
    repoEnabled,
    setRepoEnabled,
    lastUserPrompt,
    sendPrompt,
    send,
    stop,
    newChat,
    openChat,
    runCompact,
    loadFinalSql
  }
}
