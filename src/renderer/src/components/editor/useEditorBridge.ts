import type { editor } from 'monaco-editor'
import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { EditorBridge } from '../editorBridge'
import type { ResultsCommands } from '../ResultsPanel'
import type { QueryRunner } from '../useQueryRunner'
import type { EditorProposal } from './ProposalOverlay'

interface EditorBridgeParams {
  /** Registered on mount so the AI agent can read/insert editor SQL. */
  bridge: MutableRefObject<EditorBridge | null>
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  activeFileIdRef: MutableRefObject<string | null>
  buffersRef: MutableRefObject<Map<string, string>>
  /** SQL to apply to the next freshly-loaded file (created for a proposal). */
  pendingApplyRef: MutableRefObject<string | null>
  applyProposal: (fileId: string, text: string) => void
  setProposal: Dispatch<SetStateAction<EditorProposal | null>>
  /** The visible file's name (null when none), mirrored for the bridge. */
  activeFileName: string | null
  isSqlFile: boolean
  /**
   * Where proposeSql creates a query file when no SQL tab is open: the active
   * group's home, else the app's primary target. Null with no connection.
   */
  proposalHome: { connId: string; database: string | null } | null
  createFile: (connId: string, database: string | null) => void
  /** Same code path as the Run button / ⌘⏎ (EditorPanel's runCurrent). */
  runRef: MutableRefObject<() => void>
  /** Same code path as ⌘S. */
  saveRef: MutableRefObject<() => void>
  /** Creates a fresh SQL query file, same as the "+" in the tab strip. */
  newQueryRef: MutableRefObject<() => void>
  runnerRef: MutableRefObject<QueryRunner>
  /** The main ResultsPanel's export-popover handle, reached through a ref. */
  resultsCommandsRef: MutableRefObject<ResultsCommands | null>
  /** Whether there's a target and the active file is SQL. */
  canRunRef: MutableRefObject<boolean>
}

/**
 * Registers the imperative EditorBridge handle the AI agent panel uses to
 * read the active buffer and place generated SQL. Everything is read through
 * refs at call time, so registering once is safe (applyProposal is stable).
 * Returns the mirror refs the panel's own once-registered Monaco actions
 * also read.
 */
export function useEditorBridge({
  bridge,
  editorRef,
  activeFileIdRef,
  buffersRef,
  pendingApplyRef,
  applyProposal,
  setProposal,
  activeFileName,
  isSqlFile,
  proposalHome,
  createFile,
  runRef,
  saveRef,
  newQueryRef,
  runnerRef,
  resultsCommandsRef,
  canRunRef
}: EditorBridgeParams): {
  activeFileNameRef: MutableRefObject<string | null>
  activeIsSqlRef: MutableRefObject<boolean>
} {
  const activeFileNameRef = useRef<string | null>(null)
  activeFileNameRef.current = activeFileName
  const activeIsSqlRef = useRef(true)
  activeIsSqlRef.current = isSqlFile

  const proposalHomeRef = useRef<{
    connId: string
    database: string | null
  } | null>(null)
  proposalHomeRef.current = proposalHome
  const createFileRef = useRef(createFile)
  createFileRef.current = createFile

  useEffect(() => {
    bridge.current = {
      getActiveSql: () => ({
        fileName: activeIsSqlRef.current ? activeFileNameRef.current : null,
        sql: activeIsSqlRef.current ? (editorRef.current?.getValue() ?? '') : ''
      }),
      getSelection: () => {
        if (!activeIsSqlRef.current) return null
        const ed = editorRef.current
        const model = ed?.getModel()
        const selection = ed?.getSelection()
        if (!model || model.isDisposed() || !selection || selection.isEmpty()) {
          return null
        }
        return {
          fileName: activeFileNameRef.current,
          sql: model.getValueInRange(selection),
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber
        }
      },
      insertSql: (sql: string) => {
        if (!activeIsSqlRef.current) return
        const ed = editorRef.current
        const model = ed?.getModel()
        if (!ed || !model) return
        const selection = ed.getSelection()
        const end = model.getFullModelRange()
        const range = selection ?? {
          startLineNumber: end.endLineNumber,
          startColumn: end.endColumn,
          endLineNumber: end.endLineNumber,
          endColumn: end.endColumn
        }
        const text = sql.endsWith('\n') ? sql : `${sql}\n`
        ed.executeEdits('ai-agent', [{ range, text, forceMoveMarkers: true }])
        ed.focus()
      },
      proposeSql: (sql: string) => {
        const text = sql.endsWith('\n') ? sql : `${sql}\n`
        const fileId = activeFileIdRef.current
        if (activeIsSqlRef.current && fileId) {
          const current = buffersRef.current.get(fileId) ?? ''
          if (!current.trim()) {
            applyProposal(fileId, text)
            return 'applied'
          }
          setProposal({ fileId, sql: text })
          return 'pending'
        }
        // No SQL tab to write into: create a fresh query file on the active
        // connection and land the SQL there once its buffer loads.
        const home = proposalHomeRef.current
        if (!home) return 'unavailable'
        pendingApplyRef.current = text
        createFileRef.current(home.connId, home.database)
        return 'applied'
      },
      commands: {
        runActive: () => runRef.current(),
        saveActive: () => saveRef.current(),
        formatActive: () => {
          if (!activeIsSqlRef.current) return
          editorRef.current?.getAction('editor.action.formatDocument')?.run()
        },
        newQuery: () => newQueryRef.current(),
        pinActiveResult: () => {
          const liveTab = runnerRef.current.tabs.find((tab) => !tab.pinned)
          if (!liveTab || liveTab.running || !liveTab.result) return
          runnerRef.current.pin(liveTab.id)
        },
        openExportMenu: () => resultsCommandsRef.current?.openExportMenu(),
        closeAllResults: () => runnerRef.current.closeAll(),
        canRun: () => canRunRef.current,
        canPin: () => {
          const liveTab = runnerRef.current.tabs.find((tab) => !tab.pinned)
          return !!liveTab && !liveTab.running && !!liveTab.result
        },
        canExport: () => resultsCommandsRef.current?.canExport() ?? false
      }
    }
    return () => {
      bridge.current = null
    }
  }, [
    bridge,
    applyProposal,
    editorRef,
    activeFileIdRef,
    buffersRef,
    pendingApplyRef,
    setProposal,
    runRef,
    saveRef,
    newQueryRef,
    runnerRef,
    resultsCommandsRef,
    canRunRef
  ])

  return { activeFileNameRef, activeIsSqlRef }
}
