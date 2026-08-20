/**
 * The pet application bootstrap: wires the merged configuration, the built-in
 * plugin registry, external plugin discovery, and the host into one running
 * pet. Shared by the CLI, the Electron main entry, and the harness-host mount.
 *
 * @module desktop-pet/app
 */

import type { PetConfig } from './core/config.ts'
import { BUILTIN_DEFAULTS, buildConfig, findConfigPath, loadConfigFile } from './core/config.ts'
import { PetHost } from './core/host.ts'
import { resolvePlugins } from './core/loader.ts'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { PetPlugin } from './core/plugin.ts'
import { bridgePlugin } from './plugins/bridge.ts'
import { identityPlugin } from './plugins/identity.ts'
import { memoryPlugin } from './plugins/memory.ts'
import { notifierPlugin } from './plugins/notifier.ts'
import { runtimePlugin } from './plugins/runtime.ts'
import { statePlugin } from './plugins/state.ts'
import { todoPlugin } from './plugins/todo.ts'
import { windowPlugin } from './plugins/window.ts'

/** The built-in plugin registry (a factory map so rows stay fresh per start). */
export const BUILTIN_PLUGINS: Record<string, () => PetPlugin> = {
  identity: () => identityPlugin,
  memory: () => memoryPlugin,
  todo: () => todoPlugin,
  runtime: () => runtimePlugin,
  state: () => statePlugin,
  bridge: () => bridgePlugin,
  window: () => windowPlugin,
  notifier: () => notifierPlugin,
}

/** Options for {@link startPet}. */
export interface StartPetOptions {
  /** Path to a config file to load (default: `DSH_PET_CONFIG` or `./desktop-pet.config.json`). */
  configPath?: string | undefined
  /** CLI-level overrides merged last. */
  cli?: Record<string, unknown>
  /** Extra external-plugin directories (`--plugin-dir`). */
  pluginDirs?: string[]
  /** Pre-parsed config; skips file loading when provided. */
  config?: PetConfig
  /** Host tuning (fatal plugins, version). */
  host?: ConstructorParameters<typeof PetHost>[0]
  /** Replace the built-in registry (testing). */
  builtins?: Record<string, () => PetPlugin>
}

/** The started pet: the host plus the loaded config file path. */
export interface StartedPet {
  host: PetHost
  config: PetConfig
  configFilePath: string | undefined
}

/** True when the value is a plain object (not null, not an array). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Anchor the config's relative path options to the config file's directory.
 * The pet may be auto-started at Windows login with an arbitrary working
 * directory (registry Run entries carry no cwd), so `data/`, the runtime
 * session cwd and the notify-port file must resolve next to the config file
 * instead of `process.cwd()`. Explicit absolute paths are left untouched.
 * @param config - the merged configuration (rows as merged by buildConfig).
 * @param configFilePath - the loaded config file path, if any.
 * @returns a config whose path options are absolute.
 */
function anchorRelativePaths(config: PetConfig, configFilePath: string | undefined): PetConfig {
  if (configFilePath === undefined) return config
  const base = dirname(resolve(configFilePath))
  const plugins = { ...config.plugins }
  const toAbsolute = (value: string | undefined, fallback: string): string => {
    const raw = value ?? fallback
    return isAbsolute(raw) ? raw : resolve(base, raw)
  }
  const anchor = (name: string, key: string, fallback: string): void => {
    if (!(name in BUILTIN_DEFAULTS)) return
    const row = plugins[name]
    if (row === false) return
    const record = row === true || row === undefined ? {} : isPlainRecord(row) ? row : {}
    const value = typeof record[key] === 'string' ? (record[key] as string) : undefined
    plugins[name] = { ...record, [key]: toAbsolute(value, fallback) }
  }
  anchor('memory', 'dir', 'data')
  anchor('todo', 'dir', 'data')
  anchor('notifier', 'notifyPortFile', '.desktop-pet-notify-port')
  const runtime = plugins['runtime']
  if (runtime !== false) {
    const record = runtime === true || runtime === undefined ? {} : isPlainRecord(runtime) ? runtime : {}
    const raw = typeof record.cwd === 'string' ? (record.cwd as string) : undefined
    plugins['runtime'] = { ...record, cwd: raw === undefined ? base : (isAbsolute(raw) ? raw : resolve(base, raw)) }
  }
  return { ...config, plugins }
}

/**
 * Load the configuration, build the host, register every enabled plugin
 * (built-ins plus discovered externals), and start them in dependency order.
 * @param options - start options.
 * @returns the running host and its configuration.
 */
export async function startPet(options: StartPetOptions = {}): Promise<StartedPet> {
  let config: PetConfig
  let configFilePath: string | undefined
  if (options.config !== undefined) {
    config = options.config
    configFilePath = options.configPath
  } else {
    configFilePath = findConfigPath(options.configPath)
    const file = configFilePath === undefined ? undefined : await loadConfigFile(configFilePath)
    config = buildConfig(file, options.cli)
  }
  config = anchorRelativePaths(config, configFilePath)
  const host = new PetHost(options.host)
  const rows = await resolvePlugins(config, options.builtins ?? BUILTIN_PLUGINS, configFilePath, options.pluginDirs)
  for (const row of rows) host.use(row.plugin, row.options)
  await host.start()
  return { host, config, configFilePath }
}
