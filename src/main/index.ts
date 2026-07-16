import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { SchemaSelectionConfig } from '../shared/schemaSelection'
import {
  connect,
  disconnect,
  disconnectAll,
  introspectDatabase,
  listCatalogs,
  listSchemas,
  runQuery,
  testConnection
} from './db'
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
import type { ConnectParams } from '../shared/db'
import { dialectFor } from '../shared/dialect'
import type { DataExportFormat } from '../shared/export'
import type {
  KnowledgeLinkInput,
  KnowledgeRecordInput
} from '../shared/knowledge'

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
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) {
      return
    }

    event.preventDefault()
    void shell.openExternal(url)
  })

  const rendererUrl = getRendererUrl()

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerDbHandlers(): void {
  ipcMain.handle('db:test', (_event, params: ConnectParams) =>
    testConnection(params)
  )
  ipcMain.handle(
    'db:connect',
    (_event, connId: string, params: ConnectParams) => connect(connId, params)
  )
  ipcMain.handle('db:introspect', (_event, connId: string, database: string) =>
    introspectDatabase(connId, database)
  )
  ipcMain.handle('db:disconnect', (_event, connId: string) =>
    disconnect(connId)
  )
  ipcMain.handle(
    'db:query',
    (
      _event,
      connId: string,
      database: string,
      sql: string,
      limit: number | null
    ) => runQuery(connId, database, sql, limit)
  )
  ipcMain.handle(
    'db:queryForExport',
    (_event, connId: string, database: string, sql: string) =>
      runQuery(connId, database, sql, null, { readOnly: true })
  )
  ipcMain.handle('db:connectSaved', (_event, connId: string) => {
    const params = savedParams(connId)
    if (!params)
      return { ok: false as const, error: 'Saved connection not found' }
    return connect(connId, params)
  })
  ipcMain.handle('db:listSchemas', (_event, connId: string, database: string) =>
    listSchemas(connId, database)
  )
  ipcMain.handle('db:listCatalogs', (_event, connId: string) =>
    listCatalogs(connId)
  )

  ipcMain.handle('store:list', () => listSaved())
  ipcMain.handle(
    'store:save',
    (
      _event,
      id: string,
      name: string,
      params: ConnectParams,
      savePassword: boolean
    ) => saveConnection(id, name, params, savePassword)
  )
  ipcMain.handle('store:getSchemaConfig', (_event, id: string) =>
    getSchemaConfig(id)
  )
  ipcMain.handle(
    'store:setSchemaConfig',
    (_event, id: string, config: SchemaSelectionConfig) => {
      setSchemaConfig(id, config)
      invalidateAgentSchemaCache(id)
    }
  )
  ipcMain.handle(
    'store:setCatalogSelection',
    (_event, id: string, catalogs: string[] | null) => {
      setCatalogSelection(id, catalogs)
      invalidateAgentSchemaCache(id)
    }
  )
  ipcMain.handle(
    'store:setSchemaSelection',
    (_event, id: string, catalog: string, schemas: string[] | null) => {
      setSchemaSelection(id, catalog, schemas)
      invalidateAgentSchemaCache(id, catalog)
    }
  )
  ipcMain.handle('store:delete', (_event, id: string) => {
    // Deleting a connection drops its knowledge *links*, never the bases
    // themselves — a base may be shared with other connections (prod/staging/
    // dev), and an orphaned one can be relinked or deleted from the UI.
    deleteLinksForConnection(id)
    deleteSkillsForConnection(id)
    return deleteSaved(id)
  })
}

function registerSettingsHandlers(): void {
  // Any mutation pushes settings:changed so open views (the settings dialog,
  // the agent panel's missing-key notice) refresh without polling.
  const broadcast = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings:changed')
    }
  }

  ipcMain.handle('settings:get', () => appSettingsInfo())

  ipcMain.handle('settings:chooseSqlDir', async () => {
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

  ipcMain.handle('settings:setApiKeyVar', (_event, name: string) => {
    setApiKeyVarName(name)
    broadcast()
    return appSettingsInfo()
  })

  ipcMain.handle(
    'settings:setStoredApiKey',
    (_event, key: string, label: string) => {
      setStoredApiKey(key, label)
      broadcast()
      return appSettingsInfo()
    }
  )

  ipcMain.handle('settings:clearStoredApiKey', () => {
    clearStoredApiKey()
    broadcast()
    return appSettingsInfo()
  })
}

function registerExportHandlers(): void {
  ipcMain.handle(
    'export:choose',
    (_event, suggestedName: string, format: DataExportFormat) =>
      chooseExportDestination(mainWindow, suggestedName, format)
  )
  ipcMain.handle('export:write', (_event, token: string, contents: string) =>
    writeExportDestination(token, contents)
  )
  ipcMain.handle('export:discard', (_event, token: string) =>
    discardExportDestination(token)
  )
}

function registerFileHandlers(): void {
  ipcMain.handle('files:list', () => listQueries())
  ipcMain.handle(
    'files:create',
    (
      _event,
      connId: string,
      database: string | null,
      requestedKind: unknown = 'sql'
    ) => {
      if (!connId) throw new Error('A query file needs a connection')
      const kind = isFileKind(requestedKind) ? requestedKind : 'sql'
      const name = getNextFileName(connId, database, kind)
      return createQuery(name, connId, database)
    }
  )
  ipcMain.handle(
    'files:reassign',
    (_event, id: string, connId: string, database: string | null) =>
      reassignQuery(id, connId, database)
  )
  ipcMain.handle('files:read', (_event, id: string) => loadQueryContent(id))
  ipcMain.handle('files:save', (_event, id: string, content: string) =>
    saveQueryContent(id, content)
  )
  ipcMain.handle('files:rename', (_event, id: string, name: string) =>
    renameQuery(id, name)
  )
  ipcMain.handle('files:delete', (_event, id: string) => deleteQuery(id))
  ipcMain.handle(
    'files:getNextName',
    (_event, connId: string | null, database: string | null) =>
      getNextQueryName(connId, database)
  )
  ipcMain.handle('files:deleteForConnection', (_event, connId: string) =>
    deleteQueriesForConnection(connId)
  )
}

function registerKnowledgeHandlers(
  getWindow: () => BrowserWindow | null
): void {
  // Record content changed inside one base: names the base plus every
  // (connection, database) target linked to it, so target-keyed views can
  // match without knowing the link table.
  const broadcastRecords = (kbId: string): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('knowledge:changed', {
        kbId,
        targets: targetsForBase(kbId)
      })
    }
  }
  // Bases or links changed shape (create/rename/delete/link/unlink): coarse
  // on purpose — these are rare, user-initiated operations, and the renderer
  // reloads its base/link state wholesale.
  const broadcastStructure = (): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('knowledge:structureChanged')
    }
  }

  // --- Bases ---
  ipcMain.handle('knowledge:listBases', () => listBases())
  ipcMain.handle('knowledge:createBase', (_event, name: string) => {
    const base = createBase(name)
    broadcastStructure()
    return base
  })
  ipcMain.handle(
    'knowledge:renameBase',
    (_event, kbId: string, name: string) => {
      const base = renameBase(kbId, name)
      broadcastStructure()
      return base
    }
  )
  ipcMain.handle('knowledge:deleteBase', (_event, kbId: string) => {
    deleteBase(kbId)
    broadcastStructure()
  })

  // --- Links ---
  ipcMain.handle('knowledge:listLinks', () => listLinks())
  ipcMain.handle('knowledge:addLink', (_event, input: KnowledgeLinkInput) => {
    const link = addLink(input)
    broadcastStructure()
    return link
  })
  ipcMain.handle('knowledge:removeLink', (_event, linkId: string) => {
    removeLink(linkId)
    broadcastStructure()
  })

  // --- Records ---
  ipcMain.handle('knowledge:list', (_event, kbId: string) => listRecords(kbId))
  ipcMain.handle(
    'knowledge:listForTarget',
    (_event, connId: string, database: string) =>
      groupsForTarget(connId, database)
  )
  ipcMain.handle(
    'knowledge:save',
    (_event, kbId: string, record: KnowledgeRecordInput) => {
      const saved = saveRecord(kbId, record)
      broadcastRecords(kbId)
      return saved
    }
  )
  ipcMain.handle(
    'knowledge:saveExemplar',
    async (
      _event,
      kbId: string | null,
      connId: string,
      database: string,
      question: string,
      sql: string
    ) => {
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
          references.find(
            (ref) => typeof ref.schema === 'string' && ref.schema.trim() !== ''
          )?.schema ?? dialectFor(conn?.type).defaultSchema
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
    }
  )
  ipcMain.handle('knowledge:delete', (_event, kbId: string, id: string) => {
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
