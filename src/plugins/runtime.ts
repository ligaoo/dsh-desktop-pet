/**
 * `runtime` plugin: owns the DeepSeek Harness runtime subprocess for the
 * pet's lifetime. Ports `launch.ts` (env resolution) and hands the harness to
 * the `bridge` plugin through the `harness` service. The runtime starts
 * lazily on the first prompt so the window opens instantly.
 *
 * Options mirror the original `DSH_PET_*` environment variables; when the
 * options omit a field, the environment (and then defaults) fill it in.
 *
 * @module desktop-pet/plugins/runtime
 */

import { resolvePetLaunch } from '../core/launch.ts'
import { resolveHarnessApiKey } from '../core/credentials.ts'
import { join } from 'node:path'
import { definePlugin } from '../core/plugin.ts'
import { number, object, optional, record, strictString, string, type Schema } from '../core/schema.ts'
import { DeepSeekHarness } from '../sdk.ts'
import type { PetHarness } from '../types.ts'

/**
 * Options for the `runtime` plugin. Every field is optional; the
 * `DSH_PET_*` environment and stock defaults fill the gaps.
 */
export interface RuntimePluginOptions {
  /** Runtime executable the pet chats through (default `dsh-jsonrpc-agent`). */
  command?: string | undefined
  /** Extra arguments handed to the runtime executable (default none). */
  args?: string[] | undefined
  /** Workspace cwd recorded on the pet's session (default the pet process's cwd). */
  cwd?: string | undefined
  /** Provider route for the pet's agent (default `deepseek-official`). */
  provider?: string | undefined
  /** Conversation model for the pet's agent (default `deepseek-v4-flash`). */
  model?: string | undefined
  /** Per-request timeout (ms); unset waits indefinitely (a turn can run long). */
  requestTimeoutMs?: number | undefined
  /** Bound (ms) on the protocol `shutdown` exchange inside teardown. */
  shutdownTimeoutMs?: number | undefined
  /** Grace (ms) for the runtime's stdin-EOF quiesce during teardown. */
  disposeEofGraceMs?: number | undefined
  /** Termination confirmation window (ms) after SIGTERM/SIGKILL during teardown. */
  disposeGraceMs?: number | undefined
  /**
   * Extra variables merged onto the inherited environment for the runtime
   * subprocess. `DEEPSEEK_API_KEY` is injected automatically from the harness
   * credentials store when the environment lacks one.
   */
  env?: Record<string, string> | undefined
}

/** Options schema for the `runtime` plugin. */
export const runtimeConfig: Schema<RuntimePluginOptions> = object({
  command: string(),
  args: arrayOfStrings(),
  cwd: string(),
  provider: string(),
  model: string(),
  requestTimeoutMs: number(),
  shutdownTimeoutMs: number(),
  disposeEofGraceMs: number(),
  disposeGraceMs: number(),
  env: optional(record(strictString())),
})

function arrayOfStrings(): Schema<string[] | undefined> {
  return (value, path = '') => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      throw new TypeError(`${path === '' ? 'args' : path}: expected an array of strings`)
    }
    return value
  }
}

/**
 * Resolve the plugin's options against the `DSH_PET_*` environment so the
 * standalone shell keeps the original env contract.
 * @param options - validated plugin options.
 * @param env - environment (default `process.env`).
 * @returns options with env fallbacks applied.
 */
export function resolveRuntimeOptions(options: RuntimePluginOptions, env: NodeJS.ProcessEnv = process.env): RuntimePluginOptions {
  const spec = resolvePetLaunch(env)
  return {
    command: options.command ?? spec.launch.command,
    args: options.args ?? spec.launch.args,
    cwd: options.cwd ?? spec.route.cwd,
    provider: options.provider ?? spec.route.provider,
    model: options.model ?? spec.route.model,
    ...options.requestTimeoutMs !== undefined && { requestTimeoutMs: options.requestTimeoutMs },
    ...options.shutdownTimeoutMs !== undefined && { shutdownTimeoutMs: options.shutdownTimeoutMs },
    ...options.disposeEofGraceMs !== undefined && { disposeEofGraceMs: options.disposeEofGraceMs },
    ...options.disposeGraceMs !== undefined && { disposeGraceMs: options.disposeGraceMs },
    ...options.env !== undefined && { env: options.env },
  }
}

/**
 * Build the runtime subprocess environment: the inherited environment plus
 * the plugin's `env` overrides, then the harness API key injected when the
 * environment lacks one (see {@link resolveHarnessApiKey}). The result is
 * always a complete environment object handed to the child spawn.
 *
 * The runtime's bundled config persists sessions under `$DSH_SESSION_ROOT` or
 * `./.sessions` in its cwd. The pet reuses one stable session id, and each pet
 * launch spawns a FRESH runtime process, so without isolation the new
 * process's session would collide with the previous launch's persisted log
 * (the persistence coordinator rejects a live session whose seed does not
 * cover the stored prefix, ending the turn with no reply). Giving each launch
 * its own `DSH_SESSION_ROOT` keeps multi-turn continuity within the window
 * while never colliding with older stores.
 * @param options - resolved runtime options.
 * @param baseEnv - the inherited environment (default `process.env`).
 * @returns the child environment.
 */
export function buildRuntimeEnv(options: RuntimePluginOptions, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...options.env }
  const key = resolveHarnessApiKey(env)
  if (key !== undefined) env.DEEPSEEK_API_KEY = key
  if (env.DSH_SESSION_ROOT === undefined) {
    env.DSH_SESSION_ROOT = join(options.cwd ?? process.cwd(), '.sessions', String(process.pid))
  }
  return env
}

/**
 * The `runtime` plugin. Provides the `harness` service; teardown reaps the
 * runtime subprocess (idempotent — the bridge's own close already settles the
 * queue first, in reverse disposal order).
 */
export const runtimePlugin = definePlugin<RuntimePluginOptions>({
  name: 'runtime',
  version: '0.1.0',
  description: 'Owns the DeepSeek Harness runtime subprocess (launch, handshake, teardown)',
  config: runtimeConfig,
  setup(ctx, rawOptions) {
    const options = resolveRuntimeOptions(rawOptions)
    const env = buildRuntimeEnv(options)
    const harness: PetHarness = new DeepSeekHarness({
      launch: {
        command: options.command ?? 'dsh-jsonrpc-agent',
        ...options.args !== undefined && { args: options.args },
        ...options.cwd !== undefined && { cwd: options.cwd },
        ...options.requestTimeoutMs !== undefined && { requestTimeoutMs: options.requestTimeoutMs },
        ...options.shutdownTimeoutMs !== undefined && { shutdownTimeoutMs: options.shutdownTimeoutMs },
        ...options.disposeEofGraceMs !== undefined && { disposeEofGraceMs: options.disposeEofGraceMs },
        ...options.disposeGraceMs !== undefined && { disposeGraceMs: options.disposeGraceMs },
        env,
      },
      ...options.cwd !== undefined && { cwd: options.cwd },
      ...options.provider !== undefined && { provider: options.provider },
      ...options.model !== undefined && { model: options.model },
    })
    ctx.provide('harness', harness)
    ctx.provide('workspace', options.cwd ?? process.cwd())
    ctx.logger.info(
      'runtime resolved: %s %s (cwd=%s, provider=%s, model=%s%s)',
      options.command ?? 'dsh-jsonrpc-agent',
      (options.args ?? []).join(' '),
      options.cwd ?? process.cwd(),
      options.provider ?? 'deepseek-official',
      options.model ?? 'deepseek-v4-flash',
      env.DEEPSEEK_API_KEY !== undefined ? ', api-key=injected' : ', api-key=absent',
    )
    return async () => {
      await harness.close()
      ctx.emit('harness:closed')
    }
  },
})
