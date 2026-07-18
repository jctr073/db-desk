import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { typedHandle, typedSend } from './ipc'
import { validateSchemaSelectionConfig, validateStoreSavePayload } from './ipcGuards'
import {
  connect,
  disconnect,
  disconnectAll,
  introspectDatabase,
  listCatalogs,
  listSchemas,
  runQuery,
  setSchemaEventSink,
  testConnection
} from './db'
import { deleteCacheFor, dropIntrospection } from './schemaCache'
import { invalidateAgentSchemaCache, registerAgentHandlers } from './agent'
import { registerMcpHandlers, stopAllMcpServers } from './mcp'
import { registerRepoHandlers } from './repo'
import { deleteSkillsForConnection, registerSkillHandlers } from './skills'
import {
  deleteSaved,
  getSchemaConfig,
  listSaved,
  saveConnection,
  savedParams,
  setSchemaConfig,
  setCatalogSelection,
  setSchemaSelection
} from './store'
import {
  listQueries,
  createQuery,
  getNextFileName,
  loadQueryContent,
  saveQueryContent,
  deleteQuery,
  getNextQueryName,
  deleteQueriesForConnection,
  renameQuery,
  reassignQuery,
  isFileKind,
  moveQueryStorage
} from './files'
import {
  appSettingsInfo,
  clearStoredApiKey,
  loadApiKey,
  setApiKeyVarName,
  setStoredApiKey,
  sqlFilesDir
} from './settings'
import {
  addLink,
  createBase,
  deleteBase,
  deleteLinksForConnection,
  deleteRecord,
  groupsForTarget,
  listBases,
  listLinks,
  listRecords,
  migrateLegacyKnowledge,
  migrateLinksToSchemaScope,
  removeLink,
  renameBase,
  saveRecord,
  targetsForBase
} from './knowledge'
import { extractExemplarReferences, setExemplarApiKeyLoader } from './exemplar'
import {
  chooseExportDestination,
  discardExportDestination,
  writeExportDestination
} from './dataExport'
import { dialectFor } from '../shared/dialect'
import type { KnowledgeChangeEvent } from '../shared/knowledge'

// In development Electron otherwise uses the executable name ("Electron") for
// the macOS application menu. Set this before the app becomes ready so dev and
// packaged builds both present the product name consistently.
app.setName('DB Desk')

let mainWindow: BrowserWindow | null = null

function getRendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL
}

function isAllowedNavigation(url: string): boolean {
  const rendererUrl = getRendererUrl()

  if (rendererUrl) {
    return url.startsWith(rendererUrl)
  }

  return url.startsWith('file://')
}

/**
 * Hand a link off to the OS browser/mail client only for schemes that open a
 * document. Anything else (file:, smb:, app-registered custom schemes) could
 * launch local handlers with an attacker-chosen payload, so it is dropped —
 * links in query results and agent output are untrusted content.
 */
const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

function openExternalChecked(url: string): void {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return
  }
  if (EXTERNAL_URL_SCHEMES.has(scheme)) {
    void shell.openExternal(url)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DB Desk',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalChecked(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) {
      return
    }

    event.preventDefault()
    openExternalChecked(url)
  })

  const rendererUrl = getRendererUrl()

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerDbHandlers(): void {
  typedHandle('db:test', (_event, params) => testConnection(params))
  typedHandle('db:connect', (_event, connId, params) => connect(connId, params))
  typedHandle('db:introspect', (_event, connId, database) => introspectDatabase(connId, database))
  typedHandle('db:disconnect', (_event, connId) => disconnect(connId))
  typedHandle('db:query', (_event, connId, database, sql, limit) =>
    runQuery(connId, database, sql, limit)
  )
  typedHandle('db:queryForExport', (_event, connId, database, sql) =>
    runQuery(connId, database, sql, null, { readOnly: true })
  )
  typedHandle('db:connectSaved', (_event, connId) => {
    const params = savedParams(connId)
    if (!params) return { ok: false as const, error: 'Saved connection not found' }
    return connect(connId, params)
  })
  typedHandle('db:listSchemas', (_event, connId, database) => listSchemas(connId, database))
  typedHandle('db:listCatalogs', (_event, connId) => listCatalogs(connId))

  typedHandle('store:list', () => listSaved())
  typedHandle('store:save', (_event, id, name, params, savePassword) => {
    // Persists to the connection store (and keychain); shapes are enforced
    // at the boundary because the renderer payload cannot be trusted.
    validateStoreSavePayload(id, name, params, savePassword)
    return saveConnection(id, name, params, savePassword)
  })
  typedHandle('store:getSchemaConfig', (_event, id) => getSchemaConfig(id))
  typedHandle('store:setSchemaConfig', (_event, id, config) => {
    validateSchemaSelectionConfig(id, config)
    setSchemaConfig(id, config)
    invalidateAgentSchemaCache(id)
  })
  typedHandle('store:setCatalogSelection', (_event, id, catalogs) => {
    setCatalogSelection(id, catalogs)
    invalidateAgentSchemaCache(id)
  })
  typedHandle('store:setSchemaSelection', (_event, id, catalog, schemas) => {
    setSchemaSelection(id, catalog, schemas)
    invalidateAgentSchemaCache(id, catalog)
    // The persisted introspection was taken under the old pinning; the
    // selection stamp would reject it anyway, dropping keeps the file lean.
    dropIntrospection(id, catalog)
  })
  typedHandle('store:delete', (_event, id) => {
    // Deleting a connection drops its knowledge *links*, never the bases
    // themselves — a base may be shared with other connections (prod/staging/
    // dev), and an orphaned one can be relinked or deleted from the UI.
    deleteLinksForConnection(id)
    deleteSkillsForConnection(id)
    deleteCacheFor(id)
    return deleteSaved(id)
  })
}

function registerSettingsHandlers(): void {
  // Any mutation pushes settings:changed so open views (the settings dialog,
  // the agent panel's missing-key notice) refresh without polling.
  const broadcast = (): void => {
    typedSend(mainWindow, 'settings:changed')
  }

  typedHandle('settings:get', () => appSettingsInfo())

  typedHandle('settings:chooseSqlDir', async () => {
    if (!mainWindow) return { status: 'canceled' as const }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose SQL Files Directory',
      defaultPath: sqlFilesDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { status: 'canceled' as const }
    }
    try {
      const movedFiles = moveQueryStorage(picked.filePaths[0])
      broadcast()
      return { status: 'moved' as const, sqlDir: sqlFilesDir(), movedFiles }
    } catch (error) {
      return {
        status: 'error' as const,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  typedHandle('settings:setApiKeyVar', (_event, name) => {
    setApiKeyVarName(name)
    broadcast()
    return appSettingsInfo()
  })

  typedHandle('settings:setStoredApiKey', (_event, key, label) => {
    setStoredApiKey(key, label)
    broadcast()
    return appSettingsInfo()
  })

  typedHandle('settings:clearStoredApiKey', () => {
    clearStoredApiKey()
    broadcast()
    return appSettingsInfo()
  })
}

function registerExportHandlers(): void {
  typedHandle('export:choose', (_event, suggestedName, format) =>
    chooseExportDestination(mainWindow, suggestedName, format)
  )
  typedHandle('export:write', (_event, token, contents) => writeExportDestination(token, contents))
  typedHandle('export:discard', (_event, token) => discardExportDestination(token))
}

function registerFileHandlers(): void {
  typedHandle('files:list', () => listQueries())
  typedHandle('files:create', (_event, connId, database, requestedKind) => {
    if (!connId) throw new Error('A query file needs a connection')
    const kind = isFileKind(requestedKind) ? requestedKind : 'sql'
    const name = getNextFileName(connId, database, kind)
    return createQuery(name, connId, database)
  })
  typedHandle('files:reassign', (_event, id, connId, database) =>
    reassignQuery(id, connId, database)
  )
  typedHandle('files:read', (_event, id) => loadQueryContent(id))
  typedHandle('files:save', (_event, id, content) => saveQueryContent(id, content))
  typedHandle('files:rename', (_event, id, name) => renameQuery(id, name))
  typedHandle('files:delete', (_event, id) => deleteQuery(id))
  typedHandle('files:getNextName', (_event, connId, database) => getNextQueryName(connId, database))
  typedHandle('files:deleteForConnection', (_event, connId) => deleteQueriesForConnection(connId))
}

function registerKnowledgeHandlers(getWindow: () => BrowserWindow | null): void {
  // Record content changed inside one base: names the base plus every
  // (connection, database) target linked to it, so target-keyed views can
  // match without knowing the link table.
  const broadcastRecords = (kbId: string): void => {
    const change: KnowledgeChangeEvent = { kbId, targets: targetsForBase(kbId) }
    typedSend(getWindow(), 'knowledge:changed', change)
  }
  // Bases or links changed shape (create/rename/delete/link/unlink): coarse
  // on purpose — these are rare, user-initiated operations, and the renderer
  // reloads its base/link state wholesale.
  const broadcastStructure = (): void => {
    typedSend(getWindow(), 'knowledge:structureChanged')
  }

  // --- Bases ---
  typedHandle('knowledge:listBases', () => listBases())
  typedHandle('knowledge:createBase', (_event, name) => {
    const base = createBase(name)
    broadcastStructure()
    return base
  })
  typedHandle('knowledge:renameBase', (_event, kbId, name) => {
    const base = renameBase(kbId, name)
    broadcastStructure()
    return base
  })
  typedHandle('knowledge:deleteBase', (_event, kbId) => {
    deleteBase(kbId)
    broadcastStructure()
  })

  // --- Links ---
  typedHandle('knowledge:listLinks', () => listLinks())
  typedHandle('knowledge:addLink', (_event, input) => {
    const link = addLink(input)
    broadcastStructure()
    return link
  })
  typedHandle('knowledge:removeLink', (_event, linkId) => {
    removeLink(linkId)
    broadcastStructure()
  })

  // --- Records ---
  typedHandle('knowledge:list', (_event, kbId) => listRecords(kbId))
  typedHandle('knowledge:listForTarget', (_event, connId, database) =>
    groupsForTarget(connId, database)
  )
  typedHandle('knowledge:save', (_event, kbId, record) => {
    const saved = saveRecord(kbId, record)
    broadcastRecords(kbId)
    return saved
  })
  typedHandle('knowledge:saveExemplar', async (_event, kbId, connId, database, question, sql) => {
    // Reference extraction happens once, here at save time (never at click
    // time): the LLM path when a key is available, else text matching. The
    // (connId, database) pair is the live connection to extract against;
    // the record itself lands in the named base.
    const references = await extractExemplarReferences(connId, database, sql)
    if (!kbId) {
      // First knowledge for this target: create a base named after the
      // database, linked at the schema the exemplar's own references name
      // (else the engine's default schema — links are schema-scoped).
      // Done here, after extraction, so the renderer never has to guess.
      const base = createBase(database)
      const conn = listSaved().find((c) => c.id === connId)
      const schema =
        references.find((ref) => typeof ref.schema === 'string' && ref.schema.trim() !== '')
          ?.schema ?? dialectFor(conn?.type).defaultSchema
      addLink({ kbId: base.id, connId, database, schema })
      kbId = base.id
      broadcastStructure()
    }
    const saved = saveRecord(kbId, {
      kind: 'exemplar',
      source: 'human',
      question,
      sql,
      references
    })
    broadcastRecords(kbId)
    return saved
  })
  typedHandle('knowledge:delete', (_event, kbId, id) => {
    deleteRecord(kbId, id)
    broadcastRecords(kbId)
  })
}

app.whenReady().then(() => {
  // Packaged builds get the icon from the app bundle; in dev the Electron
  // binary's own icon would show, so override the Dock icon at runtime
  // (scripts/patch-dev-electron.sh handles the menu-bar name and Finder icon).
  if (process.platform === 'darwin' && !app.isPackaged) {
    const devIcon = join(app.getAppPath(), 'resources', 'icon.png')
    if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
  }

  // Convert any v1 per-(connection, database) knowledge layout to bases +
  // links before anything reads the store. The resolver names migrated bases
  // after the saved connection; store.ts imports knowledge.ts, so the lookup
  // is injected rather than imported (cycle).
  migrateLegacyKnowledge((connId) => {
    const conn = listSaved().find((c) => c.id === connId)
    return conn ? { name: conn.name, database: conn.database } : null
  })
  // Then expand any database-wide links (v1 shape, including ones the legacy
  // migration above just minted) into the schema-scoped links the store now
  // requires. The fallback schema follows the connection's engine; a link
  // whose connection no longer exists gets the PostgreSQL default.
  migrateLinksToSchemaScope((connId) => {
    const conn = listSaved().find((c) => c.id === connId)
    return dialectFor(conn?.type).defaultSchema
  })

  // The exemplar extractor keeps no Electron imports (unit-testability), so
  // hand it the settings-backed key resolver instead of letting it import one.
  setExemplarApiKeyLoader(() => loadApiKey().key)

  // Background schema revalidation progress → renderer status/tree updates.
  setSchemaEventSink((evt) => {
    typedSend(mainWindow, 'db:schema-refresh', evt)
  })

  registerDbHandlers()
  registerSettingsHandlers()
  registerExportHandlers()
  registerFileHandlers()
  registerKnowledgeHandlers(() => mainWindow)
  registerAgentHandlers(() => mainWindow)
  registerMcpHandlers(() => mainWindow)
  registerRepoHandlers(() => mainWindow)
  registerSkillHandlers(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  void disconnectAll()
  void stopAllMcpServers()
})
