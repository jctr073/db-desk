import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, ReactElement, ReactNode } from 'react'

import { API_KEY_VAR } from '../../../shared/agent'
import type {
  AgentContextItem,
  AgentKeyStatus,
  AgentModeOption,
  AgentModelOption,
  AgentPromptIntent
} from '../../../shared/agent'
import type { DatabaseIntrospection, QueryResult } from '../../../shared/db'
import type { McpServerStatus } from '../../../shared/mcp'
import { REPO_SCAN_PROMPT, repoTargetedScanPrompt } from '../../../shared/repo'
import {
  SCAN_CODEBASE_SKILL_ID,
  TARGETED_SCAN_SKILL_ID,
  applySkillArgs,
  skillNeedsRepo
} from '../../../shared/skills'
import type { Skill } from '../../../shared/skills'
import { SkillsPanel } from '../skills/SkillsPanel'
import { useSkillsState } from '../skills/useSkillsState'
import { KIND_LABELS, isKnownKind, recordTitle } from '../knowledge/format'
import { KnowledgePanel } from '../knowledge/KnowledgePanel'
import { knowledgeTargetKeyOf, useKnowledgeState } from '../knowledge/useKnowledgeState'
import type { KnowledgeNav, KnowledgeState } from '../knowledge/useKnowledgeState'
import type { FileState } from '../files/useFileState'
import { ChatTranscript } from './agent/ChatTranscript'
import { ChatSessionBar, Composer, ModeControl } from './agent/Composer'
import { MODE_STORAGE_KEY, useChatSession } from './agent/useChatSession'
import { useEscapeKey } from '../useEscapeKey'
import { useRepoLinks } from './agent/useRepoLinks'
import type { EditorBridge } from './editorBridge'
import { ManageKnowledgeDialog } from './ManageKnowledgeDialog'
import type { QueryTarget } from './useQueryRunner'
import { BookIcon, LockIcon, PlusThinIcon, SparkleIcon } from './icons'
import { FilesPanel } from './FilesPanel'
import { KbRefContext } from './MarkdownText'
import { McpSettingsDialog } from './McpSettingsDialog'
import { SaveExemplarDialog } from './SaveExemplarDialog'

interface AgentPanelProps {
  files: FileState
  /** Connection id → display name. */
  connNames: Record<string, string>
  targets: QueryTarget[]
  /** The app-wide active connection + database; the panel follows this, it never picks its own. */
  activeTarget: QueryTarget | null
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
  onOpenKnowledgeRecord: (connId: string, database: string, recordId: string) => void
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

export function AgentPanel({
  files,
  connNames,
  targets,
  activeTarget,
  editorBridge,
  onAgentQuery,
  onAgentTurnEnd,
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
  const [activeTab, setActiveTab] = useState<'files' | 'agent' | 'knowledge' | 'skills'>('agent')
  const [knowledgeNewSeq, setKnowledgeNewSeq] = useState(0)
  const consumeKnowledgeNewSeq = useCallback(() => setKnowledgeNewSeq(0), [])
  const [skillsNewSeq, setSkillsNewSeq] = useState(0)
  const consumeSkillsNewSeq = useCallback(() => setSkillsNewSeq(0), [])
  const skills = useSkillsState()
  const [slashIndex, setSlashIndex] = useState(0)
  const [keyStatus, setKeyStatus] = useState<AgentKeyStatus | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFilter, setPickerFilter] = useState('')
  const [modeOpen, setModeOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [agentToolsOpen, setAgentToolsOpen] = useState(false)
  /** SQL captured from a chat code block for the "Save as exemplar" dialog. */
  const [exemplarSql, setExemplarSql] = useState<string | null>(null)
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  /** The knowledge tab's "Manage Knowledge Bases" dialog. */
  const [manageKnowledgeOpen, setManageKnowledgeOpen] = useState(false)

  // Knowledge links + per-base codebase status; a target's repo status is
  // that of its default linked base.
  const {
    links,
    repoStatuses,
    defaultBaseFor,
    repoStatusFor,
    rememberRepoStatus,
    detachCodebase,
    detachAndDeleteBase
  } = useRepoLinks(targets)

  const target = activeTarget
  /** Where the files tab's "+" puts a new file: the chat's target, else primary. */
  const fileHome = target ?? targets.find((t) => t.primary) ?? targets[0] ?? null
  const knowledgeTarget =
    targets.find((t) => knowledgeTargetKeyOf(t.connId, t.database) === knowledgeTargetKey) ?? null

  // The chat session: transcript, agent event subscription, per-chat settings.
  const session = useChatSession({
    target,
    context,
    editorBridge,
    onAgentQuery,
    onAgentTurnEnd,
    repoStatusFor
  })
  const {
    messages,
    chatHistory,
    historyOpen,
    setHistoryOpen,
    busy,
    thinking,
    compacting,
    mode,
    setModelId,
    setEffort,
    setMode,
    setInput,
    setDraftIntent,
    setRepoEnabled,
    lastUserPrompt,
    sendPrompt,
    newChat,
    openChat,
    loadFinalSql
  } = session

  /** Introspected schema names of the knowledge target, for the manage dialog. */
  const knowledgeSchemaOptions = useMemo(() => {
    const intro = knowledgeTarget
      ? schemas[knowledgeTarget.connId]?.[knowledgeTarget.database]
      : undefined
    return intro?.schemas.map((s) => s.name) ?? []
  }, [knowledgeTarget, schemas])

  // Knowledge records for the CHAT target — the knowledge tab may be viewing
  // a different database — so [kb:id] citations in assistant prose resolve to
  // live records (and pick up renames/deletes via knowledge:changed pushes).
  const chatKnowledge = useKnowledgeState(target?.connId ?? null, target?.database ?? null)
  // A [kb:id] citation can name a record in any base linked to the chat target,
  // so resolve over the union of all its bases, not just the selected one.
  const chatRecordById = useMemo(
    () => new Map(chatKnowledge.groups.flatMap((g) => g.records).map((r) => [r.id, r])),
    [chatKnowledge.groups]
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
      const label = isKnownKind(record.kind) ? KIND_LABELS[record.kind] : 'Knowledge'
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

  useEffect(() => {
    void window.dbDesk.agent.keyStatus().then(setKeyStatus)
    // Re-check when the user edits key settings, so the notice clears live.
    return window.dbDesk.settings.onChanged(() => {
      void window.dbDesk.agent.keyStatus().then(setKeyStatus)
    })
  }, [])

  useEffect(() => {
    void window.dbDesk.mcp.list().then(setMcpStatuses)
    return window.dbDesk.mcp.onChanged(setMcpStatuses)
  }, [])

  // The manage dialog is scoped to the knowledge target; leaving it closes it.
  useEffect(() => {
    setManageKnowledgeOpen(false)
  }, [knowledgeTargetKey])

  // Once the chat target's default base has a codebase, default to using it.
  useEffect(() => {
    if (repoStatusFor(target?.connId, target?.database)?.root) {
      setRepoEnabled(true)
    }
  }, [target?.connId, target?.database, repoStatusFor, setRepoEnabled])

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
  }, [seed, setInput, setDraftIntent])

  // "Show usages" / "Add annotation…" from the tree reveals the knowledge tab.
  const prevNavSeq = useRef(0)
  useEffect(() => {
    if (knowledgeNav && knowledgeNav.seq !== prevNavSeq.current) {
      prevNavSeq.current = knowledgeNav.seq
      setActiveTab('knowledge')
    }
  }, [knowledgeNav])

  // The target and access mode belong to the agent, not the sibling tools.
  // Close the mode popover when leaving the chat so it does not reopen later.
  useEffect(() => {
    if (activeTab !== 'agent') setModeOpen(false)
  }, [activeTab])

  // Escape dismisses whichever popover is open.
  useEscapeKey(modelOpen || pickerOpen || modeOpen || historyOpen, () => {
    setModelOpen(false)
    setPickerOpen(false)
    setModeOpen(false)
    setHistoryOpen(false)
  })

  const openPicker = useCallback(() => {
    setPickerFilter('')
    setPickerOpen(true)
    if (target) ensureSchema(target.connId, target.database)
  }, [target, ensureSchema])

  const pickModel = useCallback(
    (next: AgentModelOption) => {
      setModelId(next.id)
      setEffort((cur) => (cur && next.efforts.includes(cur) ? cur : next.defaultEffort))
      setModelOpen(false)
    },
    [setModelId, setEffort]
  )

  const pickMode = useCallback(
    (next: AgentModeOption) => {
      if (!next.enabled) return
      setMode(next.id)
      try {
        localStorage.setItem(MODE_STORAGE_KEY, next.id)
      } catch {
        // Persistence is best-effort.
      }
      setModeOpen(false)
    },
    [setMode]
  )

  const insertSql = useCallback(
    (sql: string) => {
      editorBridge.current?.insertSql(sql)
    },
    [editorBridge]
  )

  const onSaveExemplar = useCallback((sql: string) => {
    setExemplarSql(sql)
  }, [])

  /**
   * Attaches (or changes) the codebase of an explicit base: opens the native
   * directory picker for it — the path never comes from the renderer.
   * (Kept here rather than in useRepoLinks because a successful attach also
   * flips the session's repoEnabled flag.)
   */
  const attachCodebaseTo = useCallback(
    async (kbId: string): Promise<void> => {
      const status = await window.dbDesk.repo.choose(kbId)
      rememberRepoStatus(status)
      if (status.root && kbId === defaultBaseFor(target?.connId, target?.database)) {
        setRepoEnabled(true)
      }
    },
    [rememberRepoStatus, defaultBaseFor, target, setRepoEnabled]
  )

  // The scan actions send the (possibly user-edited) skill prompt; the
  // shipped constants remain only as a fallback while skills are loading.
  const skillById = useMemo(() => new Map(skills.skills.map((s) => [s.id, s])), [skills.skills])

  const scanBase = useCallback(
    (kbId: string) => {
      if (!knowledgeTarget || !repoStatuses[kbId]?.root || busy || compacting) {
        return
      }
      setManageKnowledgeOpen(false)
      setRepoEnabled(true)
      setActiveTab('agent')
      const prompt = skillById.get(SCAN_CODEBASE_SKILL_ID)?.prompt ?? REPO_SCAN_PROMPT
      // Pin the scan to the base whose codebase is attached so its findings
      // are written there. This launch point collects no input; strip any
      // {{args}} a user edit added so the placeholder never reaches the model
      // as literal text.
      sendPrompt(applySkillArgs(prompt, ''), knowledgeTarget, true, 'chat', kbId)
    },
    [knowledgeTarget, repoStatuses, busy, compacting, sendPrompt, skillById, setRepoEnabled]
  )

  /** Follow-up scan scoped by the focus text from the targeted-scan dialog. */
  const targetedScanBase = useCallback(
    (kbId: string, focus: string) => {
      if (!knowledgeTarget || !repoStatuses[kbId]?.root || busy || compacting) {
        return
      }
      setManageKnowledgeOpen(false)
      setRepoEnabled(true)
      setActiveTab('agent')
      const template = skillById.get(TARGETED_SCAN_SKILL_ID)?.prompt
      sendPrompt(
        template ? applySkillArgs(template, focus) : repoTargetedScanPrompt(focus),
        knowledgeTarget,
        true,
        'chat',
        kbId
      )
    },
    [knowledgeTarget, repoStatuses, busy, compacting, sendPrompt, skillById, setRepoEnabled]
  )

  /**
   * Runs a skill from the Skills tab as a normal chat turn. Returns a
   * user-facing reason when the run cannot happen, or null on success —
   * the panel surfaces the reason instead of silently doing nothing.
   */
  const runSkill = useCallback(
    (skill: Skill, prompt: string): string | null => {
      if (busy || compacting) {
        return 'The agent is busy — wait for the current turn to finish.'
      }
      // A connection-scoped skill runs against its own connection, never
      // whatever the chat happened to target.
      const runTarget = skill.connId
        ? (targets.find((t) => t.connId === skill.connId) ?? null)
        : target
      if (skill.connId && !runTarget) {
        return `Connect to ${connNames[skill.connId] ?? 'this skill’s connection'} to run it.`
      }
      const needsRepo = skillNeedsRepo(skill.id)
      let kbId: string | null = null
      if (needsRepo) {
        if (!runTarget) {
          return 'Connect to a database first — this skill scans its attached codebase.'
        }
        if (!repoStatusFor(runTarget.connId, runTarget.database)?.root) {
          return 'Attach a codebase to this connection first (Knowledge tab → Manage).'
        }
        // Scan-style skills write into the base whose codebase is attached.
        kbId = defaultBaseFor(runTarget.connId, runTarget.database)
        setRepoEnabled(true)
      }
      setActiveTab('agent')
      sendPrompt(prompt, runTarget, needsRepo, 'chat', kbId)
      return null
    },
    [
      busy,
      compacting,
      sendPrompt,
      target,
      targets,
      connNames,
      repoStatusFor,
      defaultBaseFor,
      setRepoEnabled
    ]
  )

  const keyMissing = keyStatus !== null && !keyStatus.found

  return (
    <section className="agent-panel">
      <div className="agent-tabbar">
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
        <button
          className={`agent-tab${activeTab === 'files' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('files')}
        >
          SQL Files
        </button>
        <button
          className={`agent-tab${activeTab === 'skills' ? ' is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('skills')}
        >
          Skills
        </button>
        <div className="agent-tabbar__spacer" />
        <button
          className="icon-btn icon-btn--sm"
          title={
            activeTab === 'agent'
              ? 'New chat'
              : activeTab === 'knowledge'
                ? 'New knowledge record'
                : activeTab === 'skills'
                  ? 'New skill'
                  : fileHome
                    ? 'New query file'
                    : 'Connect to a database to add a query file'
          }
          disabled={activeTab === 'files' && !fileHome}
          type="button"
          onClick={() => {
            if (activeTab === 'agent') newChat()
            else if (activeTab === 'knowledge') setKnowledgeNewSeq((s) => s + 1)
            else if (activeTab === 'skills') setSkillsNewSeq((s) => s + 1)
            else if (fileHome) files.createFile(fileHome.connId, fileHome.database)
          }}
        >
          <PlusThinIcon />
        </button>
      </div>
      {activeTab === 'agent' && (
        <div className="agent-target-row">
          {activeTarget ? (
            <span className="ctx-chip" title="The agent follows the app's active connection">
              <span className="ctx-chip__lock">
                <LockIcon />
              </span>
              <span className="ctx-chip__dot" />
              <span className="ctx-chip__name">{activeTarget.connName}</span>
              <span className="ctx-chip__db">/ {activeTarget.database}</span>
            </span>
          ) : (
            <span className="ctx-chip ctx-chip--bare">No connection</span>
          )}
          <span className="agent-target-row__hint">follows app context</span>
          <span className="agent-target-row__spacer" />
          <ModeControl
            mode={mode}
            modeOpen={modeOpen}
            setModeOpen={setModeOpen}
            onPickMode={pickMode}
          />
        </div>
      )}
      {activeTab === 'files' ? (
        <FilesPanel
          files={files}
          connNames={connNames}
          activeConnId={activeTarget?.connId ?? null}
        />
      ) : activeTab === 'skills' ? (
        <SkillsPanel
          state={skills}
          connNames={connNames}
          newSeq={skillsNewSeq}
          onNewConsumed={consumeSkillsNewSeq}
          onRun={runSkill}
          canRun={!busy && !compacting}
        />
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
          onManageBases={() => {
            if (!knowledgeTarget) return
            ensureSchema(knowledgeTarget.connId, knowledgeTarget.database)
            setManageKnowledgeOpen(true)
          }}
        />
      ) : (
        <div className="chat">
          <ChatSessionBar
            messages={messages}
            chatHistory={chatHistory}
            busy={busy}
            compacting={compacting}
            historyOpen={historyOpen}
            setHistoryOpen={setHistoryOpen}
            onNewChat={newChat}
            onOpenChat={openChat}
          />
          {mcpOpen && <McpSettingsDialog onClose={() => setMcpOpen(false)} />}
          {keyMissing && (
            <div className="chat__notice">
              No API key found — add one in Settings (the gear in the status bar), or add{' '}
              <code>export {keyStatus?.varName ?? API_KEY_VAR}=…</code> to <code>~/.zshrc</code>.
            </div>
          )}
          <KbRefContext.Provider value={renderKbRef}>
            <ChatTranscript
              messages={messages}
              busy={busy}
              thinking={thinking}
              compacting={compacting}
              mode={mode}
              onInsert={insertSql}
              onSaveExemplar={target ? onSaveExemplar : undefined}
              onLoadFinalSql={loadFinalSql}
            />
          </KbRefContext.Provider>
          <Composer
            session={session}
            target={target}
            schemas={schemas}
            context={context}
            onAddContext={onAddContext}
            onRemoveContext={onRemoveContext}
            modelOpen={modelOpen}
            setModelOpen={setModelOpen}
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            pickerFilter={pickerFilter}
            setPickerFilter={setPickerFilter}
            agentToolsOpen={agentToolsOpen}
            setAgentToolsOpen={setAgentToolsOpen}
            slashIndex={slashIndex}
            setSlashIndex={setSlashIndex}
            openPicker={openPicker}
            pickModel={pickModel}
            mcpStatuses={mcpStatuses}
            onOpenMcp={() => setMcpOpen(true)}
          />
        </div>
      )}
      {manageKnowledgeOpen && knowledgeTarget && (
        <ManageKnowledgeDialog
          target={knowledgeTarget}
          groups={knowledge.groups}
          links={links}
          connNames={connNames}
          schemaOptions={knowledgeSchemaOptions}
          repoStatuses={repoStatuses}
          initialKbId={knowledge.selectedKbId}
          onSelectBase={knowledge.setSelectedKbId}
          onAttachCodebase={attachCodebaseTo}
          onDetachCodebase={detachCodebase}
          onDetachAndDeleteBase={detachAndDeleteBase}
          onScan={scanBase}
          onTargetedScan={targetedScanBase}
          scanDisabledReason={
            skills.loading
              ? 'Skills are still loading — try again in a moment'
              : busy || compacting
                ? 'The agent is busy — wait for the current turn to finish'
                : null
          }
          onClose={() => setManageKnowledgeOpen(false)}
        />
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
