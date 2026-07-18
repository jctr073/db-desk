/**
 * Typed main-process ends of the IPC bridge. Everything is generic over the
 * contract in src/shared/ipc.ts, so handler arguments and results — and the
 * channel names themselves — are checked at compile time. Registering a
 * handler for a channel the contract does not know, or sending the wrong
 * payload shape, is a type error.
 */

import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import type { IpcInvokeContract, IpcPushContract } from '../shared/ipc'

/** `ipcMain.handle` with channel, args, and result typed by the contract. */
export function typedHandle<C extends keyof IpcInvokeContract>(
  channel: C,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcInvokeContract[C]['args']
  ) => IpcInvokeContract[C]['result'] | Promise<IpcInvokeContract[C]['result']>
): void {
  ipcMain.handle(channel, handler)
}

/**
 * `webContents.send` with the payload typed by the contract. Carries the
 * standard liveness guard every push site used: a null or destroyed window
 * silently drops the message (the renderer is gone; there is no one to tell).
 */
export function typedSend<C extends keyof IpcPushContract>(
  win: BrowserWindow | null,
  channel: C,
  ...payload: IpcPushContract[C]
): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...payload)
  }
}

/**
 * `ipcMain.on` for the renderer → main fire-and-forget channels of the push
 * contract (currently only `agent:editor-read-reply`).
 */
export function typedOn<C extends keyof IpcPushContract>(
  channel: C,
  listener: (event: IpcMainEvent, ...payload: IpcPushContract[C]) => void
): void {
  ipcMain.on(channel, listener)
}
