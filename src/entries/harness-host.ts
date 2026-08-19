/**
 * Harness-host face of the desktop pet: mounting this module as a Cordis
 * plugin row inside a DeepSeek Harness host (`cordis.yml`) spawns the pet
 * window as a managed child process, and — when a pet `notifier` endpoint is
 * reachable — bridges host activity to it:
 *
 * - `session/event` observation: `approval/asked` → "需要审批" push,
 *   `turn/end` (completed) → "任务完成" push, each carrying a `jumpUrl` into
 *   the harness web UI (`webBaseUrl` + `sessionPath`);
 * - with `answerApprovals: true`, the pet becomes the primary approval
 *   answerer (`approval/request` waterfall, registered first): the request is
 *   pushed to the pet, the pet's 批准/拒绝 card POSTs the decision back to
 *   this plugin's local response endpoint, and the waterfall resolves with
 *   `allowed-once` / `rejected`; on timeout the question defers to the next
 *   answerer (e.g. the web UI) via `next()`.
 *
 * The entry is deliberately dependency-free at compile time: the host's `ctx`
 * is consumed through a minimal structural interface (`logger`, `effect`,
 * `on`), so the standalone package never needs `@deepseek-ai/cordis`
 * installed. It is loaded by the host, not by the pet itself.
 *
 * @module desktop-pet/harness-host
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'desktop-pet'

/**
 * Plugin config. Window fields map to `DSH_PET_*` in the pet's environment;
 * the notify fields configure the host→pet bridge.
 */
export interface HarnessHostConfig {
  /** Runtime executable the pet chats through (default `dsh-jsonrpc-agent`). */
  runtime?: string | undefined
  /** Extra arguments handed to the runtime executable (default none). */
  runtimeArgs?: string[] | undefined
  /** Workspace cwd recorded on the pet's session (default the pet process's cwd). */
  cwd?: string | undefined
  /** Provider route for the pet's agent (default `deepseek-official`). */
  provider?: string | undefined
  /** Conversation model for the pet's agent (default `deepseek-v4-flash`). */
  model?: string | undefined
  /** Override the Electron binary path (default: the `electron` package's path). */
  electronPath?: string | undefined
  /** Override the window entry path (default: the built `lib/entries/window.js`). */
  startupPath?: string | undefined
  /** The pet's notifier endpoint base (default `http://127.0.0.1:17890`); `''` disables forwarding. */
  notifyUrl?: string | undefined
  /** Harness web UI base URL; when set, pushes carry a click-to-jump URL. */
  webBaseUrl?: string | undefined
  /** Session URL template; `{sessionId}` is substituted (default `/#/session/{sessionId}`). */
  sessionPath?: string | undefined
  /** Register the pet as the approval answerer (default false = notify-only). */
  answerApprovals?: boolean | undefined
  /** How long the pet may sit on an approval before it defers to `next()` (default 60000). */
  responseTimeoutMs?: number | undefined
  /** Only forward root sessions (skip subagent children; default true). */
  onlyRootSessions?: boolean | undefined
  /** Local approval-response endpoint port; 0 picks an ephemeral port (default 0). */
  respondPort?: number | undefined
}

/** Validate and default a raw config row (callable like the original schemastery `Config`). */
export function Config(input: unknown): HarnessHostConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('desktop-pet: config must be a plain object')
  }
  const raw = input as Record<string, unknown>
  const str = (key: string): string | undefined => {
    const value = raw[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new TypeError(`desktop-pet: config.${key} must be a string`)
    return value
  }
  const bool = (key: string): boolean | undefined => {
    const value = raw[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new TypeError(`desktop-pet: config.${key} must be a boolean`)
    return value
  }
  const num = (key: string): number | undefined => {
    const value = raw[key]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`desktop-pet: config.${key} must be a number`)
    return value
  }
  const runtimeArgs = raw.runtimeArgs
  if (runtimeArgs !== undefined && (!Array.isArray(runtimeArgs) || !runtimeArgs.every(item => typeof item === 'string'))) {
    throw new TypeError('desktop-pet: config.runtimeArgs must be an array of strings')
  }
  return {
    ...str('runtime') !== undefined && { runtime: str('runtime') },
    ...runtimeArgs !== undefined && { runtimeArgs: runtimeArgs as string[] },
    ...str('cwd') !== undefined && { cwd: str('cwd') },
    ...str('provider') !== undefined && { provider: str('provider') },
    ...str('model') !== undefined && { model: str('model') },
    ...str('electronPath') !== undefined && { electronPath: str('electronPath') },
    ...str('startupPath') !== undefined && { startupPath: str('startupPath') },
    ...str('notifyUrl') !== undefined && { notifyUrl: str('notifyUrl') },
    ...str('webBaseUrl') !== undefined && { webBaseUrl: str('webBaseUrl') },
    ...str('sessionPath') !== undefined && { sessionPath: str('sessionPath') },
    ...bool('answerApprovals') !== undefined && { answerApprovals: bool('answerApprovals') },
    ...num('responseTimeoutMs') !== undefined && { responseTimeoutMs: num('responseTimeoutMs') },
    ...bool('onlyRootSessions') !== undefined && { onlyRootSessions: bool('onlyRootSessions') },
    ...num('respondPort') !== undefined && { respondPort: num('respondPort') },
  }
}

/** The minimal Cordis context surface this plugin consumes. */
export interface CordisLikeContext {
  logger(name: string): {
    warn(message: string, ...args: unknown[]): void
    info(message: string, ...args: unknown[]): void
  }
  /** Register a teardown callback for the plugin row's fiber. */
  effect(fn: () => void | Promise<void>, label?: string): void
  /** Subscribe to a host event; returns the subscription's disposer. */
  on(event: string, handler: (this: unknown, ...args: unknown[]) => unknown, options?: { prepend?: boolean }): () => void
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a host)
// ---------------------------------------------------------------------------

/** One session-log event as structurally consumed by the bridge. */
export interface LogEventLike {
  type: string
  data?: unknown
}

/** Truncate a text to a one-line notification body. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/** Build the web-UI jump URL for one session, or undefined without a base. */
export function buildJumpUrl(config: Pick<HarnessHostConfig, 'webBaseUrl' | 'sessionPath'>, sessionId: string): string | undefined {
  if (config.webBaseUrl === undefined || config.webBaseUrl === '') return undefined
  const path = config.sessionPath ?? '/#/session/{sessionId}'
  return `${config.webBaseUrl}${path.replace('{sessionId}', encodeURIComponent(sessionId))}`
}

/**
 * Find the audit id of the newest undecided, unclaimed `approval/asked` event
 * matching a request's `callId` — the same pairing the host's api-proxy uses.
 * @param events - the requesting agent's session events.
 * @param callId - the tool call the request is about, if any.
 * @param claimed - ids already claimed by other pending answerers.
 * @returns the audit id, or undefined when no matching ask exists.
 */
export function findPendingApprovalId(
  events: ReadonlyArray<LogEventLike>,
  callId: string | undefined,
  claimed: ReadonlySet<string>,
): string | undefined {
  const decided = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'approval/decided') {
      const id = (event.data as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') decided.add(id)
      continue
    }
    if (event.type !== 'approval/asked') continue
    const data = event.data as { id?: unknown; callId?: unknown } | undefined
    const id = data?.id
    if (typeof id !== 'string' || decided.has(id) || claimed.has(id)) continue
    if ((callId ?? null) !== (data?.callId ?? null)) continue
    return id
  }
  return undefined
}

/** Concatenated text of an `assistant/message` event, or null. */
export function assistantTextOf(event: LogEventLike): string | null {
  const data = event.data as { message?: { content?: unknown } } | undefined
  const content = data?.message?.content
  if (!Array.isArray(content)) return null
  let text = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
      text += (block as Record<string, unknown>).text
    }
  }
  return text === '' ? null : text
}

/**
 * Map one observed session event to a pet notification, or null when the
 * event carries no pet-visible meaning.
 */
export function sessionEventNotify(
  config: Pick<HarnessHostConfig, 'webBaseUrl' | 'sessionPath' | 'onlyRootSessions'>,
  sessionId: string,
  isRootSession: boolean,
  lastAssistantText: string,
  event: LogEventLike,
): { title: string; body: string; jumpUrl?: string } | null {
  if (config.onlyRootSessions !== false && !isRootSession) return null
  const jumpUrl = buildJumpUrl(config, sessionId)
  switch (event.type) {
    case 'approval/asked': {
      const data = event.data as { toolName?: unknown; reason?: unknown } | undefined
      const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined
      const reason = typeof data?.reason === 'string' ? data.reason : undefined
      const body = [toolName !== undefined ? `工具 ${toolName} 需要审批` : undefined, reason]
        .filter((part): part is string => part !== undefined && part !== '')
        .join('：') || '有审批请求待处理'
      return { title: '需要审批', body, ...jumpUrl !== undefined && { jumpUrl } }
    }
    case 'turn/end': {
      const kind = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
      if (kind !== 'completed') return null
      return { title: '任务完成', body: lastAssistantText !== '' ? snippet(lastAssistantText) : sessionId, ...jumpUrl !== undefined && { jumpUrl } }
    }
    default:
      return null
  }
}

/** Read the JSON body of an HTTP request. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Resolve the built window entry the Electron child opens. */
function defaultStartupPath(moduleUrl: string): string {
  const built = fileURLToPath(new URL('../../lib/entries/window.js', moduleUrl))
  if (!existsSync(built)) {
    throw new Error('desktop-pet: window entry not found at lib/entries/window.js (run `npm run build` first)')
  }
  return built
}

/** The resolved child-process spec for the pet window: executable, arguments, environment. */
export interface HarnessHostChildSpec {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Resolve a validated {@link HarnessHostConfig} into the pet window's
 * child-process spec.
 */
export function resolveChildSpec(
  config: HarnessHostConfig,
  electronPath: string,
  startupPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): HarnessHostChildSpec {
  return {
    command: electronPath,
    args: [startupPath],
    env: {
      ...baseEnv,
      DSH_PET_RUNTIME: config.runtime ?? 'dsh-jsonrpc-agent',
      DSH_PET_RUNTIME_ARGS: JSON.stringify(config.runtimeArgs ?? []),
      ...config.cwd !== undefined && { DSH_PET_CWD: config.cwd },
      DSH_PET_PROVIDER: config.provider ?? 'deepseek-official',
      DSH_PET_MODEL: config.model ?? 'deepseek-v4-flash',
    },
  }
}

/** One pending approval awaiting the pet's decision. */
interface PendingApproval {
  settle: (outcome: string) => void
  timer: NodeJS.Timeout
}

/**
 * Bridge host activity to a running pet's notifier endpoint. Extracted from
 * {@link apply} so the bridge is testable without spawning Electron.
 * @param ctx - plugin context (uses `on` and `logger`).
 * @param config - validated config.
 * @returns the teardown callback.
 */
export function bridgeHost(ctx: CordisLikeContext, config: HarnessHostConfig): () => void {
  const logger = ctx.logger('desktop-pet')
  const teardowns: Array<() => void> = []
  const notifyUrl = config.notifyUrl ?? 'http://127.0.0.1:17890'
  if (notifyUrl === '') return () => {}

  const post = (path: string, payload: Record<string, unknown>): Promise<void> =>
    fetch(`${notifyUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(() => undefined, (error) => {
      logger.warn('pet notify push failed: %s', error instanceof Error ? error.message : String(error))
    })

  const pendingApprovals = new Map<string, PendingApproval>()
  const lastTexts = new Map<string, string>()

  // Local endpoint that receives the pet's approval decisions. The URL is
  // only known after the async listen completes; the answerer waits for it.
  let respondReady: Promise<string | undefined> = Promise.resolve(undefined)
  if (config.answerApprovals === true) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/approval-response') {
        void readJson(req).then((payload) => {
          const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
          const requestId = typeof record.requestId === 'string' ? record.requestId : undefined
          const outcome = record.outcome
          const pending = requestId !== undefined ? pendingApprovals.get(requestId) : undefined
          if (pending === undefined || (outcome !== 'allowed-once' && outcome !== 'rejected')) {
            json(res, 400, { ok: false, error: 'expected { requestId, outcome } for a pending approval' })
            return
          }
          pending.settle(outcome)
          json(res, 200, { ok: true })
        }).catch(() => {
          json(res, 400, { ok: false, error: 'body must be JSON' })
        })
        return
      }
      json(res, 404, { ok: false })
    })
    respondReady = new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(config.respondPort ?? 0, '127.0.0.1', resolveListen)
    }).then(() => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : (config.respondPort ?? 0)
      const url = `http://127.0.0.1:${port}/approval-response`
      logger.info('pet approval response endpoint: %s', url)
      return url
    }, (error) => {
      logger.warn('pet approval response endpoint failed to listen: %s', error instanceof Error ? error.message : String(error))
      return undefined
    })
    teardowns.push(() => {
      server.close()
    })
  }

  // Observe every session event append: approvals (notify-only mode) and
  // task completion.
  ctx.on('session/event', (session, event) => {
    const header = (session as { header?: { id?: unknown; parentSession?: unknown } } | undefined)?.header
    const sessionId = typeof header?.id === 'string' ? header.id : undefined
    if (sessionId === undefined || header === undefined) return
    const eventRecord = event as { type?: unknown; data?: unknown }
    if (typeof eventRecord.type !== 'string') return
    const parentSession = header.parentSession
    const isRoot = parentSession === null || parentSession === undefined || parentSession === ''
    if (eventRecord.type === 'assistant/message') {
      const text = assistantTextOf(eventRecord as LogEventLike)
      if (text !== null) lastTexts.set(sessionId, text)
      return
    }
    // In answer mode the approval/request answerer sends the push itself
    // (with respondUrl); the observer only forwards in notify-only mode.
    if (eventRecord.type === 'approval/asked' && config.answerApprovals !== true) {
      const payload = sessionEventNotify(config, sessionId, isRoot, lastTexts.get(sessionId) ?? '', eventRecord as LogEventLike)
      if (payload !== null) void post('/notify', payload)
      return
    }
    if (eventRecord.type === 'turn/end') {
      const payload = sessionEventNotify(config, sessionId, isRoot, lastTexts.get(sessionId) ?? '', eventRecord as LogEventLike)
      if (payload !== null) void post('/notify', payload)
      lastTexts.delete(sessionId)
      return
    }
  })

  // Optional: the pet becomes the primary approval answerer.
  if (config.answerApprovals === true) {
    ctx.on('approval/request', (req, next) => {
      const request = req as {
        agent?: { session?: { id?: unknown; events?: unknown[] } }
        toolName?: unknown
        callId?: unknown
        reason?: unknown
        signal?: AbortSignal
      }
      const delegate = next as () => Promise<unknown> | unknown
      const agentSession = request.agent?.session
      const sessionId = typeof agentSession?.id === 'string' ? agentSession.id : undefined
      const toolName = typeof request.toolName === 'string' ? request.toolName : undefined
      const callId = typeof request.callId === 'string' ? request.callId : undefined
      const reason = typeof request.reason === 'string' ? request.reason : undefined
      const events = Array.isArray(agentSession?.events) ? agentSession.events as LogEventLike[] : []
      if (request.signal?.aborted === true) return Promise.resolve('cancelled')
      const approvalId = findPendingApprovalId(events, callId, new Set(pendingApprovals.keys()))
      if (approvalId === undefined) return delegate()
      const requestId = approvalId
      const jumpUrl = sessionId !== undefined ? buildJumpUrl(config, sessionId) : undefined
      return new Promise<unknown>((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          pendingApprovals.delete(requestId)
          void Promise.resolve(delegate()).then(resolve, resolve)
        }, config.responseTimeoutMs ?? 60000)
        const onAbort = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pendingApprovals.delete(requestId)
          resolve('cancelled')
        }
        request.signal?.addEventListener('abort', onAbort)
        pendingApprovals.set(requestId, {
          timer,
          settle: (outcome) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            request.signal?.removeEventListener('abort', onAbort)
            pendingApprovals.delete(requestId)
            resolve(outcome)
          },
        })
        void respondReady.then((url) => {
          void post('/approval', {
            requestId,
            ...toolName !== undefined && { toolName },
            ...reason !== undefined && { reason },
            ...sessionId !== undefined && { sessionId },
            ...jumpUrl !== undefined && { jumpUrl },
            ...url !== undefined && { respondUrl: url },
          })
        })
      })
    }, { prepend: true })
  }

  teardowns.push(() => {
    for (const pending of pendingApprovals.values()) clearTimeout(pending.timer)
    pendingApprovals.clear()
    lastTexts.clear()
  })

  return () => {
    for (const teardown of teardowns) teardown()
  }
}

/**
 * Spawn the pet window and bridge host activity to it. The Electron binary
 * path comes from the `electron` package's plain-Node export.
 * @param ctx - plugin context; the child dies and the bridge tears down when the row unloads.
 * @param rawConfig - raw {@link HarnessHostConfig}.
 */
export function apply(ctx: CordisLikeContext, rawConfig: unknown): void {
  const config = Config(rawConfig)
  const logger = ctx.logger('desktop-pet')
  const require = createRequire(import.meta.url)
  const electronPath = config.electronPath ?? (require('electron') as string)
  const startupPath = config.startupPath ?? defaultStartupPath(import.meta.url)
  const spec = resolveChildSpec(config, electronPath, startupPath)
  const child = spawn(spec.command, spec.args, { env: spec.env, stdio: 'ignore' })
  let stopping = false
  child.on('error', (error) => {
    logger.warn('pet window failed to start: %s', error.message)
  })
  child.on('exit', (code, signal) => {
    if (stopping || code === 0) return
    logger.warn('pet window exited unexpectedly (code %s, signal %s)', code, signal)
  })

  const bridgeTeardown = bridgeHost(ctx, config)
  ctx.effect(() => {
    stopping = true
    child.kill()
    bridgeTeardown()
  }, 'desktop-pet window')
}
