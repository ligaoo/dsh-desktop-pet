/**
 * Command-line entry for the desktop pet. Run via the `desktop-pet` / `pet`
 * bins (or `tsx src/entries/cli.ts` in development).
 *
 * @module desktop-pet/cli
 */

import { pathToFileURL } from 'node:url'
import { BUILTIN_PLUGINS, startPet } from '../app.ts'
import type { PetConfig } from '../core/config.ts'
import { buildConfig, findConfigPath, isElectron, loadConfigFile } from '../core/config.ts'
import { discoverExternalPlugins } from '../core/loader.ts'
import { EVENTS, SERVICES } from '../core/plugin.ts'
import { version as VERSION } from '../version.ts'

interface CliArgs {
  config: string | undefined
  pluginDirs: string[]
  headless: boolean
  window: boolean
  listPlugins: boolean
  prompt: string | undefined
  json: boolean
  verbose: boolean
  help: boolean
  version: boolean
}

const HELP = `DeepSeek Harness desktop pet — everything is a plugin.

Usage:
  desktop-pet [options]

Options:
  --config <path>        Config file (.json/.js/.mjs/.cjs); default DSH_PET_CONFIG
                         or ./desktop-pet.config.json
  --plugin-dir <dir>     Extra directory to auto-discover external plugins in
  --headless             Run without the Electron window (runtime+bridge+state)
  --window               Force the Electron window plugin (needs Electron)
  --prompt <text>        With --headless: send one prompt, print the reply, exit
  --json                 With --headless --prompt: emit JSON lines for snapshots
  --list-plugins         List built-in and discovered plugins, then exit
  --verbose              Verbose logging
  --version              Print the version and exit
  -h, --help             Show this help
`

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { config: undefined, pluginDirs: [], headless: false, window: false, listPlugins: false, prompt: undefined, json: false, verbose: false, help: false, version: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const take = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`missing value for ${arg}`)
      index++
      return next
    }
    switch (arg) {
      case '--config': args.config = take(); break
      case '--plugin-dir': args.pluginDirs.push(take()); break
      case '--headless': args.headless = true; break
      case '--window': args.window = true; break
      case '--list-plugins': args.listPlugins = true; break
      case '--prompt': args.prompt = take(); break
      case '--json': args.json = true; break
      case '--verbose': args.verbose = true; break
      case '--version': args.version = true; break
      case '-h': case '--help': args.help = true; break
      default: throw new Error(`unknown option: ${arg}`)
    }
  }
  return args
}

/** Build the effective config honoring CLI flags. */
async function loadConfig(args: CliArgs): Promise<{ config: PetConfig; configFilePath: string | undefined }> {
  const configFilePath = findConfigPath(args.config)
  const file = configFilePath === undefined ? undefined : await loadConfigFile(configFilePath)
  const cli: Record<string, unknown> = {}
  if (args.headless) cli['headless'] = true
  if (args.window) cli['window'] = true
  if (args.verbose) cli['verbose'] = true
  if (args.json) cli['json'] = true
  return { config: buildConfig(file, cli), configFilePath }
}

/** List every known plugin (built-ins + discovered externals) to stdout. */
async function listPlugins(config: PetConfig, configFilePath: string | undefined, extraDirs: string[]): Promise<void> {
  console.log(`desktop-pet v${VERSION} — plugins:`)
  for (const [, factory] of Object.entries(BUILTIN_PLUGINS)) {
    const plugin = factory()
    const enabled = config.plugins[plugin.name] !== false
    const requires = plugin.requires !== undefined && plugin.requires.length > 0 ? ` requires: ${plugin.requires.join(', ')}` : ''
    console.log(`  ${enabled ? '' : '[disabled] '}${plugin.name}${plugin.version !== undefined ? `@${plugin.version}` : ''} — ${plugin.description ?? 'no description'}${requires}`)
  }
  for (const entry of await discoverExternalPlugins(config, configFilePath, extraDirs)) {
    const enabled = config.plugins[entry.key] !== false
    console.log(`  ${enabled ? '' : '[disabled] '}${entry.key} (external module)`)
  }
}

/** Wait until SIGINT/SIGTERM, then return. */
function waitForSignal(): Promise<void> {
  return new Promise<void>((resolveSignal) => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolveSignal()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

/** Run one headless prompt through the started host and print the reply. */
async function runHeadlessPrompt(config: PetConfig, configFilePath: string | undefined, extraDirs: string[], prompt: string, json: boolean): Promise<void> {
  const started = await startPet({
    config,
    configPath: configFilePath,
    pluginDirs: extraDirs,
    host: { fatalPlugins: ['runtime', 'bridge'] },
  })
  const { host } = started
  const pet = host.get<import('../core/plugin.ts').PetService>(SERVICES.pet)
  if (pet === undefined) {
    await host.dispose()
    throw new Error('headless prompt needs the bridge plugin (is it enabled in the config?)')
  }
  const disposeLog = json
    ? host.on(EVENTS.snapshot, (snapshot) => console.log(JSON.stringify({ event: 'snapshot', snapshot })))
    : host.on(EVENTS.snapshot, (snapshot) => {
        const value = snapshot as { mood: string; speech: string | null; detail: string | null }
        if (value.mood !== 'idle') console.log(`[pet] ${value.mood}${value.detail !== null ? ` (${value.detail})` : ''}${value.speech !== null ? `: ${value.speech}` : ''}`)
      })
  try {
    const reply = await pet.prompt(prompt)
    const text = reply.response
    if (json) console.log(JSON.stringify({ event: 'reply', text, images: reply.images }))
    else console.log(text === '' ? '（这一轮没有文本回复）' : text)
  } finally {
    disposeLog()
    await host.dispose()
  }
}

/** Main CLI body; resolves to the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    console.error(HELP)
    return 2
  }
  if (args.help) {
    console.log(HELP)
    return 0
  }
  if (args.version) {
    console.log(`desktop-pet v${VERSION}`)
    return 0
  }
  if (args.prompt !== undefined && !args.headless) {
    console.error('--prompt requires --headless')
    return 2
  }
  const { config, configFilePath } = await loadConfig(args)
  if (args.listPlugins) {
    await listPlugins(config, configFilePath, args.pluginDirs)
    return 0
  }
  if (args.prompt !== undefined) {
    await runHeadlessPrompt(config, configFilePath, args.pluginDirs, args.prompt, args.json)
    return 0
  }
  const headless = args.headless || (!args.window && !isElectron())
  if (headless) {
    const started = await startPet({ config, configPath: configFilePath, pluginDirs: args.pluginDirs })
    console.log(`desktop-pet v${VERSION} started headless (plugins: ${started.host.startOrder.join(', ')}) — press Ctrl+C to stop`)
    await waitForSignal()
    await started.host.dispose()
    return 0
  }
  // Window mode: the window plugin binds app quit to host teardown.
  const started = await startPet({ config, configPath: configFilePath, pluginDirs: args.pluginDirs, host: { fatalPlugins: ['window'] } })
  if (!started.host.pluginNames.includes('window')) {
    console.error('window plugin did not start (running outside Electron? use --headless or launch with `npm start`)')
    await started.host.dispose()
    return 1
  }
  await waitForSignal()
  await started.host.dispose()
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
