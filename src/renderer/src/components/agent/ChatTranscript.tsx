import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'

import type { AgentMode } from '../../../../shared/agent'
import { stripSqlComments } from '../../sql/highlight'
import { formatElapsed, splitFences } from '../agentTurn'
import type { TurnRecap } from '../agentTurn'
import {
  BookIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  GlobeIcon,
  PlayIcon,
  PlugIcon,
  SearchIcon,
  SparkleIcon,
  SqlFileIcon
} from '../icons'
import { Markdown } from '../MarkdownText'
import { SqlCode } from '../SqlCode'
import type { ChatMessage } from './useChatSession'

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
export function ContextGauge({
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
        <circle className="context-gauge__track" cx="13" cy="13" r={GAUGE_RADIUS} />
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

interface ChatTranscriptProps {
  messages: ChatMessage[]
  busy: boolean
  thinking: boolean
  compacting: boolean
  mode: AgentMode
  onInsert: (sql: string) => void
  /** Present only when a target is connected: adds a "Save as exemplar" action. */
  onSaveExemplar?: (sql: string) => void
  /** "Load final query" on a recap: same review path as write_to_editor. */
  onLoadFinalSql: (recap: TurnRecap) => void
}

/** The scrolling chat transcript: prose, tool chips, notices, and recaps. */
export function ChatTranscript({
  messages,
  busy,
  thinking,
  compacting,
  mode,
  onInsert,
  onSaveExemplar,
  onLoadFinalSql
}: ChatTranscriptProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Follow the stream: keep the transcript pinned to the bottom.
  useEffect(() => {
    const host = scrollRef.current
    if (host) host.scrollTop = host.scrollHeight
  }, [messages, thinking, busy, compacting])

  const transcript = useMemo(
    () => messages.filter((m) => m.role === 'user' || m.parts.length > 0),
    [messages]
  )

  return (
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
                  onInsert={onInsert}
                  onSaveExemplar={onSaveExemplar}
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
                <div key={i} className={`chat-tool chat-tool--${part.status}`} title={part.sql}>
                  <span className="chat-tool__kind">
                    <meta.Icon size={10} />
                    {meta.label}
                  </span>
                  <code>
                    {meta.sqlish ? (
                      <SqlCode
                        sql={stripSqlComments(detail).replace(/\s+/g, ' ').trim().slice(0, 60)}
                      />
                    ) : (
                      detail.slice(0, 60)
                    )}
                  </code>
                  <span className="chat-tool__summary">
                    {part.status === 'running' ? 'running…' : part.summary}
                  </span>
                  {part.status !== 'running' && (
                    <span className="chat-tool__status">
                      {part.status === 'ok' ? <CheckIcon size={11} /> : <CloseIcon size={11} />}
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
            if (part.kind === 'recap') {
              const label =
                part.status === 'done' ? 'Done' : part.status === 'stopped' ? 'Stopped' : 'Failed'
              const editorNote =
                part.editor === 'applied'
                  ? 'final query in editor'
                  : part.editor === 'pending'
                    ? 'editor diff awaiting review'
                    : part.editor === 'already'
                      ? 'query already in editor'
                      : null
              const segments = [
                formatElapsed(part.elapsedMs),
                part.toolCount > 0 &&
                  `${part.toolCount} tool call${part.toolCount === 1 ? '' : 's'}`,
                part.queryCount > 0 &&
                  `${part.queryCount} quer${part.queryCount === 1 ? 'y' : 'ies'} run`,
                editorNote
              ].filter((s): s is string => Boolean(s))
              return (
                <div key={i} className={`chat-recap chat-recap--${part.status}`}>
                  <span className="chat-recap__label">{label}</span>
                  <span className="chat-recap__meta">{segments.join(' · ')}</span>
                  {part.finalSql && (
                    <button
                      type="button"
                      className="chat-recap__load"
                      title="Load the final query into the active SQL editor (review as a diff when the editor has content)"
                      onClick={() => onLoadFinalSql(part)}
                    >
                      Load final query
                    </button>
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
      {thinking && busy && <div className="chat__thinking">Thinking…</div>}
      {compacting && <div className="chat__thinking">Compacting context…</div>}
    </div>
  )
}
