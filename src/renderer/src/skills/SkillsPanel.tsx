import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import {
  applySkillArgs,
  builtinSkillById,
  skillHasArgs
} from '../../../shared/skills'
import type { Skill } from '../../../shared/skills'
import { CloseIcon, PlayIcon } from '../components/icons'
import type { SkillsState } from './useSkillsState'

interface SkillsPanelProps {
  state: SkillsState
  /** Connection id → display name, for scope labels and the scope picker. */
  connNames: Record<string, string>
  /** Bumped by the tab bar "+" button: open a blank new-skill editor. */
  newSeq: number
  /** Called once `newSeq` has been acted on, so the parent can reset it. */
  onNewConsumed: () => void
  /** Send the resolved prompt as an agent turn (the caller owns the chat). */
  onRun: (skill: Skill, prompt: string) => void
  /** False while a turn is streaming — sends would be dropped anyway. */
  canRun: boolean
}

interface EditorState {
  /** null = new custom skill. */
  skill: Skill | null
  /** Monotonic per-editor id, so two different drafts never share a key. */
  seq: number
}

/**
 * The Skills tab: general-purpose and connection-specific prompts the agent
 * can run as ordinary chat turns. Built-in skills (the knowledge-base scan
 * prompts) are editable with a "Reset to installed version" escape hatch;
 * custom skills can be scoped to one connection or left general.
 */
export function SkillsPanel({
  state,
  connNames,
  newSeq,
  onNewConsumed,
  onRun,
  canRun
}: SkillsPanelProps): ReactElement {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [argsFor, setArgsFor] = useState<Skill | null>(null)
  const editorSeq = useRef(0)
  const openEditor = (skill: Skill | null): void =>
    setEditor({ skill, seq: ++editorSeq.current })

  // Tab bar "+" while this tab is active: open a blank editor. A one-shot —
  // the parent resets `newSeq` once consumed, so remounts never replay it.
  useEffect(() => {
    if (newSeq === 0) return
    openEditor(null)
    onNewConsumed()
  }, [newSeq, onNewConsumed])

  const run = useCallback(
    (skill: Skill): void => {
      if (!canRun) return
      if (skillHasArgs(skill.prompt)) {
        setArgsFor(skill)
        return
      }
      onRun(skill, skill.prompt)
    },
    [canRun, onRun]
  )

  const general = state.skills.filter((s) => s.connId === null)
  const scoped = state.skills.filter((s) => s.connId !== null)
  const connIds = [...new Set(scoped.map((s) => s.connId as string))].sort(
    (a, b) => (connNames[a] ?? a).localeCompare(connNames[b] ?? b)
  )

  const argsDialog = argsFor && (
    <SkillArgsDialog
      skill={argsFor}
      onClose={() => setArgsFor(null)}
      onRun={(args) => {
        setArgsFor(null)
        onRun(argsFor, applySkillArgs(argsFor.prompt, args))
      }}
    />
  )

  if (editor) {
    return (
      <>
        <SkillEditor
          key={editor.seq}
          skill={editor.skill}
          connNames={connNames}
          state={state}
          onClose={() => setEditor(null)}
          onRun={run}
          canRun={canRun}
        />
        {argsDialog}
      </>
    )
  }

  return (
    <div className="knowledge skills">
      {state.error && (
        <button
          type="button"
          className="skills__error"
          title="Dismiss"
          onClick={state.clearError}
        >
          {state.error}
        </button>
      )}
      <div className="kn-scroll">
        {state.loading ? (
          <div className="kn-loading">Loading skills…</div>
        ) : (
          <>
            <SkillGroup
              title="General"
              skills={general}
              onOpen={openEditor}
              onRun={run}
              canRun={canRun}
            />
            {connIds.map((connId) => (
              <SkillGroup
                key={connId}
                title={connNames[connId] ?? connId}
                skills={scoped.filter((s) => s.connId === connId)}
                onOpen={openEditor}
                onRun={run}
                canRun={canRun}
              />
            ))}
            {general.length + scoped.length === 0 && (
              <div className="kn-empty">
                <div className="kn-empty__text">No skills yet</div>
                <div className="kn-empty__hint">
                  Skills are reusable prompts the agent runs as chat turns. Use
                  the + button to write one.
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {argsDialog}
    </div>
  )
}

function SkillGroup({
  title,
  skills,
  onOpen,
  onRun,
  canRun
}: {
  title: string
  skills: Skill[]
  onOpen: (skill: Skill) => void
  onRun: (skill: Skill) => void
  canRun: boolean
}): ReactElement | null {
  if (skills.length === 0) return null
  return (
    <div className="sk-group">
      <div className="sk-group__header">{title}</div>
      {skills.map((skill) => (
        <div
          key={skill.id}
          className="kn-item sk-item"
          role="button"
          tabIndex={0}
          onClick={() => onOpen(skill)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen(skill)
            }
          }}
        >
          <span className="sk-item__text">
            <span className="kn-item__title">{skill.name}</span>
            {skill.description && (
              <span className="sk-item__desc">{skill.description}</span>
            )}
          </span>
          {skill.edited && (
            <span className="kn-badge kn-badge--agent">edited</span>
          )}
          {skill.builtin && (
            <span className="kn-badge kn-badge--human">built-in</span>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--sm sk-item__run"
            title={canRun ? `Run "${skill.name}"` : 'Agent is busy'}
            disabled={!canRun}
            onClick={(e) => {
              e.stopPropagation()
              onRun(skill)
            }}
          >
            <PlayIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function SkillEditor({
  skill,
  connNames,
  state,
  onClose,
  onRun,
  canRun
}: {
  skill: Skill | null
  connNames: Record<string, string>
  state: SkillsState
  onClose: () => void
  onRun: (skill: Skill) => void
  canRun: boolean
}): ReactElement {
  const installed = skill ? builtinSkillById(skill.id) : null
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [prompt, setPrompt] = useState(skill?.prompt ?? '')
  const [connId, setConnId] = useState<string | null>(skill?.connId ?? null)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    !skill ||
    name !== skill.name ||
    description !== skill.description ||
    prompt !== skill.prompt ||
    connId !== skill.connId
  const valid = name.trim() !== '' && prompt.trim() !== ''
  /** Draft (or stored override) differs from the installed built-in text. */
  const divergesFromInstalled =
    installed !== null &&
    (name !== installed.name ||
      description !== installed.description ||
      prompt !== installed.prompt)

  const save = async (): Promise<void> => {
    if (!valid) {
      setError('A skill needs a name and a prompt.')
      return
    }
    const saved = await state.save({
      id: skill?.id,
      name: name.trim(),
      description: description.trim(),
      prompt,
      connId: installed ? null : connId
    })
    if (saved) onClose()
  }

  const resetToInstalled = (): void => {
    if (!installed) return
    setName(installed.name)
    setDescription(installed.description)
    setPrompt(installed.prompt)
    // Dropping the stored override IS the reset; the draft now mirrors it.
    if (skill?.edited) void state.remove(installed.id)
  }

  const remove = async (): Promise<void> => {
    if (!skill || skill.builtin) return
    if (await state.remove(skill.id)) onClose()
  }

  return (
    <div className="kn-editor sk-editor">
      <div className="kn-editor__head">
        <button type="button" className="kn-back" onClick={onClose}>
          ‹ Skills
        </button>
        <span className="kn-editor__title sk-editor__title">
          {skill ? skill.name : 'New skill'}
        </span>
        {skill?.builtin && (
          <span className="kn-badge kn-badge--human">built-in</span>
        )}
      </div>
      <div className="kn-editor__body">
        <div className="kn-field">
          <label className="field-label" htmlFor="skill-name">
            NAME
          </label>
          <input
            id="skill-name"
            className="text-input"
            value={name}
            autoFocus={!skill}
            placeholder="e.g. Weekly revenue report"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="kn-field">
          <label className="field-label" htmlFor="skill-description">
            DESCRIPTION
          </label>
          <input
            id="skill-description"
            className="text-input"
            value={description}
            placeholder="One line on what this skill does (optional)"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="kn-field">
          <label className="field-label" htmlFor="skill-scope">
            SCOPE
          </label>
          <select
            id="skill-scope"
            className="toolbar-select sk-editor__scope"
            value={connId ?? ''}
            disabled={installed !== null}
            title={
              installed !== null
                ? 'Built-in skills are available to every connection'
                : 'Which connection this skill applies to'
            }
            onChange={(e) => setConnId(e.target.value || null)}
          >
            <option value="">General — all connections</option>
            {Object.entries(connNames).map(([id, connName]) => (
              <option key={id} value={id}>
                {connName}
              </option>
            ))}
          </select>
        </div>
        <div className="kn-field">
          <label className="field-label" htmlFor="skill-prompt">
            PROMPT
          </label>
          <textarea
            id="skill-prompt"
            className="text-input kn-textarea sk-editor__prompt"
            value={prompt}
            placeholder={
              'The message sent to the agent when this skill runs. Use {{args}} where input collected at run time should go.'
            }
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="url-hint">
            Running a skill sends its prompt as a normal chat turn against the
            agent’s current connection.{' '}
            <code className="url-hint__mono">{'{{args}}'}</code> is replaced
            with input collected when the skill runs.
          </div>
        </div>
        {(error ?? state.error) && (
          <div className="mcp-form-error">{error ?? state.error}</div>
        )}
      </div>
      <div className="kn-editor__foot">
        {installed && (
          <button
            type="button"
            className="btn-cancel"
            disabled={!divergesFromInstalled && !skill?.edited}
            title="Discard edits and restore the version that ships with the app"
            onClick={resetToInstalled}
          >
            Reset to installed
          </button>
        )}
        {skill && !skill.builtin && (
          <button type="button" className="kn-delete" onClick={() => void remove()}>
            Delete
          </button>
        )}
        <div className="kn-editor__spacer" />
        {skill && !dirty && (
          <button
            type="button"
            className="btn-cancel"
            disabled={!canRun}
            title={canRun ? undefined : 'Agent is busy'}
            onClick={() => onRun(skill)}
          >
            <PlayIcon size={11} /> Run
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || !valid}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * Collects the run-time input for a skill whose prompt has an {{args}}
 * placeholder. Follows the house dialog pattern (TargetedScanDialog).
 */
function SkillArgsDialog({
  skill,
  onClose,
  onRun
}: {
  skill: Skill
  onClose: () => void
  onRun: (args: string) => void
}): ReactElement {
  const [args, setArgs] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const start = (): void => {
    const trimmed = args.trim()
    if (!trimmed) {
      setError('This skill needs input to run.')
      return
    }
    onRun(trimmed)
  }

  return (
    // No click-to-close on the overlay: a stray click must not discard a
    // half-filled form (same rule as the other dialogs).
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Run skill: ${skill.name}`}
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <PlayIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">{skill.name}</div>
            {skill.description && (
              <div className="dialog__subtitle">{skill.description}</div>
            )}
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
          <label className="field-label" htmlFor="skill-args">
            INPUT
          </label>
          <textarea
            id="skill-args"
            className="text-input"
            rows={4}
            autoFocus
            placeholder="Filled in where the skill’s prompt says {{args}}."
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                start()
              }
            }}
          />
          {error && <div className="mcp-form-error">{error}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg" />
          <button className="btn-cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn-primary" onClick={start} type="button">
            Run Skill
          </button>
        </div>
      </div>
    </div>
  )
}
