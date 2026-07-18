import { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useCallback, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

import type { Theme } from '../../theme'
import { SparkleIcon } from '../icons'
import { defineThemes, resolveTheme } from '../SqlEditor'

/** An agent-proposed replacement for one file's contents, awaiting review. */
export interface EditorProposal {
  fileId: string
  sql: string
}

/** Inline (single-pane) read-only diff for reviewing an AI proposal. */
const PROPOSAL_DIFF_OPTIONS: editor.IDiffEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: 13,
  minimap: { enabled: false },
  originalEditable: false,
  readOnly: true,
  renderOverviewRuler: false,
  renderSideBySide: false,
  scrollBeyondLastLine: false,
  wordWrap: 'on'
}

interface ProposalOverlayProps {
  /**
   * The diff review renders only over the file it targets. The component
   * stays mounted (rendering null) while hidden so the disposal effects
   * below keep their original timing relative to the DiffEditor unmount.
   */
  show: boolean
  proposal: EditorProposal | null
  theme: Theme
  /** The visible file's name, for the review bar title. */
  activeFileName: string | null
  /** The current buffer contents the proposal would replace. */
  activeContent: string
  onAccept: () => void
  onReject: () => void
}

/** The "AI proposed changes" Accept/Reject diff review over the editor. */
export function ProposalOverlay({
  show,
  proposal,
  theme,
  activeFileName,
  activeContent,
  onAccept,
  onReject
}: ProposalOverlayProps): ReactElement | null {
  useEffect(() => {
    if (!show) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onReject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [show, onReject])

  // The DiffEditor wrapper disposes its TextModels before the widget resets
  // them, which throws on unmount. keepCurrent*Model makes the wrapper leave
  // the models alone; we capture them at mount and dispose them ourselves
  // once the overlay is gone.
  const diffModelsRef = useRef<editor.ITextModel[]>([])
  const handleDiffMount = useCallback((diffEditor: editor.IStandaloneDiffEditor): void => {
    const m = diffEditor.getModel()
    diffModelsRef.current = m ? [m.original, m.modified] : []
  }, [])
  useEffect(() => {
    if (show) return
    const models = diffModelsRef.current
    diffModelsRef.current = []
    for (const model of models) {
      if (!model.isDisposed()) model.dispose()
    }
  }, [show])
  // Component teardown: release whatever the overlay still holds.
  useEffect(
    () => () => {
      for (const model of diffModelsRef.current) {
        if (!model.isDisposed()) model.dispose()
      }
    },
    []
  )

  if (!show || !proposal) return null

  return (
    <div className="editor-proposal">
      <div className="editor-proposal__bar">
        <SparkleIcon size={13} />
        <span className="editor-proposal__title">
          AI proposed changes
          {activeFileName ? ` — ${activeFileName}` : ''}
        </span>
        <span className="editor-proposal__spacer" />
        <button
          className="btn-cancel"
          type="button"
          title="Keep the file as it is (Esc)"
          onClick={onReject}
        >
          Reject
        </button>
        <button
          className="btn-primary"
          type="button"
          autoFocus
          title="Replace the file contents with the proposal (undo with ⌘Z)"
          onClick={onAccept}
        >
          Accept
        </button>
      </div>
      <div className="editor-proposal__diff">
        <DiffEditor
          beforeMount={defineThemes}
          onMount={handleDiffMount}
          original={activeContent}
          modified={proposal.sql}
          language="sql"
          theme={resolveTheme(theme)}
          height="100%"
          options={PROPOSAL_DIFF_OPTIONS}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
        />
      </div>
    </div>
  )
}
