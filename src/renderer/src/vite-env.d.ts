/// <reference types="vite/client" />

import type { DbDeskApi } from '../../preload'

declare global {
  type MonacoWorkerConstructor = new () => Worker

  interface Window {
    dbDesk: DbDeskApi
    MonacoEnvironment?: {
      getWorker(workerId: string, label: string): Worker
    }
  }
}

export {}
