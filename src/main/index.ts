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
import { deleteSaved, listSaved, saveConnection, savedParams } from './store'
import {
  listQueries,
  createQuery,
  loadQueryContent,
  saveQueryContent,
  deleteQuery,
  getNextQueryName,
  deleteQueriesForConnection
} from './files'
import type { ConnectParams } from '../shared/db'

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
  ipcMain.handle('store:delete', (_event, id: string) => deleteSaved(id))
}

function registerFileHandlers(): void {
  ipcMain.handle('files:list', () => listQueries())
  ipcMain.handle(
    'files:create',
    (_event, connId: string | null, database: string | null) => {
      const name = getNextQueryName(connId, database)
      return createQuery(name, connId, database)
    }
  )
  ipcMain.handle('files:read', (_event, id: string) => loadQueryContent(id))
  ipcMain.handle('files:save', (_event, id: string, content: string) =>
    saveQueryContent(id, content)
  )
  ipcMain.handle('files:delete', (_event, id: string) => deleteQuery(id))
  ipcMain.handle('files:getNextName', (_event, connId: string | null, database: string | null) =>
    getNextQueryName(connId, database)
  )
  ipcMain.handle('files:deleteForConnection', (_event, connId: string) =>
    deleteQueriesForConnection(connId)
  )
}

app.whenReady().then(() => {
  registerDbHandlers()
  registerFileHandlers()
  registerAgentHandlers(() => mainWindow)
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
})
