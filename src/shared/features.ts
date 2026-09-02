/**
 * The feature registry: the single source of truth for what DB Desk can do,
 * where each feature lives in the UI, and which user-guide section explains
 * it. The command palette, shortcut sheet, Discover browser, highlight mode
 * and the agent's /help prompt all read from this list, so feature copy must
 * never be duplicated elsewhere.
 *
 * Pure data: no React, no DOM, no Electron. Main, renderer and unit tests all
 * import it.
 */

export type FeatureCategory =
  | 'connections'
  | 'schema'
  | 'editor'
  | 'results'
  | 'agent'
  | 'knowledge'
  | 'files'
  | 'skills'
  | 'app'

export const FEATURE_CATEGORY_LABELS: Record<FeatureCategory, string> = {
  connections: 'Connections',
  schema: 'Schema',
  editor: 'Editor',
  results: 'Results',
  agent: 'AI Agent',
  knowledge: 'Knowledge',
  files: 'Files',
  skills: 'Skills',
  app: 'App'
}

/** Renderer-side behaviours the palette / Discover / Help menu can trigger. */
export const COMMAND_IDS = [
  'app.openSettings',
  'app.openPalette',
  'app.openShortcuts',
  'app.openGuide',
  'app.openDiscover',
  'app.toggleHighlight',
  'connections.new',
  'editor.newQuery',
  'editor.run',
  'editor.save',
  'editor.format',
  'results.pin',
  'results.export',
  'results.closeAll',
  'panel.showAgent',
  'panel.showKnowledge',
  'panel.showFiles',
  'panel.showSkills',
  'agent.newChat',
  'agent.focusComposer',
  'agent.askHelp',
  'knowledge.manage'
] as const
export type CommandId = (typeof COMMAND_IDS)[number]

export function isCommandId(id: string): id is CommandId {
  return (COMMAND_IDS as readonly string[]).includes(id)
}

export interface Feature {
  /** Stable id, dotted, lower-case. Also the default `data-feature` anchor. */
  id: string
  title: string
  /** One sentence, <= 120 chars, present tense, no trailing period. */
  description: string
  category: FeatureCategory
  /** Where it is in the UI, written for someone who has never seen it. Required. */
  location: string
  /** Display form only, e.g. '⌘⏎'. Not parsed. */
  shortcut?: string
  /** Heading slug in docs/user-guide.md, e.g. 'read-and-manage-results'. */
  guide: string
  /** Command the palette runs for this feature; omit for gesture-only features. */
  command?: CommandId
  /** Command that makes the anchored element visible (opens a tab/menu) before spotlighting. */
  reveal?: CommandId
  /** Override the data-feature selector value when one element hosts several features. */
  anchor?: string
  /** Free-text search boosters, e.g. ['tsv', 'csv'] for Export. */
  keywords?: string[]
}

export const FEATURES: readonly Feature[] = [
  {
    id: 'connections.new',
    title: 'New connection',
    description: 'Open a new connection dialog for PostgreSQL or Databricks',
    category: 'connections',
    location: '"+" at the top of the Connections panel',
    guide: 'connect-to-a-database',
    command: 'connections.new',
    keywords: ['postgres', 'databricks', 'connect']
  },
  {
    id: 'connections.environment',
    title: 'Environment (dev/stage/prod)',
    description:
      'Mark a connection dev, stage, or prod; prod clamps a writable Postgres role to Metadata Only',
    category: 'connections',
    location: 'Connection dialog › Environment; prod clamps the agent to Read & Run',
    guide: 'saved-connections',
    keywords: ['prod', 'dev', 'stage']
  },
  {
    id: 'schema.tree',
    title: 'Schema tree',
    description: 'Browse databases, schemas, tables, views, and columns in the live schema tree',
    category: 'schema',
    location: 'Below the connection in the Connections panel',
    guide: 'browse-the-schema'
  },
  {
    id: 'schema.filter',
    title: 'Filter the schema tree',
    description: 'Narrow the visible schema tree to matching objects',
    category: 'schema',
    location: 'Filter box above the tree',
    guide: 'browse-the-schema',
    keywords: ['search', 'narrow']
  },
  {
    id: 'schema.dataPreview',
    title: 'Preview table data',
    description: 'Open a read-only SELECT * preview of a table, view, or materialized view',
    category: 'schema',
    location: 'Right-click a table › Preview data',
    guide: 'browse-the-schema'
  },
  {
    id: 'schema.addToAgent',
    title: 'Add schema object to AI chat',
    description: 'Add a schema, table, or view to the AI thread as context',
    category: 'schema',
    location: 'Right-click a schema/table/view › Add to AI chat',
    guide: 'agent-context',
    reveal: 'panel.showAgent'
  },
  {
    id: 'editor.newQuery',
    title: 'New query file',
    description: 'Create a new query file for the current connection and database',
    category: 'editor',
    location: '"+" in the editor tab strip, or a connection\'s context menu',
    guide: 'work-with-files-and-the-editor',
    command: 'editor.newQuery'
  },
  {
    id: 'editor.run',
    title: 'Run SQL',
    description: 'Run the selected SQL, or the statement at the cursor',
    category: 'editor',
    location: 'Run button in the editor toolbar',
    shortcut: '⌘⏎',
    guide: 'run-sql',
    command: 'editor.run',
    keywords: ['execute', 'query']
  },
  {
    id: 'editor.save',
    title: 'Save file',
    description: 'Save the active editor file',
    category: 'editor',
    location: 'Editor toolbar',
    shortcut: '⌘S',
    guide: 'work-with-files-and-the-editor',
    command: 'editor.save'
  },
  {
    id: 'editor.format',
    title: 'Format SQL',
    description: 'Format the SQL in the active editor',
    category: 'editor',
    location: 'Editor toolbar',
    shortcut: '⇧⌘F',
    guide: 'work-with-files-and-the-editor',
    command: 'editor.format'
  },
  {
    id: 'editor.rename',
    title: 'Rename a file',
    description: 'Rename an editor file from its tab context menu',
    category: 'editor',
    location: 'Right-click an editor tab › Rename',
    guide: 'work-with-files-and-the-editor'
  },
  {
    id: 'editor.preview',
    title: 'Render Markdown / JSON / text',
    description: 'Render Markdown, pretty-print JSON, or preview plain text',
    category: 'editor',
    location: 'Eye control in the toolbar of a non-SQL file',
    guide: 'work-with-files-and-the-editor'
  },
  {
    id: 'editor.addSelectionToAgent',
    title: 'Add selection to AI chat',
    description: 'Add the selected SQL or the whole query to the AI chat',
    category: 'editor',
    location: 'Select SQL, right-click › Add Selection to AI Chat',
    guide: 'agent-context',
    reveal: 'panel.showAgent'
  },
  {
    id: 'editor.undoAiChange',
    title: 'Undo an accepted AI change',
    description: 'Undo an AI editor change after accepting it',
    category: 'editor',
    location: '⌘Z in the editor after accepting a diff',
    shortcut: '⌘Z',
    guide: 'review-generated-work'
  },
  {
    id: 'results.limit',
    title: 'Row limit',
    description: 'Cap or lift the automatic 500-row limit on plain SELECT statements',
    category: 'results',
    location: 'Limit control in the results toolbar (default 500)',
    guide: 'run-sql',
    keywords: ['500', 'cap']
  },
  {
    id: 'results.pin',
    title: 'Pin a result',
    description: 'Pin a result so the next run does not replace it',
    category: 'results',
    location: 'Pin icon on the live result tab',
    guide: 'read-and-manage-results',
    command: 'results.pin'
  },
  {
    id: 'results.closeAll',
    title: 'Close all results',
    description: 'Close every open result tab',
    category: 'results',
    location: 'Overflow (») menu at the right of the result tabs',
    guide: 'read-and-manage-results',
    command: 'results.closeAll'
  },
  {
    id: 'results.select',
    title: 'Select rows, columns, ranges',
    description: 'Select rows, columns, or ranges in the results grid',
    category: 'results',
    location: 'Click a row number or column header; Shift for a range, ⌘ to toggle',
    guide: 'read-and-manage-results',
    keywords: ['shift', 'range']
  },
  {
    id: 'results.resizeKeyboard',
    title: 'Resize columns with the keyboard',
    description: 'Resize a grid column using the arrow keys',
    category: 'results',
    location: 'Focus a column edge, then use ← →',
    guide: 'read-and-manage-results'
  },
  {
    id: 'results.addToAgent',
    title: 'Add results to AI chat',
    description: 'Add a grid selection or the whole result to the AI chat',
    category: 'results',
    location: 'Right-click the grid › Add selection / result to AI chat',
    guide: 'agent-context',
    reveal: 'panel.showAgent'
  },
  {
    id: 'results.export',
    title: 'Export CSV / TSV / JSON',
    description: 'Export results as CSV, tab-delimited text, or JSON',
    category: 'results',
    location: 'Export button in the results toolbar; selections constrain the export',
    guide: 'export-results',
    command: 'results.export',
    keywords: ['csv', 'tsv', 'json']
  },
  {
    id: 'results.fixWithAi',
    title: 'Fix with AI',
    description: 'Ask the agent to resolve a failed query',
    category: 'results',
    location: "Appears on a failed query's result tab",
    guide: 'review-generated-work'
  },
  {
    id: 'results.saveExemplar',
    title: 'Save as exemplar',
    description: 'Pair the current SQL with a question and save it to Knowledge',
    category: 'results',
    location: 'Results toolbar › Save as exemplar…',
    guide: 'run-sql'
  },
  {
    id: 'agent.modes',
    title: 'Agent access modes',
    description: "Choose the agent's database access: Metadata Only, Read-Only, or Write/Admin",
    category: 'agent',
    location: 'Mode picker at the top of the AI Agent tab',
    guide: 'access-modes',
    reveal: 'panel.showAgent'
  },
  {
    id: 'agent.context',
    title: 'Context chips',
    description: 'Attach schema, SQL, results, or a failed query as context chips',
    category: 'agent',
    location: '"Add context" in the composer',
    guide: 'agent-context',
    reveal: 'panel.showAgent'
  },
  {
    id: 'agent.diffReview',
    title: 'Accept / reject AI edits',
    description: 'Accept or reject an inline diff of AI-written SQL',
    category: 'agent',
    location: 'Inline diff in the editor after the agent writes SQL',
    shortcut: 'Esc',
    guide: 'review-generated-work'
  },
  {
    id: 'agent.loadFinalQuery',
    title: 'Load final query',
    description: "Load the turn's final query into the editor for review",
    category: 'agent',
    location: 'Recap line at the end of a turn',
    guide: 'review-generated-work'
  },
  {
    id: 'agent.newChat',
    title: 'New chat / chat history',
    description: 'Archive the current chat and start a new one, or reopen chat history',
    category: 'agent',
    location: 'Buttons in the AI Agent tab header',
    guide: 'sessions-web-search-and-context-size',
    command: 'agent.newChat'
  },
  {
    id: 'agent.compact',
    title: '/compact and /clear',
    description: 'Replace a long chat history with a summary, or start fresh',
    category: 'agent',
    location: 'Type "/" in the composer',
    guide: 'sessions-web-search-and-context-size',
    reveal: 'agent.focusComposer',
    keywords: ['clear', 'slash']
  },
  {
    id: 'agent.webSearch',
    title: 'Web browsing toggle',
    description: 'Allow the agent server-side web search for the current chat',
    category: 'agent',
    location: 'Cog menu in the composer',
    guide: 'sessions-web-search-and-context-size',
    reveal: 'panel.showAgent'
  },
  {
    id: 'agent.mcp',
    title: 'MCP servers',
    description: 'Configure and manage MCP servers available to the agent',
    category: 'agent',
    location: 'Cog menu › MCP servers',
    guide: 'mcp-servers',
    reveal: 'panel.showAgent'
  },
  {
    id: 'agent.help',
    title: 'Ask DB Desk how to do something',
    description: 'Ask DB Desk how to do something in plain language',
    category: 'agent',
    location: 'Type "/help" followed by a question in the composer',
    guide: 'use-the-ai-agent',
    command: 'agent.askHelp'
  },
  {
    id: 'knowledge.bases',
    title: 'Knowledge bases',
    description: 'Browse knowledge bases linked to the current connection',
    category: 'knowledge',
    location: 'Knowledge tab in the right panel',
    guide: 'build-local-database-knowledge',
    reveal: 'panel.showKnowledge'
  },
  {
    id: 'knowledge.manage',
    title: 'Manage knowledge bases',
    description: 'Create, link, rename, or delete knowledge bases',
    category: 'knowledge',
    location: 'Knowledge tab › Manage',
    guide: 'build-local-database-knowledge',
    command: 'knowledge.manage'
  },
  {
    id: 'knowledge.attachCodebase',
    title: 'Attach and scan a codebase',
    description: 'Attach a local source directory to a knowledge base',
    category: 'knowledge',
    location: "Manage Knowledge Bases › a base's code-path card",
    guide: 'attach-and-scan-a-codebase',
    command: 'knowledge.manage'
  },
  {
    id: 'knowledge.monorepo',
    title: 'Map a monorepo to schemas',
    description: "Map a monorepo's service folders to their schemas",
    category: 'knowledge',
    location: 'Manage Knowledge Bases › Monorepo setup',
    guide: 'map-a-monorepo-to-its-schemas',
    command: 'knowledge.manage'
  },
  {
    id: 'knowledge.backgroundScans',
    title: 'Background scan agents',
    description: 'Track and manage running codebase scan agents',
    category: 'knowledge',
    location: 'Agents segment in the status bar opens the tray',
    guide: 'attach-and-scan-a-codebase',
    keywords: ['tray']
  },
  {
    id: 'files.panel',
    title: 'SQL Files tab',
    description: 'Browse and reopen saved SQL files',
    category: 'files',
    location: 'SQL Files tab in the right panel',
    guide: 'work-with-files-and-the-editor',
    reveal: 'panel.showFiles'
  },
  {
    id: 'files.watchedFolders',
    title: 'Watched folders',
    description: 'Point DB Desk at an external folder to edit its files alongside saved queries',
    category: 'files',
    location: 'Settings › Files, then the Folders mode of the SQL Files tab',
    guide: 'work-with-files-and-the-editor',
    command: 'app.openSettings',
    keywords: ['external', 'watch']
  },
  {
    id: 'skills.create',
    title: 'Create and run skills',
    description: 'Create reusable agent prompts with optional {{args}} placeholders',
    category: 'skills',
    location: 'Skills tab in the right panel',
    guide: 'create-and-run-skills',
    reveal: 'panel.showSkills'
  },
  {
    id: 'app.settings',
    title: 'Settings',
    description: 'Open Settings for appearance, files, and API keys',
    category: 'app',
    location: 'Gear at the left of the status bar',
    guide: 'get-oriented',
    command: 'app.openSettings'
  },
  {
    id: 'app.resizePanels',
    title: 'Resize panels',
    description: 'Drag a panel divider to resize it; widths are remembered',
    category: 'app',
    location: 'Drag either vertical divider; widths are remembered',
    guide: 'get-oriented'
  },
  {
    id: 'app.palette',
    title: 'Command palette',
    description: 'Open the command palette to search and run any feature',
    category: 'app',
    location: '⌘K anywhere',
    shortcut: '⌘K',
    guide: 'get-oriented',
    command: 'app.openPalette',
    keywords: ['cmd+k', 'command']
  },
  {
    id: 'app.shortcuts',
    title: 'Keyboard shortcuts',
    description: 'Show the keyboard shortcuts sheet',
    category: 'app',
    location: 'Help › Keyboard Shortcuts',
    shortcut: '⌘/',
    guide: 'get-oriented',
    command: 'app.openShortcuts'
  },
  {
    id: 'app.discover',
    title: 'Discover features',
    description: 'Browse every feature DB Desk offers',
    category: 'app',
    location: 'Help › Discover Features',
    guide: 'get-oriented',
    command: 'app.openDiscover'
  },
  {
    id: 'app.highlight',
    title: 'Highlight mode',
    description: 'Show numbered beacons on every feature currently on screen',
    category: 'app',
    location: 'Help › Highlight Features',
    shortcut: '⌘⇧/',
    guide: 'get-oriented',
    command: 'app.toggleHighlight'
  }
]

const byId = new Map<string, Feature>()
for (const feature of FEATURES) byId.set(feature.id, feature)

export function featureById(id: string): Feature | undefined {
  return byId.get(id)
}

/** The registry entry whose `command` is `id`, if any (for usage tracking). */
export function featureForCommand(id: CommandId): Feature | undefined {
  return FEATURES.find((feature) => feature.command === id)
}

/**
 * GitHub-style heading slug: lower-case, punctuation stripped, spaces to
 * hyphens. Must match how the guide viewer assigns heading ids and how the
 * registry test resolves `guide` anchors.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
