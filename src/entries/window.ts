/**
 * Electron main-process entry for the desktop pet. Launch it with
 * `electron lib/entries/window.js` (or `npm start`). It is a thin bootstrap:
 * the actual window lives in the `window` plugin; this entry only starts the
 * host under Electron so the default config enables the window plugin.
 *
 * @module desktop-pet/startup
 */

import { pathToFileURL } from 'node:url'
import { startPet } from '../app.ts'

/** Boot the pet window host. @returns the started host (never resolves). */
export async function main(): Promise<void> {
  await startPet({ host: { fatalPlugins: ['window'] } })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
