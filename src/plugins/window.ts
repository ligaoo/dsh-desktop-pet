/**
 * `window` plugin: the Electron shell. Creates the transparent, frameless,
 * always-on-top pet window, bridges renderer IPC to the `pet` service, and
 * binds the app's quit flow to the host teardown. Ported from the original
 * `startup.ts`; the Electron main entry (`src/entries/window.ts`) is a thin
 * bootstrap that starts the host with this plugin.
 *
 * Electron is imported dynamically so this module stays importable under
 * plain Node (tests, headless CLI); the setup throws a descriptive error when
 * it actually runs without Electron.
 *
 * @module desktop-pet/plugins/window
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { definePlugin, EVENTS, SERVICES, type PetSnapshotValue } from '../core/plugin.ts'
import { boolean, number, object, string, type Schema } from '../core/schema.ts'

/** Options for the `window` plugin. */
export interface WindowPluginOptions {
  /** Collapsed window width (pet only). */
  width?: number | undefined
  /** Collapsed window height (pet only). */
  height?: number | undefined
  /** Expanded window width (pet plus chat panel). */
  expandedWidth?: number | undefined
  /** Expanded window height (pet plus chat panel). */
  expandedHeight?: number | undefined
  /** Keep the window above other windows (default true). */
  alwaysOnTop?: boolean | undefined
  /** Hide the window from the taskbar (default true). */
  skipTaskbar?: boolean | undefined
  /** Window title; empty uses the pet name from the `identity` plugin (default ''). */
  title?: string | undefined
  /**
   * Window icon (shown in Alt-Tab and the taskbar on some platforms). A path
   * relative to the package root, e.g. `renderer/icon.png`. Falls back to the
   * default Electron icon when unset or the file is missing.
   */
  icon?: string | undefined
  /** Show a system-tray icon to summon the pet (default true). */
  tray?: boolean | undefined
  /** Tray icon path relative to the package root (default: built-in icon). */
  trayIcon?: string | undefined
  /** Global shortcut that summons the pet window (default `CommandOrControl+Shift+P`; `''` disables). */
  hotkey?: string | undefined
}

/** Options schema for the `window` plugin. */
export const windowConfig: Schema<WindowPluginOptions> = object({
  width: number(260),
  height: number(300),
  expandedWidth: number(340),
  expandedHeight: number(620),
  alwaysOnTop: boolean(true),
  skipTaskbar: boolean(true),
  title: string(''),
  icon: string(),
  tray: boolean(true),
  trayIcon: string(),
  hotkey: string('CommandOrControl+Shift+P'),
})

/** Built-in 32x32 tray icon: a soft blue gradient circle. */
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJeSURBVFhH7dfvSxNxHMDxPfThHvbQh/0X3aNahYoUlFE4iGQK0UCIBeEdkV06a1GNJVq3amziWLdqTAnr2NyY89S7zW1Xsbwka5TKmXPt4acbfB84vPb7+yDqDfds+75248P3vqf7318ZJ0ObV8gTXkEhPLxCPOc3CSamXpzchj6Cp0Bqz+hP5Fmf+LM4vbIDniUFXIvb8HRhC55Ef8DE/Hd4FMqx9rkNE/pKa5qRisTrdEHwJ/PgE3ehAg72d9/g/twG2N58kUZnZQNaovGCmYI5kC5AnThYZ9fhdvAzDAfWbGip+gtmfjHN4TLcePkJhtjsDMnUOR/BzJ6lFTjJZuG67yNYvO89aOnqqcNmaCV+bfoDXJ2SYNCVrm04Gxi46rg7A2bXau4KI+gRo92rdMGEB0/B5Wer0O9M0IjSzp/c5XDhA84EXJoUJUQdjBUUfZVNpim877EIFydWoHd86TAiyyttr7hx4/gynHfEjYgsb2p55yxu/IKDh56HcQsiy3Pz2ybc+Dn7Ipx5EKMQWZ4rvmXEjy/AKdsffkDpkYobP30vBl1jEe0ZYGK5dtx4990odFnnCUQeTMUFnHjnWCSHKO3sb79SGHE4ORJmEKWdjZP1Kp7DhBePDnPam9D+1JOMGQMOx+lw7YeTm4E1tpW4gQ4JR0iu9kMJqZ5wh15khZbgt0LyMZprR0vXHsnKehXnmr3zhvD9DbolWj1MFOvHw466/vZKDTCpQ/3OJNM3KSqV8A5rRDkxEvLUNO2N1uvgCRWneuxxqvRgKe3t3XeiVMdouPn3gH8sne43xyiaraqYF6AAAAAASUVORK5CYII='

/**
 * Resolve a shipped asset against the package root. The built layout
 * (`lib/plugins/window.js`) and the source layout (`src/plugins/window.ts`)
 * both sit two directories below the root, so one `../../` hop covers both.
 * @param path - asset path relative to the package root.
 * @returns the absolute asset path; throws when the asset is missing.
 */
function resolveAsset(path: string): string {
  const candidate = fileURLToPath(new URL(`../../${path}`, import.meta.url))
  if (!existsSync(candidate)) throw new Error(`desktop pet asset missing: ${candidate}`)
  return candidate
}

/**
 * The `window` plugin. Requires the `bridge` plugin (for the `pet` service).
 * The runtime subprocess starts lazily on the first prompt so the window
 * opens instantly; a failed handshake surfaces as the pet's `error` mood.
 */
export const windowPlugin = definePlugin<WindowPluginOptions>({
  name: 'window',
  version: '0.1.0',
  description: 'The Electron pet window: transparent, frameless, always-on-top, with a chat panel',
  requires: ['bridge'],
  config: windowConfig,
  async setup(ctx, options) {
    if (typeof process.versions.electron !== 'string') {
      throw new Error('window plugin requires an Electron runtime (launch with `npm start` or the `pet --window` command)')
    }
    const { app, BrowserWindow, ipcMain } = await import('electron')

    // One pet window per machine: a second launch asks the first to quit.
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      void ctx.host.dispose().finally(() => app.exit(0))
      throw new Error('another desktop pet instance is already running')
    }

    let closing = false
    const shutdown = (): void => {
      if (closing) return
      closing = true
      void ctx.host.dispose().finally(() => {
        app.exit(0)
      })
    }
    const onWillQuit = (event: { preventDefault(): void }): void => {
      if (closing) return
      event.preventDefault()
      shutdown()
    }
    app.on('will-quit', onWillQuit)
    app.on('window-all-closed', () => {
      app.quit()
    })

    await app.whenReady()

    // The pet's name drives the window title, tray tooltip and chat header.
    const identityName = ctx.get<import('../core/plugin.ts').PetIdentityService>(SERVICES.identity)?.name ?? 'DeepSeek 桌宠'
    const effectiveTitle = options.title !== undefined && options.title !== '' ? options.title : identityName

    // Optional window icon (Alt-Tab / taskbar). Paths resolve against the
    // package root; a missing file falls back to the Electron default icon.
    const iconPath = options.icon !== undefined ? fileURLToPath(new URL(`../../${options.icon}`, import.meta.url)) : undefined
    const window = new BrowserWindow({
      width: options.width ?? 260,
      height: options.height ?? 300,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: options.alwaysOnTop ?? true,
      skipTaskbar: options.skipTaskbar ?? true,
      hasShadow: false,
      title: effectiveTitle,
      ...iconPath !== undefined && existsSync(iconPath) && { icon: iconPath },
      webPreferences: {
        preload: resolveAsset('renderer/preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // ESM preload scripts require an unsandboxed renderer.
        sandbox: false,
      },
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    const pet = ctx.getOrThrow<import('../core/plugin.ts').PetService>('pet')
    ctx.provide<import('../core/plugin.ts').PetWindowService>(SERVICES.window, {
      isFocused: () => !window.isDestroyed() && window.isFocused(),
    })
    /** Bring the pet to the front, focused, with the chat panel expanded. */
    const summon = (): void => {
      if (window.isDestroyed()) return
      window.show()
      window.focus()
      window.webContents.send('desktop-pet:expand')
    }
    const disposeSnapshot = ctx.on('snapshot', (snapshot) => {
      if (!window.isDestroyed()) window.webContents.send('desktop-pet:snapshot', snapshot as PetSnapshotValue)
    })
    // Notifier clicks land here: summon the pet.
    const disposeFocus = ctx.on(EVENTS.petFocus, summon)
    // Host-forwarded approvals render as a card in the chat panel.
    const disposeApproval = ctx.on(EVENTS.approvalShown, (payload) => {
      if (window.isDestroyed()) return
      summon()
      window.webContents.send('desktop-pet:approval', payload)
    })
    const handlePrompt = (_event: unknown, text: unknown): Promise<string> => {
      if (typeof text !== 'string') return Promise.reject(new Error('desktop-pet:prompt expects the prompt text as a string'))
      return pet.prompt(text)
    }
    ipcMain.handle('desktop-pet:prompt', handlePrompt)
    // Drag tracking: the pet moves with the cursor 1:1. The position is
    // accumulated here in the main process instead of re-reading
    // window.getPosition() per event — during a fast drag the OS bounds read
    // can lag the last setPosition, dropping increments and making the window
    // move slower than the cursor.
    let dragX = 0
    let dragY = 0
    const [initialX = 0, initialY = 0] = window.getPosition()
    dragX = initialX
    dragY = initialY
    ipcMain.handle('desktop-pet:set-expanded', (_event: unknown, expanded: unknown) => {
      if (typeof expanded !== 'boolean' || window.isDestroyed()) return
      window.setSize(expanded ? (options.expandedWidth ?? 340) : (options.width ?? 260), expanded ? (options.expandedHeight ?? 620) : (options.height ?? 300))
      // setSize may nudge the window (e.g. near a screen edge); re-sync the
      // drag origin so subsequent drags stay 1:1.
      const [px = 0, py = 0] = window.getPosition()
      dragX = px
      dragY = py
    })
    ipcMain.handle('desktop-pet:drag-by', (_event: unknown, dx: unknown, dy: unknown) => {
      if (typeof dx !== 'number' || typeof dy !== 'number' || window.isDestroyed()) return
      dragX += dx
      dragY += dy
      window.setPosition(dragX, dragY)
    })
    ipcMain.handle('desktop-pet:approval-respond', (_event: unknown, requestId: unknown, outcome: unknown) => {
      if (typeof requestId !== 'string' || (outcome !== 'allowed-once' && outcome !== 'rejected')) return
      ctx.emit(EVENTS.approvalRespond, { requestId, outcome })
    })
    ipcMain.handle('desktop-pet:get-name', () => identityName)
    ipcMain.handle('desktop-pet:quit', () => {
      app.quit()
    })

    await window.loadFile(resolveAsset('renderer/index.html'))

    // --- System tray + global shortcut: summon the pet from anywhere.
    const { Tray, Menu, globalShortcut, nativeImage } = await import('electron')
    let tray: import('electron').Tray | undefined
    if (options.tray !== false) {
      const trayIconPath = options.trayIcon !== undefined && options.trayIcon !== ''
        ? (existsSync(fileURLToPath(new URL(`../../${options.trayIcon}`, import.meta.url))) ? fileURLToPath(new URL(`../../${options.trayIcon}`, import.meta.url)) : undefined)
        : undefined
      const icon = trayIconPath !== undefined ? nativeImage.createFromPath(trayIconPath) : nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
      tray = new Tray(icon)
      tray.setToolTip(`${identityName} — 单击唤起，右键菜单`)
      tray.on('click', summon)
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示桌宠', click: summon },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]))
    }
    const hotkey = options.hotkey ?? ''
    if (hotkey !== '') {
      const registered = globalShortcut.register(hotkey, summon)
      if (!registered) {
        ctx.logger.warn('global shortcut "%s" failed to register (in use by another app or an invalid accelerator)', hotkey)
      }
    }

    return () => {
      disposeSnapshot()
      disposeFocus()
      disposeApproval()
      tray?.destroy()
      if (hotkey !== '') globalShortcut.unregister(hotkey)
      ipcMain.removeHandler('desktop-pet:prompt')
      ipcMain.removeHandler('desktop-pet:set-expanded')
      ipcMain.removeHandler('desktop-pet:drag-by')
      ipcMain.removeHandler('desktop-pet:approval-respond')
      ipcMain.removeHandler('desktop-pet:get-name')
      ipcMain.removeHandler('desktop-pet:quit')
      app.removeListener('will-quit', onWillQuit)
      if (!window.isDestroyed()) window.destroy()
    }
  },
})
