/**
 * The plugin contract: "万物皆插件" (everything is a plugin). Every capability
 * of the pet — runtime ownership, snapshot state, the chat bridge, the
 * Electron window, and any user extension — is a {@link PetPlugin}. Plugins
 * declare their name, their dependency edges (`requires` / `optional`), an
 * optional options schema, and a `setup` that receives a {@link PluginContext}.
 *
 * A plugin is just an object literal; use {@link definePlugin} for the
 * inferred types and a friendlier error message when the shape is wrong.
 *
 * @module desktop-pet/plugin
 */

import type { Schema } from './schema.ts'

/** A teardown callback returned by {@link PetPlugin.setup}; run in reverse start order. */
export type Disposer = (() => void | Promise<void>) | void

/** A namespaced logger: plain console lines prefixed with the plugin name. */
export interface PetLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Service keys shared between plugins. Keys are open strings so external plugins extend freely. */
export type ServiceKey = string

/** Event names are open strings so external plugins extend the built-in map. */
export type EventKey = string

/** A handler for one host event; the payload is `unknown` for open keys. */
export type EventHandler = (payload: any) => void

/**
 * The handle a plugin receives during `setup`. It is the plugin's only window
 * into the host: emit/subscribe events, publish/consume services, and read
 * the merged configuration.
 */
export interface PluginContext<TConfig extends object = object> {
  /** This plugin's registered name. */
  readonly name: string
  /** The owning host (advanced use; most plugins only need the helpers below). */
  readonly host: PetHostLike
  /** The plugin's merged options after schema validation and defaulting. */
  readonly config: TConfig
  /** Subscribe to a host event; returns the subscription's disposer. */
  on(event: EventKey, handler: EventHandler): () => void
  /** Publish one host event to all current subscribers, in subscribe order. */
  emit(event: EventKey, payload?: unknown): void
  /** Read a service published by another plugin; `undefined` when absent. */
  get<T>(key: ServiceKey): T | undefined
  /** Read a service, throwing a descriptive error when absent. */
  getOrThrow<T>(key: ServiceKey): T
  /** Publish a service for other plugins (replaces any previous value). */
  provide<T>(key: ServiceKey, value: T): void
  /** Remove a previously published service; no-op when absent. */
  unprovide(key: ServiceKey): void
  /** A logger prefixed with this plugin's name. */
  logger: PetLogger
}

/** Structural view of the host that {@link PluginContext.host} exposes. */
export interface PetHostLike {
  readonly version: string
  /** Emit a host event (same as {@link PluginContext.emit}). */
  emit(event: EventKey, payload?: unknown): void
  /** Read a service (same as {@link PluginContext.get}). */
  get<T>(key: ServiceKey): T | undefined
  /** Tear the whole host down (used by the `window` plugin's quit path). */
  dispose(): Promise<void>
}

/**
 * One pet capability unit. Everything is a plugin: a plugin may own the
 * harness runtime, own the snapshot, own the window, or do anything an
 * external author wants.
 */
export interface PetPlugin<TConfig extends object = object> {
  /** Unique plugin name; also the key used in the config file. */
  name: string
  /** Optional semantic version of the plugin. */
  version?: string
  /** One-line human description (shown by `--list-plugins`). */
  description?: string
  /** Plugins that must be active before this one; unmet requirements abort startup. */
  requires?: string[]
  /** Plugins that should run first when present, but are not mandatory. */
  optional?: string[]
  /** Optional options validator; applied to the config row before `setup`. */
  config?: Schema<TConfig>
  /**
   * Activate the plugin. Return a disposer to run on shutdown (reverse start
   * order). May be async; setup failures are non-fatal by default — the host
   * logs them and keeps running the remaining plugins (override with
   * {@link PetHostOptions.fatalPlugins}).
   */
  setup(ctx: PluginContext<TConfig>, config: TConfig): Disposer | Promise<Disposer>
}

/** A plugin plus its merged options, as registered on the host. */
export interface RegisteredPlugin<TConfig extends object = object> {
  readonly definition: PetPlugin<TConfig>
  readonly options: TConfig
}

/**
 * Create a plugin with inferred option typing. The returned value is a plain
 * object literal; `definePlugin` only narrows the types and gives a clearer
 * error when a required field is missing.
 * @param plugin - the plugin definition.
 * @returns the same object, typed as a {@link PetPlugin}.
 */
export function definePlugin<TConfig extends object>(plugin: PetPlugin<TConfig>): PetPlugin<TConfig> {
  if (typeof plugin.name !== 'string' || plugin.name === '') {
    throw new TypeError('definePlugin: plugin.name must be a non-empty string')
  }
  if (typeof plugin.setup !== 'function') {
    throw new TypeError(`definePlugin: plugin "${plugin.name}" is missing a setup() function`)
  }
  return plugin
}

/** Typed helper so built-in plugins share one snapshot event name. */
export const EVENTS = {
  /** Emitted with each changed {@link PetSnapshot} (bridge plugin). */
  snapshot: 'snapshot',
  /** Emitted with each changed {@link PetSnapshot} (state plugin). */
  stateChanged: 'state:changed',
  /** Emitted when the runtime subprocess handshake completes. */
  harnessStarted: 'harness:started',
  /** Emitted when the runtime subprocess has been reaped. */
  harnessClosed: 'harness:closed',
  /** Emitted when any plugin requests the host to shut down. */
  quit: 'quit',
  /** Emitted after each plugin's `setup` succeeds. */
  pluginStarted: 'plugin:started',
  /** Emitted after each plugin's disposer runs. */
  pluginDisposed: 'plugin:disposed',
  /** Emitted when a plugin's `setup` throws. */
  pluginError: 'plugin:error',
  /** Emitted when a chat prompt settles with a final reply (bridge plugin). */
  turnDone: 'turn:done',
  /** Emitted when the runtime asks for approval (`approval/asked` session event). */
  approvalAsked: 'approval:asked',
  /** Emitted when the pet window should be focused and expanded (notifier → window). */
  petFocus: 'pet:focus',
  /** Emitted with an incoming approval request for the window to render (notifier → window). */
  approvalShown: 'approval:shown',
  /** Emitted with the user's approval decision (window → notifier → host). */
  approvalRespond: 'approval:respond',
} as const

/** Service keys published by the built-in plugins. */
export const SERVICES = {
  /** The harness runtime handle ({@link PetHarness}) — published by the `runtime` plugin. */
  harness: 'harness',
  /** The chat bridge ({@link PetService}) — published by the `bridge` plugin. */
  pet: 'pet',
  /** The shared snapshot state ({@link PetStateService}) — published by the `state` plugin. */
  state: 'state',
  /** The pet window handle ({@link PetWindowService}) — published by the `window` plugin. */
  window: 'window',
  /** The pet's name ({@link PetIdentityService}) — published by the `identity` plugin. */
  identity: 'identity',
  /** The pet's long-term memory and persona ({@link PetMemoryService}) — published by the `memory` plugin. */
  memory: 'memory',
} as const

/** The window surface the `window` plugin publishes (for focus-aware plugins). */
export interface PetWindowService {
  /** Whether the pet window currently has OS focus (user is watching it). */
  isFocused(): boolean
}

/** The pet's identity, published by the `identity` plugin. */
export interface PetIdentityService {
  /** The pet's display name. */
  name: string
}

/** The pet's long-term memory, published by the `memory` plugin. */
export interface PetMemoryService {
  /** The persona text (live-loaded from `data/persona.md`). */
  readonly persona: string
  /** Max working-memory history entries (messages). */
  readonly maxHistory: number
  /** Facts the pet has remembered about the user. */
  facts(): string[]
  /** Episodic summaries distilled from past conversations. */
  episodes(): string[]
  /** Compact persona + memory text injected at the start of each launch's conversation. */
  context(): string
  /** Facts + episodes, for the "你记得什么" recall command. */
  recallText(): string
  /** Persist a remembered fact (deduplicated, capped). */
  addFact(text: string, source?: 'command' | 'consolidated'): void
  /** Remove facts containing `match`; returns how many were removed. */
  removeFact(match: string): number
  /** Persist a distilled episode summary (capped). */
  addEpisode(summary: string): void
  /** Record one completed exchange into the working history (capped). */
  recordTurn(user: string, reply: string): void
  /** Current working-history length (messages). */
  historyLength(): number
  /** Messages beyond `maxHistory` awaiting consolidation. */
  overflowCount(): number
  /** Remove and return the oldest `count` messages (for consolidation). */
  drainHistory(count: number): Array<{ role: 'user' | 'assistant'; text: string }>
}

/** The chat surface exposed by the `bridge` plugin. */
export interface PetService {
  /** Queue one prompt; resolves with the final assistant text. */
  prompt(text: string): Promise<string>
  /** The current {@link PetSnapshot}. */
  readonly snapshot: PetSnapshotValue
  /** Subscribe to snapshot changes; returns the disposer. */
  listen(listener: (snapshot: PetSnapshotValue) => void): () => void
}

/** Structural snapshot value (re-exported for convenience). */
export type PetSnapshotValue = import('../types.ts').PetSnapshot

/** The shared state surface exposed by the `state` plugin. */
export interface PetStateService {
  /** The current snapshot. */
  readonly snapshot: PetSnapshotValue
  /** Fold one wire notification into the snapshot; emits `state:changed` when it changes. */
  reduce(notification: unknown): PetSnapshotValue
  /** Force the snapshot to a specific value; emits `state:changed` when it changes. */
  replace(snapshot: PetSnapshotValue): void
}
