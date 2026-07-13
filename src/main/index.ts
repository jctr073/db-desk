import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'

import {
  connect,
  disconnect,
  disconnectAll,
  introspectDatabase,
  runQuery,
  testConnection
} from './db'
import { registerAgentHandlers } from './agent'
import { registerMcpHandlers, stopAllMcpServers } from './mcp'
import { clearRepoRoot, registerRepoHandlers } from './repo'
import { deleteSaved, listSaved, saveConnection, savedParams } from './store'
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
  isFileKind
} from './files'
import {
  listRecords,
  saveRecord,
  deleteRecord,
  deleteForConnection as deleteKnowledgeForConnection
} from './knowledge'
import { extractExemplarReferences } from './exemplar'
import {
  chooseExportDestination,
  discardExportDestination,
  writeExportDestination
} from './dataExport'
import type { ConnectParams } from '../shared/db'
import type { DataExportFormat } from '../shared/export'
import type { KnowledgeRecordInput } from '../shared/knowledge'

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
  ipcMain.handle('store:delete', (_event, id: string) => {
    // A deleted connection's repo attachment has nothing to hang off; drop it
    // with the profile (mirrors how the renderer clears queries/knowledge).
    clearRepoRoot(id)
    return deleteSaved(id)
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
      connId: string | null,
      database: string | null,
      requestedKind: unknown = 'sql'
    ) => {
      const kind = isFileKind(requestedKind) ? requestedKind : 'sql'
      const name = getNextFileName(connId, database, kind)
      return createQuery(name, connId, database)
    }
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
  const broadcast = (connId: string, database: string): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('knowledge:changed', { connId, database })
    }
  }

  ipcMain.handle('knowledge:list', (_event, connId: string, database: string) =>
    listRecords(connId, database)
  )
  ipcMain.handle(
    'knowledge:save',
    (
      _event,
      connId: string,
      database: string,
      record: KnowledgeRecordInput
    ) => {
      const saved = saveRecord(connId, database, record)
      broadcast(connId, database)
      return saved
    }
  )
  ipcMain.handle(
    'knowledge:saveExemplar',
    async (
      _event,
      connId: string,
      database: string,
      question: string,
      sql: string
    ) => {
      // Reference extraction happens once, here at save time (never at click
      // time): the LLM path when a key is available, else text matching.
      const references = await extractExemplarReferences(connId, database, sql)
      const saved = saveRecord(connId, database, {
        kind: 'exemplar',
        source: 'human',
        question,
        sql,
        references
      })
      broadcast(connId, database)
      return saved
    }
  )
  ipcMain.handle(
    'knowledge:delete',
    (_event, connId: string, database: string, id: string) => {
      deleteRecord(connId, database, id)
      broadcast(connId, database)
    }
  )
  ipcMain.handle('knowledge:deleteForConnection', (_event, connId: string) =>
    deleteKnowledgeForConnection(connId)
  )
}

app.whenReady().then(() => {
  registerDbHandlers()
  registerExportHandlers()
  registerFileHandlers()
  registerKnowledgeHandlers(() => mainWindow)
  registerAgentHandlers(() => mainWindow)
  registerMcpHandlers(() => mainWindow)
  registerRepoHandlers(() => mainWindow)
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
