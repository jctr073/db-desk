import { useCallback, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'

import type { CommandId } from '../../../shared/features'
import type { EditorBridge } from '../components/editorBridge'
import type { AgentPanelTab } from '../components/AgentPanel'

/** One handler per command id; `satisfies` in the builder keeps it complete. */
export type CommandHandlers = Record<CommandId, () => void>

export interface CommandDeps {
  editorBridge: MutableRefObject<EditorBridge | null>
  openSettings: () => void
  openPalette: () => void
  openShortcuts: () => void
  openGuide: () => void
  openDiscover: () => void
  toggleHighlight: () => void
  openNewConnection: () => void
  showPanelTab: (tab: AgentPanelTab) => void
  newChat: () => void
  focusComposer: () => void
  askHelp: () => void
  manageKnowledge: () => void
}

export interface Commands {
  run: (id: CommandId) => void
  /** False when the command would do nothing right now (e.g. Run with no SQL tab). */
  enabled: (id: CommandId) => boolean
}

/**
 * The app-level command dispatch table. Data about features lives in
 * `src/shared/features.ts`; the behaviours live here, in the renderer, built
 * once from things App already owns. Every surface (palette, Help menu,
 * shortcuts, Discover, /help) routes through `run` so usage can be tracked
 * in one place.
 */
export function useCommands(deps: CommandDeps): Commands {
  // Read deps through a ref so `run`/`enabled` stay stable across renders.
  const depsRef = useRef(deps)
  depsRef.current = deps

  const handlers = useMemo(
    () =>
      ({
        'app.openSettings': () => depsRef.current.openSettings(),
        'app.openPalette': () => depsRef.current.openPalette(),
        'app.openShortcuts': () => depsRef.current.openShortcuts(),
        'app.openGuide': () => depsRef.current.openGuide(),
        'app.openDiscover': () => depsRef.current.openDiscover(),
        'app.toggleHighlight': () => depsRef.current.toggleHighlight(),
        'connections.new': () => depsRef.current.openNewConnection(),
        'editor.newQuery': () => depsRef.current.editorBridge.current?.commands.newQuery(),
        'editor.run': () => depsRef.current.editorBridge.current?.commands.runActive(),
        'editor.save': () => depsRef.current.editorBridge.current?.commands.saveActive(),
        'editor.format': () => depsRef.current.editorBridge.current?.commands.formatActive(),
        'results.pin': () => depsRef.current.editorBridge.current?.commands.pinActiveResult(),
        'results.export': () => depsRef.current.editorBridge.current?.commands.openExportMenu(),
        'results.closeAll': () => depsRef.current.editorBridge.current?.commands.closeAllResults(),
        'panel.showAgent': () => depsRef.current.showPanelTab('agent'),
        'panel.showKnowledge': () => depsRef.current.showPanelTab('knowledge'),
        'panel.showFiles': () => depsRef.current.showPanelTab('files'),
        'panel.showSkills': () => depsRef.current.showPanelTab('skills'),
        'agent.newChat': () => depsRef.current.newChat(),
        'agent.focusComposer': () => depsRef.current.focusComposer(),
        'agent.askHelp': () => depsRef.current.askHelp(),
        'knowledge.manage': () => depsRef.current.manageKnowledge()
      }) satisfies CommandHandlers,
    []
  )

  const run = useCallback(
    (id: CommandId) => {
      handlers[id]()
      // phase 3: markUsed(featureForCommand(id)?.id)
    },
    [handlers]
  )

  const enabled = useCallback((id: CommandId): boolean => {
    const commands = depsRef.current.editorBridge.current?.commands
    switch (id) {
      case 'editor.run':
      case 'editor.format':
        return commands?.canRun() ?? false
      case 'editor.save':
      case 'editor.newQuery':
        return commands !== undefined
      case 'results.pin':
        return commands?.canPin() ?? false
      case 'results.export':
        return commands?.canExport() ?? false
      default:
        return true
    }
  }, [])

  return useMemo(() => ({ run, enabled }), [run, enabled])
}
