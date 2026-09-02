/**
 * The Electron application menu. `src/main/index.ts` sets no menu on its
 * own, so before this file existed Electron supplied a bare-bones default
 * menu — and that default is where ⌘C/⌘V/⌘Q (and the rest of the standard
 * Edit/Window/App behaviour) actually came from. Calling
 * `Menu.setApplicationMenu` at all — even to add one Help submenu — replaces
 * that default wholesale, so this file rebuilds the *whole* menu from
 * Electron's role-based templates (`appMenu`, `fileMenu`, `editMenu`,
 * `viewMenu`, `windowMenu`) and appends Help. Omitting any of those roles
 * would silently break the shortcuts they provide.
 *
 * Accelerators on the Help items below are display + fallback, not the
 * primary path: the renderer's capture-phase global-shortcut listener
 * (`useGlobalShortcuts`) normally handles ⌘K / ⌘/ / ⌘⇧/ first. On macOS,
 * Electron's registered menu accelerators fire *before* the renderer sees
 * the keydown, which would double-dispatch the command (menu send +
 * renderer handler) on every chord. To avoid that, the command-palette and
 * shortcut/highlight chords are shown but not registered, via MenuItem's
 * macOS-only `registerAccelerator: false` — the accelerator renders in the
 * menu for discoverability without Electron intercepting the key.
 */
import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import type { CommandId } from '../shared/features'

export function installApplicationMenu(send: (commandId: CommandId) => void): void {
  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      {
        label: 'User Guide',
        click: () => send('app.openGuide')
      },
      {
        label: 'Keyboard Shortcuts',
        accelerator: 'CmdOrCtrl+/',
        registerAccelerator: false,
        click: () => send('app.openShortcuts')
      },
      {
        label: 'Command Palette…',
        accelerator: 'CmdOrCtrl+K',
        registerAccelerator: false,
        click: () => send('app.openPalette')
      },
      {
        label: 'Discover Features…',
        click: () => send('app.openDiscover')
      },
      {
        label: 'Highlight Features',
        accelerator: 'CmdOrCtrl+Shift+/',
        registerAccelerator: false,
        click: () => send('app.toggleHighlight')
      },
      { type: 'separator' },
      {
        label: 'Ask DB Desk…',
        click: () => send('agent.askHelp')
      }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    helpMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
