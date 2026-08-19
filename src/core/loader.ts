/**
 * Plugin loading: the built-in registry plus external plugin discovery.
 *
 * External plugins are plain modules exporting a {@link PetPlugin} (or an
 * array of them) as the default export. They are discovered in (in order):
 *   1. every directory named in `config.pluginDirs` (files `*.mjs`, `*.js`),
 *   2. explicit module paths in the config's `plugins` map,
 *   3. `--plugin-dir` CLI directories.
 *
 * @module desktop-pet/loader
 */

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PetConfig, PluginRow } from './config.ts'
import { BUILTIN_DEFAULTS } from './config.ts'
import type { PetPlugin } from './plugin.ts'

/** Config keys that name built-in plugins (never treated as external rows). */
const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_DEFAULTS))

/** Built-in plugins, keyed by name. */
export type BuiltinRegistry = Record<string, () => PetPlugin>

/** One resolved external plugin row: the module path and its config row. */
export interface ExternalPluginEntry {
  /** Config key: the module path as written (relative to the config file). */
  key: string
  /** Absolute module path. */
  path: string
  /** The config row (`false` disables). */
  row: PluginRow
}

/**
 * Discover external plugin module paths from the config and CLI.
 * @param config - the merged configuration.
 * @param configFilePath - the config file's absolute path (for relative rows).
 * @param extraDirs - additional plugin directories (CLI `--plugin-dir`).
 * @returns the ordered external entries; `false` rows are included so callers can skip them.
 */
export async function discoverExternalPlugins(
  config: PetConfig,
  configFilePath: string | undefined,
  extraDirs: string[] = [],
): Promise<ExternalPluginEntry[]> {
  const entries: ExternalPluginEntry[] = []
  const seen = new Set<string>()
  const push = (key: string, path: string, row: PluginRow): void => {
    const absolute = resolve(path)
    if (seen.has(absolute)) return
    seen.add(absolute)
    entries.push({ key, path: absolute, row })
  }
  const configDir = configFilePath === undefined ? process.cwd() : dirname(resolve(configFilePath))
  const dirs = [...config.pluginDirs, ...extraDirs]
  for (const dir of dirs) {
    const absolute = isAbsolute(dir) ? dir : resolve(configDir, dir)
    if (!existsSync(absolute)) continue
    const names = await readdir(absolute, { withFileTypes: true })
    for (const entry of names) {
      if (!entry.isFile() || !/\.(mjs|js)$/i.test(entry.name)) continue
      push(entry.name, resolve(absolute, entry.name), {})
    }
  }
  for (const [key, row] of Object.entries(config.plugins)) {
    if (BUILTIN_NAMES.has(key)) continue
    push(key, resolve(configDir, key), row)
  }
  return entries
}

/**
 * Import one external plugin module. The module may default-export a single
 * {@link PetPlugin} or an array of them.
 * @param path - absolute module path.
 * @returns the exported plugins.
 */
export async function importExternalPlugin(path: string): Promise<PetPlugin[]> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
  const exported = mod.default ?? mod
  const plugins = Array.isArray(exported) ? exported : [exported]
  const result: PetPlugin[] = []
  for (const candidate of plugins) {
    if (candidate === null || typeof candidate !== 'object' || typeof (candidate as PetPlugin).name !== 'string') {
      throw new Error(`external plugin module "${path}" must export a PetPlugin or an array of them`)
    }
    result.push(candidate as PetPlugin)
  }
  return result
}

/**
 * Build the full plugin list (built-ins plus external) respecting enablement.
 * @param config - merged configuration.
 * @param builtins - the built-in registry.
 * @param configFilePath - absolute config file path (for relative external rows).
 * @param extraDirs - CLI plugin directories.
 * @returns ordered list of `{ plugin, options, key }` rows ready for `host.use`.
 */
export async function resolvePlugins(
  config: PetConfig,
  builtins: BuiltinRegistry,
  configFilePath: string | undefined,
  extraDirs: string[] = [],
): Promise<Array<{ key: string; plugin: PetPlugin; options: Record<string, unknown> }>> {
  const rows: Array<{ key: string; plugin: PetPlugin; options: Record<string, unknown> }> = []
  for (const [name, factory] of Object.entries(builtins)) {
    const row = config.plugins[name]
    if (row === false) continue
    const options = row === true || row === undefined ? {} : (row as Record<string, unknown>)
    rows.push({ key: name, plugin: factory(), options })
  }
  for (const entry of await discoverExternalPlugins(config, configFilePath, extraDirs)) {
    if (entry.row === false) continue
    const plugins = await importExternalPlugin(entry.path)
    const options = entry.row === true || entry.row === undefined ? {} : (entry.row as Record<string, unknown>)
    for (const plugin of plugins) rows.push({ key: plugin.name, plugin, options })
  }
  return rows
}
