import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent,
  MutableRefObject,
  ReactElement,
  ReactNode
} from 'react'

import {
  AGENT_MODELS,
  AGENT_MODES,
  AGENT_SLASH_COMMANDS,
  API_KEY_VAR,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_MODE,
  agentContextKey,
  resolveAgentMode
} from '../../../shared/agent'
import type {
  AgentContextItem,
  AgentDbObjectItem,
  AgentDbObjectKind,
  AgentEffort,
  AgentEvent,
  AgentKeyStatus,
  AgentMode,
  AgentModeOption,
  AgentModelOption,
  AgentPromptIntent
} from '../../../shared/agent'
import type { DatabaseIntrospection, QueryResult } from '../../../shared/db'
import type { McpServerStatus } from '../../../shared/mcp'
import { REPO_SCAN_PROMPT } from '../../../shared/repo'
import type { RepoStatus } from '../../../shared/repo'
import { NodeIcon } from '../connections/NodeIcon'
import { KIND_LABELS, isKnownKind, recordTitle } from '../knowledge/format'
import { KnowledgePanel } from '../knowledge/KnowledgePanel'
import {
  knowledgeTargetKeyOf,
  useKnowledgeState
} from '../knowledge/useKnowledgeState'
import type {
  KnowledgeNav,
  KnowledgeState
} from '../knowledge/useKnowledgeState'
import { highlightSql, stripSqlComments } from '../sql/highlight'
import type { FileState } from '../files/useFileState'
import type { EditorBridge } from './editorBridge'
import type { QueryTarget } from './useQueryRunner'
import {
  ArrowUpIcon,
  BookIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  GlobeIcon,
  HistoryIcon,
  NewChatIcon,
  PlayIcon,
  PlugIcon,
  PlusThinIcon,
  SearchIcon,
  ShieldIcon,
  SparkleIcon,
  SqlFileIcon,
  StopIcon
} from './icons'
import { FilesPanel } from './FilesPanel'
import { KbRefContext, Markdown } from './MarkdownText'
import { McpSettingsDialog } from './McpSettingsDialog'
import { SaveExemplarDialog } from './SaveExemplarDialog'

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
  /** Knowledge records + usage index for the knowledge tab's target. */
  knowledge: KnowledgeState
  knowledgeTargetKey: string | null
  onKnowledgeTargetChange: (key: string | null) => void
  /** Pending "Show usages" / "Add annotation…" request from the schema tree. */
  knowledgeNav: KnowledgeNav | null
  /** Clears the pending nav once KnowledgePanel has acted on it (one-shot). */
  onKnowledgeNavConsumed: () => void
  /** [kb:id] citation chip clicked: reveal that record in the knowledge tab. */
  onOpenKnowledgeRecord: (
    connId: string,
    database: string,
    recordId: string
  ) => void
  /**
   * One-shot composer prefill (e.g. "Fix with AI" from the results grid).
   * A new seq reveals the agent tab and replaces the draft; never replayed.
   */
  seed?: {
    seq: number
    text: string
    intent: AgentPromptIntent
    target?: { connId: string; database: string }
  } | null
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

const CHIP_KIND_LABEL: Record<AgentDbObjectKind, string> = {
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
      /** Tool name from the wire event (e.g. "run_sql", "search_knowledge"). */
      name: string
      sql: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string }

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ChatPart[]
}

interface ArchivedChat {
  id: string
  messages: ChatMessage[]
  contextTokens: number
  createdAt: number
  updatedAt: number
  selectedTargetKey: string | null
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

const MODE_STORAGE_KEY = 'agent.mode'

function targetKey(target: QueryTarget): string {
  return JSON.stringify([target.connId, target.database])
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

/** Last path segment of a repo root, for display — renderer never parses paths. */
function repoRootName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

interface ToolMeta {
  /** Short action label rendered as the chip's leading badge. */
  label: string
  Icon: (props: { size?: number }) => ReactElement
  /** True when the detail text is SQL and should be token-colored. */
  sqlish: boolean
}

/** How each tool renders in the transcript, keyed by wire tool name. */
const TOOL_META: Record<string, ToolMeta> = {
  run_sql: { label: 'Run SQL', Icon: PlayIcon, sqlish: true },
  explain_query: { label: 'Explain', Icon: PlayIcon, sqlish: true },
  describe_table: { label: 'Describe', Icon: SearchIcon, sqlish: false },
  search_schema: { label: 'Schema', Icon: SearchIcon, sqlish: false },
  search_knowledge: { label: 'Knowledge', Icon: BookIcon, sqlish: false },
  save_knowledge: { label: 'Knowledge', Icon: BookIcon, sqlish: false },
  write_to_editor: { label: 'Editor', Icon: SqlFileIcon, sqlish: true },
  read_editor: { label: 'Editor', Icon: SqlFileIcon, sqlish: false },
  list_repo_files: { label: 'Codebase', Icon: FolderIcon, sqlish: false },
  grep_repo: { label: 'Codebase', Icon: FolderIcon, sqlish: false },
  read_repo_file: { label: 'Codebase', Icon: FolderIcon, sqlish: false },
  web_search: { label: 'Web', Icon: GlobeIcon, sqlish: false }
}

function toolMeta(name: string): ToolMeta {
  if (name.startsWith('mcp__')) {
    return { label: 'MCP', Icon: PlugIcon, sqlish: false }
  }
  return TOOL_META[name] ?? { label: 'Tool', Icon: PlayIcon, sqlish: false }
}

/** The badge already names the tool, so drop the redundant label prefix. */
function toolDetail(name: string, sql: string): string {
  switch (name) {
    case 'search_knowledge':
      return sql.replace(/^search knowledge /, '')
    case 'save_knowledge':
      return sql.replace(/^(save|update) knowledge /, '$1 ')
    case 'web_search':
      return sql.replace(/^web search /, '')
    case 'describe_table':
      return sql.replace(/^describe /, '')
    case 'search_schema':
      return sql.replace(/^search /, '')
    case 'list_repo_files':
    case 'grep_repo':
    case 'read_repo_file':
      return sql.replace(/^repo: /, '')
    default:
      return sql
  }
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

/** SQL text with editor-palette token coloring (see --sql-* tokens). */
function SqlCode({ sql }: { sql: string }): ReactElement {
  const segments = useMemo(() => highlightSql(sql), [sql])
  return (
    <>
      {segments.map((seg, i) =>
        seg.cls ? (
          <span key={i} className={`sql-${seg.cls}`}>
            {seg.text}
          </span>
        ) : (
          seg.text
        )
      )}
    </>
  )
}

function AssistantText({
  text,
  onInsert,
  onSaveExemplar
}: {
  text: string
  onInsert: (sql: string) => void
  /** Present only when a target is connected: adds a "Save as exemplar" action. */
  onSaveExemplar?: (sql: string) => void
}): ReactElement {
  return (
    <>
      {splitFences(text).map((seg, i) =>
        seg.code ? (
          <div key={i} className="chat-sql">
            <pre>
              <SqlCode sql={seg.body.trimEnd()} />
            </pre>
            <div className="chat-sql__actions">
              <button
                type="button"
                title="Insert into the active SQL editor at the cursor"
                onClick={() => onInsert(seg.body.trimEnd())}
              >
                Insert
              </button>
              {onSaveExemplar && (
                <button
                  type="button"
                  title="Save this query as a reusable exemplar"
                  onClick={() => onSaveExemplar(seg.body.trimEnd())}
                >
                  Save as exemplar
                </button>
              )}
            </div>
          </div>
        ) : (
          seg.body.trim() && (
            <div key={i} className="chat-prose">
              <Markdown text={seg.body.trim()} />
            </div>
          )
        )
      )}
    </>
  )
}

const GAUGE_RADIUS = 11
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS

/** Ring gauge showing how full the model's context window is. */
function ContextGauge({
  tokens,
  windowSize
}: {
  tokens: number
  windowSize: number
}): ReactElement {
  const percent = Math.min(100, Math.round((tokens / windowSize) * 100))
  const level = percent >= 90 ? ' is-danger' : percent >= 70 ? ' is-warn' : ''
  return (
    <div
      className={`context-gauge${level}`}
      title={`Context: ${tokens.toLocaleString()} of ${windowSize.toLocaleString()} tokens (${percent}%)`}
    >
      <svg viewBox="0 0 26 26" width={26} height={26}>
        <circle
          className="context-gauge__track"
          cx="13"
          cy="13"
          r={GAUGE_RADIUS}
        />
        <circle
          className="context-gauge__fill"
          cx="13"
          cy="13"
          r={GAUGE_RADIUS}
          strokeDasharray={GAUGE_CIRCUMFERENCE}
          strokeDashoffset={GAUGE_CIRCUMFERENCE * (1 - percent / 100)}
          transform="rotate(-90 13 13)"
        />
      </svg>
      <span className="context-gauge__label">{percent}%</span>
    </div>
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
  ensureSchema,
  knowledge,
  knowledgeTargetKey,
  onKnowledgeTargetChange,
  knowledgeNav,
  onKnowledgeNavConsumed,
  onOpenKnowledgeRecord,
  seed
}: AgentPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'files' | 'agent' | 'knowledge'>(
    'agent'
  )
  const [knowledgeNewSeq, setKnowledgeNewSeq] = useState(0)
  const consumeKnowledgeNewSeq = useCallback(() => setKnowledgeNewSeq(0), [])
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
  const [slashIndex, setSlashIndex] = useState(0)
  const [modelId, setModelId] = useState(DEFAULT_AGENT_MODEL.id)
  const [effort, setEffort] = useState<AgentEffort | null>(
    DEFAULT_AGENT_MODEL.defaultEffort
  )
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(
    null
  )
  const [keyStatus, setKeyStatus] = useState<AgentKeyStatus | null>(null)
  const [input, setInput] = useState('')
  const [draftIntent, setDraftIntent] = useState<AgentPromptIntent>('chat')
  const [modelOpen, setModelOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFilter, setPickerFilter] = useState('')
  const [mode, setMode] = useState<AgentMode>(() => {
    try {
      return resolveAgentMode(localStorage.getItem(MODE_STORAGE_KEY))
    } catch {
      return DEFAULT_AGENT_MODE
    }
  })
  const [modeOpen, setModeOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false)
  /** SQL captured from a chat code block for the "Save as exemplar" dialog. */
  const [exemplarSql, setExemplarSql] = useState<string | null>(null)
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  // Off by default: web browsing is opt-in per session.
  const [webSearch, setWebSearch] = useState(false)
  const [repoStatuses, setRepoStatuses] = useState<Record<string, RepoStatus>>(
    {}
  )
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)
  // On by default: once a codebase is attached, using it is opt-out per chat.
  const [repoEnabled, setRepoEnabled] = useState(true)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const onAgentQueryRef = useRef(onAgentQuery)
  onAgentQueryRef.current = onAgentQuery

  const model =
    AGENT_MODELS.find((m) => m.id === modelId) ?? DEFAULT_AGENT_MODEL
  const modeOption = AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[0]
  const target = targets.find((t) => targetKey(t) === selectedTargetKey) ?? null
  /** Where the files tab's "+" puts a new file: the chat's target, else primary. */
  const fileHome =
    target ?? targets.find((t) => t.primary) ?? targets[0] ?? null
  const knowledgeTarget =
    targets.find(
      (t) => knowledgeTargetKeyOf(t.connId, t.database) === knowledgeTargetKey
    ) ?? null
  const knowledgeRepoStatus = knowledgeTarget
    ? (repoStatuses[knowledgeTarget.connId] ?? null)
    : null

  // Knowledge records for the CHAT target — the knowledge tab may be viewing
  // a different database — so [kb:id] citations in assistant prose resolve to
  // live records (and pick up renames/deletes via knowledge:changed pushes).
  const chatKnowledge = useKnowledgeState(
    target?.connId ?? null,
    target?.database ?? null
  )
  const chatRecordById = useMemo(
    () => new Map(chatKnowledge.records.map((r) => [r.id, r])),
    [chatKnowledge.records]
  )
  const targetRef = useRef(target)
  targetRef.current = target

  /** Renders one [kb:id] citation as a chip linking to the record. */
  const renderKbRef = useCallback(
    (id: string): ReactNode => {
      const record = chatRecordById.get(id)
      if (!record) {
        return (
          <span
            className="kb-cite kb-cite--missing"
            title="Knowledge record not found — it may have been deleted"
          >
            <BookIcon size={9} />
            knowledge
          </span>
        )
      }
      const label = isKnownKind(record.kind)
        ? KIND_LABELS[record.kind]
        : 'Knowledge'
      return (
        <button
          type="button"
          className="kb-cite"
          title={`${label}: ${recordTitle(record)} — click to open in the Knowledge tab`}
          onClick={() => {
            const t = targetRef.current
            if (t) onOpenKnowledgeRecord(t.connId, t.database, record.id)
          }}
        >
          <BookIcon size={9} />
          {label}
        </button>
      )
    },
    [chatRecordById, onOpenKnowledgeRecord]
  )

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
    void window.dbDesk.mcp.list().then(setMcpStatuses)
    return window.dbDesk.mcp.onChanged(setMcpStatuses)
  }, [])

  // Load attachments for both independently selected database targets. The
  // agent toggle follows the chat target; management follows Knowledge.
  useEffect(() => {
    const connIds = [
      ...new Set([target?.connId, knowledgeTarget?.connId])
    ].filter((connId): connId is string => !!connId)
    let cancelled = false
    for (const connId of connIds) {
      void window.dbDesk.repo.get(connId).then((status) => {
        if (cancelled) return
        setRepoStatuses((current) => ({ ...current, [connId]: status }))
        if (connId === target?.connId && status.root) setRepoEnabled(true)
      })
    }
    return () => {
      cancelled = true
    }
  }, [target?.connId, knowledgeTarget?.connId])

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
          const outcome =
            editorBridge.current?.proposeSql(evt.sql) ?? 'unavailable'
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
        case 'done':
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
  }, [messages, thinking, busy, compacting])

  // "Add to Agent Thread" from the connections tree should reveal the chips.
  const prevContextLen = useRef(context.length)
  useEffect(() => {
    if (context.length > prevContextLen.current) setActiveTab('agent')
    prevContextLen.current = context.length
  }, [context.length])

  // "Fix with AI" and friends: prefill the composer and reveal the chat.
  // One-shot per seq so re-renders never replay the last prefill.
  const prevSeedSeq = useRef(0)
  useEffect(() => {
    if (!seed || seed.seq === prevSeedSeq.current) return
    prevSeedSeq.current = seed.seq
    setActiveTab('agent')
    setInput(seed.text)
    setDraftIntent(seed.intent)
    const requestedTarget = seed.target
    const seedTarget = requestedTarget
      ? targets.find(
          (candidate) =>
            candidate.connId === requestedTarget.connId &&
            candidate.database === requestedTarget.database
        )
      : null
    if (seedTarget) setSelectedTargetKey(targetKey(seedTarget))
  }, [seed, targets])

  // "Show usages" / "Add annotation…" from the tree reveals the knowledge tab.
  const prevNavSeq = useRef(0)
  useEffect(() => {
    if (knowledgeNav && knowledgeNav.seq !== prevNavSeq.current) {
      prevNavSeq.current = knowledgeNav.seq
      setActiveTab('knowledge')
    }
  }, [knowledgeNav])

  // Escape dismisses whichever popover is open.
  useEffect(() => {
    if (!modelOpen && !pickerOpen && !modeOpen && !historyOpen && !repoMenuOpen)
      return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setModelOpen(false)
        setPickerOpen(false)
        setModeOpen(false)
        setHistoryOpen(false)
        setRepoMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modelOpen, pickerOpen, modeOpen, historyOpen, repoMenuOpen])

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

  const pickMode = useCallback((next: AgentModeOption) => {
    if (!next.enabled) return
    setMode(next.id)
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next.id)
    } catch {
      // Persistence is best-effort.
    }
    setModeOpen(false)
  }, [])

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

  const onSaveExemplar = useCallback((sql: string) => {
    setExemplarSql(sql)
  }, [])

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
      intent: AgentPromptIntent = 'chat'
    ) => {
      if (!prompt || busy || compacting) return
      setBusy(true)
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
        mode,
        webSearch,
        repo:
          !!promptTarget &&
          !!repoStatuses[promptTarget.connId]?.root &&
          (forceRepo || repoEnabled),
        target: promptTarget
          ? {
              connId: promptTarget.connId,
              connName: promptTarget.connName,
              database: promptTarget.database
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
      mode,
      webSearch,
      repoStatuses,
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

  const rememberRepoStatus = useCallback((status: RepoStatus) => {
    setRepoStatuses((current) => ({ ...current, [status.connId]: status }))
  }, [])

  /** Opens the native directory picker for a connection. */
  const chooseRepo = useCallback(
    (connId: string) => {
      void window.dbDesk.repo.choose(connId).then((status) => {
        rememberRepoStatus(status)
        if (status.root && connId === target?.connId) setRepoEnabled(true)
      })
    },
    [rememberRepoStatus, target?.connId]
  )

  /** Detaches the codebase from the target's connection. */
  const clearRepo = useCallback(
    (connId: string) => {
      void window.dbDesk.repo.clear(connId).then(rememberRepoStatus)
    },
    [rememberRepoStatus]
  )

  const scanCodebase = useCallback(() => {
    if (!knowledgeTarget || !knowledgeRepoStatus?.root || busy || compacting) {
      return
    }
    setSelectedTargetKey(targetKey(knowledgeTarget))
    setRepoEnabled(true)
    setActiveTab('agent')
    sendPrompt(REPO_SCAN_PROMPT, knowledgeTarget, true)
  }, [knowledgeTarget, knowledgeRepoStatus, busy, compacting, sendPrompt])

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
      selectedTargetKey,
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
      selectedTargetKey,
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
      setChatHistory((previous) => [
        current,
        ...previous.filter((chat) => chat.id !== current.id)
      ])
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
      setSelectedTargetKey(nextChat.selectedTargetKey)
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

  // Slash-command menu: open while the input is nothing but "/" + letters.
  const slashMatches = useMemo(() => {
    const m = /^\/([a-z]*)$/i.exec(input)
    if (!m) return []
    const q = m[1].toLowerCase()
    return AGENT_SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  }, [input])
  const slashSel =
    slashMatches.length > 0 ? Math.min(slashIndex, slashMatches.length - 1) : 0

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

  const runSlashCommand = useCallback(
    (name: string) => {
      setInput('')
      setDraftIntent('chat')
      if (name === 'clear') newChat()
      else if (name === 'compact') void runCompact()
    },
    [newChat, runCompact]
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
          setSlashIndex(
            (slashSel - 1 + slashMatches.length) % slashMatches.length
          )
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
    [send, slashMatches, slashSel, runSlashCommand]
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
        <button
          className={`agent-tab${activeTab === 'knowledge' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('knowledge')}
        >
          Knowledge
        </button>
        <div className="agent-tabbar__spacer" />
        <button
          className="icon-btn icon-btn--sm"
          title={
            activeTab === 'agent'
              ? 'New chat'
              : activeTab === 'knowledge'
                ? 'New knowledge record'
                : fileHome
                  ? 'New query file'
                  : 'Connect to a database to add a query file'
          }
          disabled={activeTab === 'files' && !fileHome}
          type="button"
          onClick={() => {
            if (activeTab === 'agent') newChat()
            else if (activeTab === 'knowledge') setKnowledgeNewSeq((s) => s + 1)
            else if (fileHome)
              files.createFile(fileHome.connId, fileHome.database)
          }}
        >
          <PlusThinIcon />
        </button>
      </div>
      {activeTab === 'files' ? (
        <FilesPanel files={files} connNames={connNames} />
      ) : activeTab === 'knowledge' ? (
        <KnowledgePanel
          state={knowledge}
          targets={targets}
          targetKey={knowledgeTargetKey}
          onTargetKeyChange={onKnowledgeTargetChange}
          schemas={schemas}
          ensureSchema={ensureSchema}
          nav={knowledgeNav}
          onNavConsumed={onKnowledgeNavConsumed}
          newSeq={knowledgeNewSeq}
          onNewConsumed={consumeKnowledgeNewSeq}
          targetActions={
            <div className="mcp-ctl repo-ctl repo-ctl--knowledge">
              <button
                type="button"
                className={`composer__web mcp-ctl__plug${
                  knowledgeRepoStatus?.root ? ' is-on' : ''
                }`}
                title={
                  !knowledgeTarget
                    ? 'Connect to a database to attach a codebase'
                    : !knowledgeRepoStatus?.root
                      ? 'Attach a local codebase'
                      : `Codebase attached — ${repoRootName(knowledgeRepoStatus.root)}`
                }
                disabled={!knowledgeTarget}
                onClick={() => {
                  if (knowledgeTarget) chooseRepo(knowledgeTarget.connId)
                }}
              >
                <FolderIcon size={14} />
              </button>
              <button
                type="button"
                className="mcp-ctl__chev"
                title="Codebase options"
                aria-label="Codebase options"
                aria-expanded={repoMenuOpen}
                disabled={!knowledgeTarget}
                onClick={() => setRepoMenuOpen((open) => !open)}
              >
                <ChevronDownIcon size={10} />
              </button>
              {repoMenuOpen && knowledgeTarget && (
                <>
                  <div
                    className="ctx-overlay"
                    onMouseDown={() => setRepoMenuOpen(false)}
                  />
                  <div className="model-pop mcp-pop repo-pop">
                    <div className="model-pop__heading">Codebase</div>
                    <div className="mcp-pop__empty repo-pop__info">
                      {knowledgeRepoStatus?.root ? (
                        <>
                          {knowledgeRepoStatus.root}
                          {knowledgeRepoStatus.commit &&
                            ` @ ${knowledgeRepoStatus.commit}`}
                        </>
                      ) : (
                        'No codebase attached.'
                      )}
                    </div>
                    <button
                      type="button"
                      className="model-pop__row"
                      disabled={!knowledgeRepoStatus?.root}
                      title="Send the codebase-scan prompt as a chat message"
                      onClick={() => {
                        setRepoMenuOpen(false)
                        scanCodebase()
                      }}
                    >
                      Scan codebase
                    </button>
                    <button
                      type="button"
                      className="model-pop__row"
                      onClick={() => {
                        setRepoMenuOpen(false)
                        chooseRepo(knowledgeTarget.connId)
                      }}
                    >
                      Change directory…
                    </button>
                    <button
                      type="button"
                      className="model-pop__row"
                      disabled={!knowledgeRepoStatus?.root}
                      onClick={() => {
                        setRepoMenuOpen(false)
                        clearRepo(knowledgeTarget.connId)
                      }}
                    >
                      Detach
                    </button>
                  </div>
                </>
              )}
            </div>
          }
        />
      ) : (
        <div className="chat">
          <div className="chat__target-bar">
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
                  <div
                    className="ctx-overlay"
                    onMouseDown={() => setModeOpen(false)}
                  />
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
                        onClick={() => pickMode(m)}
                      >
                        <span className="mode-pop__text">
                          <span className="mode-pop__label">{m.label}</span>
                          <span className="mode-pop__desc">
                            {m.description}
                          </span>
                        </span>
                        {m.id === mode && <CheckIcon size={13} />}
                      </button>
                    ))}
                    <div className="mode-pop__note">
                      For maximum safety, connect with a read-only database
                      role.
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
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
                  <div
                    className="ctx-overlay"
                    onMouseDown={() => setHistoryOpen(false)}
                  />
                  <div className="chat-history-pop">
                    <div className="chat-history-pop__heading">
                      Chat history
                    </div>
                    <button
                      type="button"
                      className="chat-history-item is-active"
                      disabled
                    >
                      <span className="chat-history-item__title">
                        {chatTitle(messages)}
                      </span>
                      <span className="chat-history-item__meta">Current</span>
                    </button>
                    {chatHistory.length > 0 ? (
                      chatHistory.map((chat) => (
                        <button
                          key={chat.id}
                          type="button"
                          className="chat-history-item"
                          onClick={() => openChat(chat)}
                        >
                          <span className="chat-history-item__title">
                            {chatTitle(chat.messages)}
                          </span>
                          <span className="chat-history-item__meta">
                            {chatTime(chat.updatedAt)}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="chat-history-pop__empty">
                        Previous chats will appear here.
                      </div>
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
              onClick={newChat}
            >
              <NewChatIcon size={18} />
            </button>
          </div>
          {mcpOpen && <McpSettingsDialog onClose={() => setMcpOpen(false)} />}
          {keyMissing && (
            <div className="chat__notice">
              No API key found — add <code>export {API_KEY_VAR}=…</code> to{' '}
              <code>~/.zshrc</code>.
            </div>
          )}
          <KbRefContext.Provider value={renderKbRef}>
            <div className="chat__scroll" ref={scrollRef}>
              {transcript.length === 0 && (
                <div className="chat__empty">
                  <SparkleIcon size={18} />
                  <p>
                    {mode === 'read-only'
                      ? "Describe the data you need and I'll write the SQL. I can see the schema and run read-only queries to verify results. Changing data or schema is blocked."
                      : "Describe the data you need and I'll write the SQL. I can see the schema of the selected database and your active editor file. I never execute anything — you run the SQL."}
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
                          onSaveExemplar={target ? onSaveExemplar : undefined}
                        />
                      ) : (
                        <div key={i} className="chat-prose">
                          {part.text}
                        </div>
                      )
                    }
                    if (part.kind === 'tool') {
                      const meta = toolMeta(part.name)
                      const detail = toolDetail(part.name, part.sql)
                      return (
                        <div
                          key={i}
                          className={`chat-tool chat-tool--${part.status}`}
                          title={part.sql}
                        >
                          <span className="chat-tool__kind">
                            <meta.Icon size={10} />
                            {meta.label}
                          </span>
                          <code>
                            {meta.sqlish ? (
                              <SqlCode
                                sql={stripSqlComments(detail)
                                  .replace(/\s+/g, ' ')
                                  .trim()
                                  .slice(0, 60)}
                              />
                            ) : (
                              detail.slice(0, 60)
                            )}
                          </code>
                          <span className="chat-tool__summary">
                            {part.status === 'running'
                              ? 'running…'
                              : part.summary}
                          </span>
                          {part.status !== 'running' && (
                            <span className="chat-tool__status">
                              {part.status === 'ok' ? (
                                <CheckIcon size={11} />
                              ) : (
                                <CloseIcon size={11} />
                              )}
                            </span>
                          )}
                        </div>
                      )
                    }
                    if (part.kind === 'notice') {
                      return (
                        <div key={i} className="chat-notice">
                          {part.text}
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
              {compacting && (
                <div className="chat__thinking">Compacting context…</div>
              )}
            </div>
          </KbRefContext.Provider>
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
                        <span className="chip__label">
                          {item.fileName ?? 'selection'}
                        </span>
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
                <ContextGauge
                  tokens={contextTokens}
                  windowSize={model.contextWindow}
                />
                <button
                  type="button"
                  className={`composer__web${webSearch ? ' is-on' : ''}`}
                  aria-pressed={webSearch}
                  title={
                    webSearch
                      ? 'Web browsing on — the agent may search the web when the task calls for it'
                      : 'Web browsing off — click to let the agent search the web'
                  }
                  onClick={() => setWebSearch((on) => !on)}
                >
                  <GlobeIcon size={14} />
                </button>
                <div className="mcp-ctl">
                  <button
                    type="button"
                    className={`composer__web mcp-ctl__plug${
                      mcpStatuses.some((s) => s.state === 'running')
                        ? ' is-on'
                        : ''
                    }`}
                    title="MCP servers — configure external tools for the agent"
                    onClick={() => {
                      setMcpMenuOpen(false)
                      setMcpOpen(true)
                    }}
                  >
                    <PlugIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="mcp-ctl__chev"
                    title="Connected MCP servers"
                    aria-label="Connected MCP servers"
                    onClick={() => setMcpMenuOpen((open) => !open)}
                  >
                    <ChevronDownIcon size={10} />
                  </button>
                  {mcpMenuOpen && (
                    <>
                      <div
                        className="ctx-overlay"
                        onMouseDown={() => setMcpMenuOpen(false)}
                      />
                      <div className="model-pop mcp-pop">
                        <div className="model-pop__heading">MCP servers</div>
                        {mcpStatuses.length === 0 && (
                          <div className="mcp-pop__empty">
                            No MCP servers configured.
                          </div>
                        )}
                        {mcpStatuses.map((status) => (
                          <button
                            key={status.config.id}
                            type="button"
                            className="model-pop__row mcp-pop__row"
                            title={
                              status.state === 'error'
                                ? (status.error ?? 'failed')
                                : status.tools.map((t) => t.name).join(', ')
                            }
                            onClick={() => {
                              setMcpMenuOpen(false)
                              setMcpOpen(true)
                            }}
                          >
                            <span
                              className={`mcp-dot mcp-dot--${status.state}`}
                            />
                            <span className="mcp-pop__name">
                              {status.config.name}
                            </span>
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
                          className="model-pop__row"
                          onClick={() => {
                            setMcpMenuOpen(false)
                            setMcpOpen(true)
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
                    disabled={!input.trim() || compacting}
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
      {exemplarSql !== null && target && (
        <SaveExemplarDialog
          connId={target.connId}
          database={target.database}
          targetLabel={`${target.connName} / ${target.database}`}
          initialSql={exemplarSql}
          initialQuestion={lastUserPrompt}
          onClose={() => setExemplarSql(null)}
        />
      )}
    </section>
  )
}
