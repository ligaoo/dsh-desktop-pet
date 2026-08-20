/**
 * Desktop pet for DeepSeek Harness, standalone edition: an Electron shell
 * that floats a transparent always-on-top pet window and drives one agent
 * session through the vendored TypeScript SDK client. Everything is a plugin
 * — the runtime, the snapshot state, the chat bridge, the window, and any
 * external extension are plain {@link PetPlugin}s mounted by {@link PetHost}.
 *
 * Public API:
 * - {@link PetHost} / {@link PetPlugin} / {@link definePlugin} — the plugin system.
 * - `runtimePlugin`, `statePlugin`, `bridgePlugin`, `windowPlugin` — built-ins.
 * - {@link DesktopPetBridge}, {@link reducePetNotification},
 *   {@link resolvePetLaunch} — the Electron-free core (testable without a display).
 * - {@link startPet} — one-call bootstrap shared by CLI / Electron / harness host.
 *
 * @module desktop-pet
 */

// Core
export { PetHost } from './core/host.ts'
export type { PetHostOptions } from './core/host.ts'
export { definePlugin } from './core/plugin.ts'
export type { Disposer, PetLogger, PetPlugin, PluginContext, PetService, PetStateService, ServiceKey, EventKey, EventHandler } from './core/plugin.ts'
export { EVENTS, SERVICES } from './core/plugin.ts'
export { SchemaValidationError, array, boolean, number, object, optional, record, string, union } from './core/schema.ts'
export type { Schema } from './core/schema.ts'
export { DesktopPetBridge } from './core/bridge.ts'
export type { DesktopPetBridgeOptions } from './core/bridge.ts'
export { resolvePetLaunch } from './core/launch.ts'
export type { PetLaunchSpec, PetRoute } from './core/launch.ts'
export { INITIAL_SNAPSHOT, reducePetNotification } from './core/state.ts'
export { buildConfig, loadConfigFile, findConfigPath, applyEnvOverrides, resolvePluginRow, isElectron } from './core/config.ts'
export type { PetConfig, PetConfigFile, PluginRow } from './core/config.ts'
export { discoverExternalPlugins, importExternalPlugin, resolvePlugins } from './core/loader.ts'
export { readHarnessApiKey, resolveDshHome, resolveHarnessApiKey } from './core/credentials.ts'

// Plugins
export { runtimePlugin, runtimeConfig, resolveRuntimeOptions, buildRuntimeEnv } from './plugins/runtime.ts'
export type { RuntimePluginOptions } from './plugins/runtime.ts'
export { statePlugin } from './plugins/state.ts'
export { bridgePlugin, bridgeConfig } from './plugins/bridge.ts'
export type { BridgePluginOptions } from './plugins/bridge.ts'
export { windowPlugin, windowConfig } from './plugins/window.ts'
export type { WindowPluginOptions } from './plugins/window.ts'
export { notifierPlugin, notifierConfig } from './plugins/notifier.ts'
export type { NotifierPluginOptions } from './plugins/notifier.ts'
export { identityPlugin, identityConfig } from './plugins/identity.ts'
export type { IdentityPluginOptions } from './plugins/identity.ts'
export type { PetIdentityService } from './core/plugin.ts'
export { memoryPlugin, memoryConfig, DEFAULT_PERSONA } from './plugins/memory.ts'
export type { MemoryPluginOptions } from './plugins/memory.ts'
export type { PetMemoryService } from './core/plugin.ts'
export { todoPlugin, todoConfig } from './plugins/todo.ts'
export type { TodoPluginOptions } from './plugins/todo.ts'
export type { PetTodoService, TodoItem } from './core/plugin.ts'

// App bootstrap + entries
export { startPet, BUILTIN_PLUGINS } from './app.ts'
export type { StartPetOptions, StartedPet } from './app.ts'
export { main as cliMain } from './entries/cli.ts'
export { main as windowMain } from './entries/window.ts'
export {
  apply as harnessHostApply,
  Config as harnessHostConfig,
  name as harnessHostName,
  buildJumpUrl,
  findPendingApprovalId,
  assistantTextOf,
  sessionEventNotify,
  resolveChildSpec,
} from './entries/harness-host.ts'
export type { HarnessHostConfig, HarnessHostChildSpec, LogEventLike } from './entries/harness-host.ts'
export type { ApprovalRequestPayload, ApprovalDecision } from './plugins/notifier.ts'

// Shared types + SDK access
export type { PetHarness, PetHarnessSession, PetMood, PetSnapshot } from './types.ts'
export { version } from './version.ts'
export * from './sdk.ts'
