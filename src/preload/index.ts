import { contextBridge } from 'electron'

const api = Object.freeze({
  appName: 'DB Desk'
})

contextBridge.exposeInMainWorld('dbDesk', api)

export type DbDeskApi = typeof api
