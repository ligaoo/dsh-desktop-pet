/**
 * Configuration loading for the pet: defaults, a JSON/JS config file, and
 * `DSH_PET_*` environment overrides, merged in that order of precedence
 * (file beats defaults, environment beats file).
 *
 * Config file shape (see `desktop-pet.config.example.json`):
 *
 * ```jsonc
 * {
 *   // global defaults every plugin row can inherit
 *   "defaults": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
 *   // plugin rows: key = built-in plugin name or a module path
 *   "plugins": {
 *     "runtime": { "command": "dsh-jsonrpc-agent" },
 *     "window": false,                       // false disables a plugin
 *     "./plugins/my-plugin.mjs": { "opt": 1 }
 *   }
 * }
 * ```
 *
 * @module desktop-pet/config
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One plugin row: `false` disables, an object is the options, `true` means empty options. */
export type PluginRow = boolean | Record<string, unknown>

/** The fully merged pet configuration. */
export interface PetConfig {
  /** Global option defaults merged into every plugin row. */
  defaults: Record<string, unknown>
  /** Plugin rows keyed by plugin name or module path. */
  plugins: Record<string, PluginRow>
  /** Extra directories to auto-discover external plugins in. */
  pluginDirs: string[]
  /** Extra option knobs surfaced by the CLI (`verbose`, `headless`, ...). */
  cli: Record<string, unknown>
}

/** Raw file content before defaults are applied. */
export interface PetConfigFile {
  /** The pet's name; merged into the `identity` plugin row (default `桌宠`). */
  name?: string
  defaults?: Record<string, unknown>
  plugins?: Record<string, PluginRow>
  pluginDirs?: string[]
  [key: string]: unknown
}

/** Built-in plugin names with their stock options (used when the config omits them). */
export const BUILTIN_DEFAULTS: Record<string, Record<string, unknown>> = {
  runtime: {},
  state: {},
  bridge: {},
  window: {},
  notifier: {},
  identity: {},
}

const ENV_PREFIX = 'DSH_PET_'

/** True when running inside an Electron main process. */
export function isElectron(): boolean {
  return typeof process.versions.electron === 'string'
}

/** Deep-merge plain objects (later sources win, recursively). */
function merge(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const source of sources) {
    if (source === undefined) continue
    for (const [key, value] of Object.entries(source)) {
      const current = out[key]
      if (isPlainRecord(value) && isPlainRecord(current)) {
        out[key] = merge(current, value)
      } else {
        out[key] = value
      }
    }
  }
  return out
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a config file: `.json` is parsed; `.js`/`.mjs`/`.cjs` are imported
 * (default export or the export itself must be the config object).
 * @param path - absolute or relative config file path.
 * @returns the raw config object.
 */
export async function loadConfigFile(path: string): Promise<PetConfigFile> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path)
  if (!existsSync(absolute)) throw new Error(`config file not found: ${absolute}`)
  if (/\.json$/i.test(absolute)) {
    const text = await readFile(absolute, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (!isPlainRecord(parsed)) throw new Error(`config file must export a plain object: ${absolute}`)
    return parsed as PetConfigFile
  }
  if (/\.(mjs|js|cjs)$/i.test(absolute)) {
    const mod = await import(pathToFileURL(absolute).href)
    const exported = (mod as { default?: unknown }).default ?? mod
    if (!isPlainRecord(exported)) throw new Error(`config module must export a plain object: ${absolute}`)
    return exported as PetConfigFile
  }
  throw new Error(`unsupported config file extension (use .json, .js, .mjs, or .cjs): ${absolute}`)
}

/**
 * Locate the default config file: `--config` wins, then `DSH_PET_CONFIG`,
 * then `./desktop-pet.config.json` in the working directory.
 * @param explicit - the `--config` value, if any.
 * @param env - environment to read `DSH_PET_CONFIG` from (default `process.env`).
 * @returns the config file path, or undefined when none exists.
 */
export function findConfigPath(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate = explicit ?? env.DSH_PET_CONFIG
  if (candidate !== undefined) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate)
    if (!existsSync(absolute)) throw new Error(`config file not found: ${absolute}`)
    return absolute
  }
  const defaultPath = resolve(process.cwd(), 'desktop-pet.config.json')
  return existsSync(defaultPath) ? defaultPath : undefined
}

/**
 * Merge `DSH_PET_*` environment variables into the `runtime` plugin row so
 * the standalone shell keeps the original extension's env contract
 * (`DSH_PET_RUNTIME`, `DSH_PET_RUNTIME_ARGS`, `DSH_PET_CWD`,
 * `DSH_PET_PROVIDER`, `DSH_PET_MODEL`). Explicit config-file values win;
 * the environment only fills fields the config left unset. Unknown
 * `DSH_PET_*` variables surface as `cli.<name>` keys.
 * @param config - the config to apply the environment onto (mutated copy).
 * @param env - environment (default `process.env`).
 * @returns a new config with the runtime row merged.
 */
export function applyEnvOverrides(config: PetConfig, env: NodeJS.ProcessEnv = process.env): PetConfig {
  const runtime: Record<string, unknown> = {}
  const direct: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue
    const name = key.slice(ENV_PREFIX.length)
    switch (name) {
      case 'RUNTIME': runtime['command'] = value; break
      case 'RUNTIME_ARGS': runtime['args'] = JSON.parse(value); break
      case 'CWD': runtime['cwd'] = value; break
      case 'PROVIDER': runtime['provider'] = value; break
      case 'MODEL': runtime['model'] = value; break
      default: direct.push([name.toLowerCase(), value])
    }
  }
  const plugins = { ...config.plugins }
  const row = plugins['runtime']
  if (Object.keys(runtime).length > 0 && row !== false) {
    // Config-file row wins; the environment fills only unset fields.
    plugins['runtime'] = merge(runtime, isPlainRecord(row) ? row : {})
  }
  const cli = { ...config.cli }
  for (const [key, value] of direct) {
    if (cli[key] === undefined) cli[key] = value
  }
  return { ...config, plugins, cli }
}

/**
 * Build the effective {@link PetConfig}: defaults, then the config file, then
 * environment overrides, then explicit CLI values.
 * @param file - parsed config file (optional).
 * @param cli - CLI-level overrides (optional).
 * @param env - environment (default `process.env`).
 * @returns the merged configuration.
 */
export function buildConfig(file?: PetConfigFile, cli: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): PetConfig {
  const defaults = merge({}, file?.defaults)
  const plugins: Record<string, PluginRow> = {}
  for (const [name, stock] of Object.entries(BUILTIN_DEFAULTS)) {
    const row = file?.plugins?.[name]
    plugins[name] = row === undefined ? (isElectron() || (name !== 'window' && name !== 'notifier') ? { ...stock } : false) : row
  }
  // Top-level `name` feeds the identity plugin row (an explicit identity row wins).
  if (typeof file?.name === 'string' && file.name !== '') {
    const row = plugins['identity']
    if (row !== false) {
      const base = row === true || row === undefined ? {} : isPlainRecord(row) ? row : {}
      if (base.name === undefined) plugins['identity'] = { ...base, name: file.name }
    }
  }
  if (file?.plugins !== undefined) {
    for (const [name, row] of Object.entries(file.plugins)) {
      if (name in BUILTIN_DEFAULTS) continue
      plugins[name] = row
    }
  }
  const pluginDirs = [...(file?.pluginDirs ?? [])]
  const config: PetConfig = { defaults, plugins, pluginDirs, cli: { ...cli } }
  const withEnv = applyEnvOverrides(config, env)
  // CLI wins over everything.
  return {
    ...withEnv,
    cli: merge(withEnv.cli, cli),
  }
}

/**
 * Resolve the effective options for one plugin row: the plugin's stock
 * defaults, the global defaults, then the row's own options.
 * @param config - the merged configuration.
 * @param name - plugin name.
 * @returns the effective options object, or `null` when the row is disabled.
 */
export function resolvePluginRow(config: PetConfig, name: string): Record<string, unknown> | null {
  const row = config.plugins[name]
  if (row === false) return null
  if (row === true || row === undefined) {
    const base = { ...BUILTIN_DEFAULTS[name] }
    return merge(base, config.defaults)
  }
  if (isPlainRecord(row)) return merge({ ...BUILTIN_DEFAULTS[name] }, config.defaults, row)
  return null
}

/** Absolute path of a config-file-relative plugin path. */
export function resolvePluginPath(base: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(base), target)
}
