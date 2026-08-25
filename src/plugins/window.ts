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
import { definePlugin, EVENTS, SERVICES, type PetSnapshotValue, type PetTodoService } from '../core/plugin.ts'
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
  /**
   * Register the pet to auto-start at Windows login (default false). The
   * tray menu can toggle this at runtime; the toggle updates the OS login
   * item (registry) immediately and persists.
   */
  autoStart?: boolean | undefined
}

/** Options schema for the `window` plugin. */
export const windowConfig: Schema<WindowPluginOptions> = object({
  width: number(260),
  height: number(300),
  expandedWidth: number(340),
  // 610 = collapsed 300 + chat panel 300 + its 10px top margin, so the
  // top-pinned pet keeps the same 10px gap to the panel in both states.
  expandedHeight: number(610),
  alwaysOnTop: boolean(true),
  skipTaskbar: boolean(true),
  title: string(''),
  icon: string(),
  tray: boolean(true),
  trayIcon: string(),
  hotkey: string('CommandOrControl+Shift+P'),
  autoStart: boolean(false),
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

/** Validate the renderer-supplied image list into `PetImageInput[]`, or undefined when absent/empty. */
function parseImageInputs(value: unknown): import('../types.ts').PetImageInput[] | undefined {
  if (value === undefined || value === null || !Array.isArray(value)) return undefined
  const result: import('../types.ts').PetImageInput[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const dataUrl = (entry as { dataUrl?: unknown }).dataUrl
    if (typeof dataUrl === 'string' && dataUrl !== '') result.push({ dataUrl })
  }
  return result.length > 0 ? result : undefined
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
    // A second launch (shortcut / hotkey / `start-pet.bat`) summons the
    // running pet instead of stacking another instance: the second process
    // fails the single-instance lock and quits, and this event fires here.
    app.on('second-instance', summon)
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
    const handlePrompt = (_event: unknown, text: unknown, images: unknown): Promise<import('../types.ts').PetReply> => {
      if (typeof text !== 'string') return Promise.reject(new Error('desktop-pet:prompt expects the prompt text as a string'))
      return pet.prompt(text, parseImageInputs(images))
    }
    ipcMain.handle('desktop-pet:prompt', handlePrompt)
    // Drag: the renderer sends ABSOLUTE target positions, so there is no
    // accumulated position to go stale when the OS clamps the window (e.g. a
    // screen edge while the tall chat panel is open) or when the resize on
    // expand/collapse nudges the window.
    //
    // Coalescing: the renderer already throttles to one message per frame,
    // but a burst can still arrive here faster than the OS can move the
    // window. Only the NEWEST target is kept and applied once per tick, so
    // the window jumps straight to the latest position instead of replaying
    // a backlog of stale moves (which is what made it trail the cursor and
    // "catch up" only when the drag ended).
    let pendingDrag: [number, number] | null = null
    let dragImmediate: ReturnType<typeof setImmediate> | null = null
    const onDragTo = (_event: unknown, x: unknown, y: unknown): void => {
      if (typeof x !== 'number' || typeof y !== 'number' || window.isDestroyed()) return
      pendingDrag = [Math.round(x), Math.round(y)]
      if (dragImmediate !== null) return
      dragImmediate = setImmediate(() => {
        dragImmediate = null
        const target = pendingDrag
        pendingDrag = null
        if (target !== null && !window.isDestroyed()) window.setPosition(target[0], target[1])
      })
    }
    ipcMain.on('desktop-pet:drag-to', onDragTo)
    // Absolute reposition, used by the renderer to re-anchor the pet after
    // the expand/collapse resize (the pet must stay put on screen).
    const onMoveTo = (_event: unknown, x: unknown, y: unknown): void => {
      if (typeof x !== 'number' || typeof y !== 'number' || window.isDestroyed()) return
      window.setPosition(Math.round(x), Math.round(y))
    }
    ipcMain.on('desktop-pet:move-to', onMoveTo)
    ipcMain.handle('desktop-pet:set-expanded', (_event: unknown, expanded: unknown) => {
      if (typeof expanded !== 'boolean' || window.isDestroyed()) return
      // Grow/shrink the window around its horizontal CENTER: the pet is
      // centered in the window, so keeping the center fixed means the pet
      // never slides left or right while the chat panel opens/closes. The
      // vertical edge is left alone — the renderer top-pins the pet, so
      // growing downward (or shrinking upward) does not move it either.
      // setBounds with an explicit x/y still keeps the window where it should
      // be instead of letting a bare setSize nudge it.
      const bounds = window.getBounds()
      const nextWidth = expanded ? (options.expandedWidth ?? 340) : (options.width ?? 260)
      const nextHeight = expanded ? (options.expandedHeight ?? 620) : (options.height ?? 300)
      window.setBounds({
        x: Math.round(bounds.x + (bounds.width - nextWidth) / 2),
        y: bounds.y,
        width: nextWidth,
        height: nextHeight,
      })
    })
    ipcMain.handle('desktop-pet:approval-respond', (_event: unknown, requestId: unknown, outcome: unknown) => {
      if (typeof requestId !== 'string' || (outcome !== 'allowed-once' && outcome !== 'rejected')) return
      ctx.emit(EVENTS.approvalRespond, { requestId, outcome })
    })
    ipcMain.handle('desktop-pet:get-name', () => identityName)
    ipcMain.handle('desktop-pet:quit', () => {
      app.quit()
    })

    // --- Todo panel IPC (only when the `todo` plugin is active). The panel
    // reads the list on demand and stays in sync via `todo:changed` pushes,
    // so chat commands ("记个待办：X") and the panel always agree.
    const todo = ctx.get<PetTodoService>(SERVICES.todo)
    const disposeTodoListen = todo?.listen((items) => {
      if (!window.isDestroyed()) window.webContents.send('desktop-pet:todo-updated', items)
    })
    if (todo !== undefined) {
      ipcMain.handle('desktop-pet:todo-list', () => todo.list())
      ipcMain.handle('desktop-pet:todo-add', (_event, text: unknown) => {
        if (typeof text !== 'string') return Promise.reject(new Error('desktop-pet:todo-add expects the todo text as a string'))
        return todo.add(text)
      })
      ipcMain.handle('desktop-pet:todo-toggle', (_event, id: unknown) => {
        if (typeof id !== 'string') return Promise.reject(new Error('desktop-pet:todo-toggle expects a todo id'))
        return todo.toggle(id)
      })
      ipcMain.handle('desktop-pet:todo-remove', (_event, id: unknown) => {
        if (typeof id !== 'string') return Promise.reject(new Error('desktop-pet:todo-remove expects a todo id'))
        return todo.remove(id)
      })
    }

    await window.loadFile(resolveAsset('renderer/index.html'))

    // --- System tray + global shortcut: summon the pet from anywhere.
    const { Tray, Menu, globalShortcut, nativeImage } = await import('electron')

    // --- Auto-start at Windows login. The OS login item (registry) is the
    // source of truth at runtime; the `autoStart` config option only ever
    // *ensures* it is on (idempotent), and the tray checkbox can toggle it
    // off (which persists). Registry Run entries start the pet with an
    // arbitrary working directory, so the window entry re-locates the config
    // next to itself and relative paths resolve against the config file.
    const windowEntryPath = fileURLToPath(new URL('../../lib/entries/window.js', import.meta.url))
    const loginItemAvailable = existsSync(windowEntryPath)
    let tray: import('electron').Tray | undefined
    const refreshMenu = (): void => {
      const current = tray
      if (current === undefined) return
      current.setContextMenu(Menu.buildFromTemplate([
        { label: '显示桌宠', click: summon },
        { type: 'separator' },
        ...(loginItemAvailable
          ? [{ label: '开机自启', type: 'checkbox' as const, checked: autoStart, click: () => applyLoginItem(!autoStart) }]
          : []),
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]))
    }
    let autoStart = false
    const applyLoginItem = (value: boolean): void => {
      if (!loginItemAvailable) return
      autoStart = value
      app.setLoginItemSettings({ openAtLogin: value, path: process.execPath, args: [windowEntryPath] })
      refreshMenu()
    }
    try {
      // Electron 39: for unpackaged apps the flat `openAtLogin` is unreliable;
      // `executableWillLaunchAtLogin` reflects the actual Run-entry state.
      autoStart = app.getLoginItemSettings().executableWillLaunchAtLogin === true
    } catch (error) {
      ctx.logger.warn('could not read the login item setting: %s', error instanceof Error ? error.message : String(error))
    }
    if (options.autoStart === true && !autoStart) {
      if (!loginItemAvailable) {
        ctx.logger.warn('auto-start requested but the window entry is not built at %s (run `npm run build`)', windowEntryPath)
      } else {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: [windowEntryPath] })
        autoStart = true
      }
    }
    if (options.tray !== false) {
      const trayIconPath = options.trayIcon !== undefined && options.trayIcon !== ''
        ? (existsSync(fileURLToPath(new URL(`../../${options.trayIcon}`, import.meta.url))) ? fileURLToPath(new URL(`../../${options.trayIcon}`, import.meta.url)) : undefined)
        : undefined
      const icon = trayIconPath !== undefined ? nativeImage.createFromPath(trayIconPath) : nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
      tray = new Tray(icon)
      tray.setToolTip(`${identityName} — 单击唤起，右键菜单`)
      tray.on('click', summon)
      refreshMenu()
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
      disposeTodoListen?.()
      app.removeListener('second-instance', summon)
      tray?.destroy()
      if (hotkey !== '') globalShortcut.unregister(hotkey)
      if (dragImmediate !== null) clearImmediate(dragImmediate)
      ipcMain.removeHandler('desktop-pet:prompt')
      ipcMain.removeHandler('desktop-pet:set-expanded')
      ipcMain.removeListener('desktop-pet:drag-to', onDragTo)
      ipcMain.removeListener('desktop-pet:move-to', onMoveTo)
      ipcMain.removeHandler('desktop-pet:approval-respond')
      ipcMain.removeHandler('desktop-pet:get-name')
      ipcMain.removeHandler('desktop-pet:quit')
      if (todo !== undefined) {
        ipcMain.removeHandler('desktop-pet:todo-list')
        ipcMain.removeHandler('desktop-pet:todo-add')
        ipcMain.removeHandler('desktop-pet:todo-toggle')
        ipcMain.removeHandler('desktop-pet:todo-remove')
      }
      app.removeListener('will-quit', onWillQuit)
      if (!window.isDestroyed()) window.destroy()
    }
  },
})
