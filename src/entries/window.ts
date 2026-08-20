/**
 * Electron main-process entry for the desktop pet. Launch it with
 * `electron lib/entries/window.js` (or `npm start`). It is a thin bootstrap:
 * the actual window lives in the `window` plugin; this entry only starts the
 * host under Electron so the default config enables the window plugin.
 *
 * @module desktop-pet/startup
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startPet } from '../app.ts'

/** Package root (two hops up from `src/entries` / `lib/entries`). */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Boot the pet window host. @returns the started host (never resolves). */
export async function main(): Promise<void> {
  // Auto-start launches the pet with an arbitrary working directory (a
  // registry Run entry carries no cwd), so the config file is looked up next
  // to this entry when `DSH_PET_CONFIG` is unset.
  const defaultConfig = join(PACKAGE_ROOT, 'desktop-pet.config.json')
  const configPath = process.env.DSH_PET_CONFIG ?? (existsSync(defaultConfig) ? defaultConfig : undefined)
  await startPet({ configPath, host: { fatalPlugins: ['window'] } })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
