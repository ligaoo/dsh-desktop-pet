/**
 * The pet application bootstrap: wires the merged configuration, the built-in
 * plugin registry, external plugin discovery, and the host into one running
 * pet. Shared by the CLI, the Electron main entry, and the harness-host mount.
 *
 * @module desktop-pet/app
 */

import type { PetConfig } from './core/config.ts'
import { buildConfig, findConfigPath, loadConfigFile } from './core/config.ts'
import { PetHost } from './core/host.ts'
import { resolvePlugins } from './core/loader.ts'
import type { PetPlugin } from './core/plugin.ts'
import { bridgePlugin } from './plugins/bridge.ts'
import { identityPlugin } from './plugins/identity.ts'
import { memoryPlugin } from './plugins/memory.ts'
import { notifierPlugin } from './plugins/notifier.ts'
import { runtimePlugin } from './plugins/runtime.ts'
import { statePlugin } from './plugins/state.ts'
import { windowPlugin } from './plugins/window.ts'

/** The built-in plugin registry (a factory map so rows stay fresh per start). */
export const BUILTIN_PLUGINS: Record<string, () => PetPlugin> = {
  identity: () => identityPlugin,
  memory: () => memoryPlugin,
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
  const host = new PetHost(options.host)
  const rows = await resolvePlugins(config, options.builtins ?? BUILTIN_PLUGINS, configFilePath, options.pluginDirs)
  for (const row of rows) host.use(row.plugin, row.options)
  await host.start()
  return { host, config, configFilePath }
}
