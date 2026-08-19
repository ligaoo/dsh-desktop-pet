/**
 * Preload bridge for the desktop pet renderer: exposes the minimal
 * `window.desktopPet` API over context-isolated IPC. Unsandboxed ESM preload
 * (`.mjs`), loaded by the pet's `window` plugin.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopPet', {
  prompt: (text) => ipcRenderer.invoke('desktop-pet:prompt', text),
  setExpanded: (expanded) => ipcRenderer.invoke('desktop-pet:set-expanded', expanded),
  dragBy: (dx, dy) => ipcRenderer.invoke('desktop-pet:drag-by', dx, dy),
  quit: () => ipcRenderer.invoke('desktop-pet:quit'),
  onSnapshot: (listener) => {
    const wrapped = (_event, snapshot) => listener(snapshot)
    ipcRenderer.on('desktop-pet:snapshot', wrapped)
    return () => {
      ipcRenderer.removeListener('desktop-pet:snapshot', wrapped)
    }
  },
  onExpand: (listener) => {
    const wrapped = () => listener()
    ipcRenderer.on('desktop-pet:expand', wrapped)
    return () => {
      ipcRenderer.removeListener('desktop-pet:expand', wrapped)
    }
  },
  onApproval: (listener) => {
    const wrapped = (_event, payload) => listener(payload)
    ipcRenderer.on('desktop-pet:approval', wrapped)
    return () => {
      ipcRenderer.removeListener('desktop-pet:approval', wrapped)
    }
  },
  respondApproval: (requestId, outcome) => ipcRenderer.invoke('desktop-pet:approval-respond', requestId, outcome),
  getName: () => ipcRenderer.invoke('desktop-pet:get-name'),
})
