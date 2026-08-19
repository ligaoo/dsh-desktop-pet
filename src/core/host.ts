/**
 * The pet host: a tiny plugin container that loads plugins in dependency
 * order, runs their `setup`, fans events, and shares services. The host is
 * deliberately small (~200 lines) and dependency-free so it works the same
 * under plain Node, tsx, Electron, and test runners.
 *
 * Lifecycle:
 *   host.use(plugin, options)      — register (order-independent)
 *   await host.start()             — topological sort, then setup each plugin
 *   await host.dispose()           — run disposers in reverse start order
 *
 * @module desktop-pet/host
 */

import type { Disposer, EventHandler, EventKey, PetLogger, PetPlugin, PluginContext, ServiceKey } from './plugin.ts'
import { definePlugin } from './plugin.ts'
import type { Schema } from './schema.ts'
import { SchemaValidationError } from './schema.ts'

/** Options for {@link PetHost}. */
export interface PetHostOptions {
  /**
   * Plugin names whose `setup` failure aborts the whole host instead of being
   * logged and skipped. The host always aborts on dependency-cycle and
   * missing-requirement errors, which are configuration bugs.
   */
  fatalPlugins?: string[]
  /** Human-readable host version, reported by `--version`. */
  version?: string
}

/** One registered plugin row with its live state. */
interface PluginRecord {
  readonly definition: PetPlugin
  readonly options: Record<string, unknown>
  disposer: Disposer
  started: boolean
}

/** A plugin whose options were validated against its schema (if any). */
function validateOptions(definition: PetPlugin, raw: Record<string, unknown>): Record<string, unknown> {
  const schema = definition.config as Schema<Record<string, unknown>> | undefined
  if (schema === undefined) return raw
  try {
    const validated = schema(raw)
    return validated === undefined ? {} : validated
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new Error(`plugin "${definition.name}" options are invalid: ${error.message}`)
    }
    throw error
  }
}

/** Event bus + service registry + plugin lifecycle in one small container. */
export class PetHost {
  private readonly records = new Map<string, PluginRecord>()
  private readonly listeners = new Map<EventKey, Set<EventHandler>>()
  private readonly services = new Map<ServiceKey, unknown>()
  private readonly order: string[] = []
  private readonly fatal: ReadonlySet<string>
  private started = false
  private disposed = false
  /** Set once {@link dispose} begins so a second call is a no-op. */
  private disposing: Promise<void> | undefined

  /** @param options - host tuning (fatal plugin names, version). */
  constructor(readonly options: PetHostOptions = {}) {
    this.fatal = new Set(options.fatalPlugins ?? [])
  }

  /** The host version string (default `0.1.0`). */
  get version(): string {
    return this.options.version ?? '0.1.0'
  }

  /** Plugin names in their final start order (empty before {@link start}). */
  get startOrder(): readonly string[] {
    return [...this.order]
  }

  /** Names of all registered plugins (order-independent). */
  get pluginNames(): readonly string[] {
    return [...this.records.keys()]
  }

  /** Register a plugin. Idempotent per name: re-registering replaces the earlier row. */
  use(plugin: PetPlugin, options: Record<string, unknown> = {}): this {
    if (this.started) throw new Error(`cannot register plugin "${plugin.name}" after start()`)
    const validated = validateOptions(plugin, options)
    this.records.set(plugin.name, {
      definition: plugin,
      options: validated,
      disposer: undefined,
      started: false,
    })
    return this
  }

  /** Register a plugin from a plain object literal ({@link definePlugin} sugar). */
  useDefinition(plugin: PetPlugin, options: Record<string, unknown> = {}): this {
    return this.use(definePlugin(plugin), options)
  }

  /**
   * Start every registered plugin in dependency order. Plugins named in
   * `requires` are guaranteed to run first; a missing or disabled required
   * plugin aborts startup with a descriptive error (as do dependency cycles).
   * A plugin's own `setup` failure is logged and skipped unless the plugin is
   * listed in `fatalPlugins`.
   * @returns settlement once every plugin has been set up (or the fatal one failed).
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const order = this.topologicalOrder()
    this.order.push(...order)
    for (const name of order) {
      const record = this.records.get(name)!
      const logger = this.logger(name)
      try {
        const ctx = this.context(name)
        const disposer = await record.definition.setup(ctx, record.options)
        record.disposer = disposer
        record.started = true
        this.emit('plugin:started', { name })
      } catch (error) {
        this.emit('plugin:error', { name, error: error instanceof Error ? error.message : String(error) })
        if (this.fatal.has(name)) {
          logger.error('fatal plugin failed, aborting: %s', error instanceof Error ? error.message : error)
          throw error
        }
        logger.warn('plugin failed to start, continuing: %s', error instanceof Error ? error.message : error)
      }
    }
  }

  /**
   * Tear every started plugin down in reverse start order. Idempotent: the
   * first call performs the teardown; later calls await the same promise.
   * @returns settlement of the complete teardown.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.performDispose()
    return this.disposing
  }

  /** Subscribe to a host event. @returns the subscription's disposer. */
  on(event: EventKey, handler: EventHandler): () => void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  /** Publish one host event to all current subscribers, in subscribe order. */
  emit(event: EventKey, payload?: unknown): void {
    const set = this.listeners.get(event)
    if (set === undefined) return
    for (const handler of [...set]) handler(payload)
  }

  /** Read a service published by a plugin; `undefined` when absent. */
  get<T>(key: ServiceKey): T | undefined {
    return this.services.get(key) as T | undefined
  }

  /** Read a service, throwing when absent. */
  getOrThrow<T>(key: ServiceKey): T {
    const value = this.services.get(key) as T | undefined
    if (value === undefined) throw new Error(`service "${key}" is not provided by any active plugin`)
    return value
  }

  /** Publish (or replace) a service. */
  provide<T>(key: ServiceKey, value: T): void {
    this.services.set(key, value)
  }

  /** Remove a service; no-op when absent. */
  unprovide(key: ServiceKey): void {
    this.services.delete(key)
  }

  /** A namespaced logger (console with a `[name]` prefix). */
  logger(name: string): PetLogger {
    const write = (level: 'info' | 'warn' | 'error') => (message: string, ...args: unknown[]) => {
      const line = `[${name}] ${message}`
      if (level === 'info') console.info(line, ...args)
      else if (level === 'warn') console.warn(line, ...args)
      else console.error(line, ...args)
    }
    return { info: write('info'), warn: write('warn'), error: write('error') }
  }

  /** Build the {@link PluginContext} handed to one plugin. */
  private context(name: string): PluginContext {
    const record = this.records.get(name)!
    return {
      name,
      host: {
        version: this.version,
        emit: (event, payload) => this.emit(event, payload),
        get: (key) => this.get(key),
        dispose: () => this.dispose(),
      },
      config: record.options,
      on: (event, handler) => this.on(event, handler),
      emit: (event, payload) => this.emit(event, payload),
      get: (key) => this.get(key),
      getOrThrow: (key) => this.getOrThrow(key),
      provide: (key, value) => this.provide(key, value),
      unprovide: (key) => this.unprovide(key),
      logger: this.logger(name),
    }
  }

  /** Validate and order the plugin rows by their dependency edges. */
  private topologicalOrder(): string[] {
    const names = [...this.records.keys()]
    const required = new Map<string, string[]>()
    for (const name of names) {
      const definition = this.records.get(name)!.definition
      const deps = [...(definition.requires ?? []), ...(definition.optional ?? [])]
      for (const dep of deps) {
        if (!this.records.has(dep)) {
          if ((definition.requires ?? []).includes(dep)) {
            throw new Error(`plugin "${name}" requires "${dep}", which is not registered`)
          }
          continue
        }
        required.set(name, [...(required.get(name) ?? []), dep])
      }
    }
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const order: string[] = []
    const visit = (name: string): void => {
      if (visited.has(name)) return
      if (visiting.has(name)) throw new Error(`plugin dependency cycle detected at "${name}"`)
      visiting.add(name)
      for (const dep of required.get(name) ?? []) visit(dep)
      visiting.delete(name)
      visited.add(name)
      order.push(name)
    }
    for (const name of names) visit(name)
    return order
  }

  private async performDispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const name of [...this.order].reverse()) {
      const record = this.records.get(name)
      if (record === undefined || !record.started) continue
      try {
        if (record.disposer !== undefined) await record.disposer()
        this.emit('plugin:disposed', { name })
      } catch (error) {
        this.emit('plugin:error', { name, error: error instanceof Error ? error.message : String(error) })
        this.logger(name).error('plugin disposer failed: %s', error instanceof Error ? error.message : error)
      }
    }
    this.order.length = 0
  }
}
