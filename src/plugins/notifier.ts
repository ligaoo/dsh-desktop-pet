/**
 * `notifier` plugin: turns harness activity into desktop notifications and
 * approval cards.
 *
 * - `turn:done` (a prompt settled with a reply) → "任务完成" notification;
 * - `approval:asked` (the pet's own runtime asks) → "需要审批" notification;
 * - `POST /approval` from a harness host → an approval card in the pet window
 *   (批准/拒绝) plus a notification; the decision is POSTed back to the
 *   host's `respondUrl`;
 * - clicking any notification focuses+expands the pet window (default), or
 *   opens a configured `jumpUrl` (e.g. the main harness web UI);
 * - local HTTP endpoints (default `127.0.0.1:17890`): `POST /notify` (display
 *   only), `POST /approval` (approval card, host-side), `POST
 *   /approval-respond` (script/test the decision path), `GET /health`.
 *
 * Headless (plain Node) degrades to console lines; under Electron it uses the
 * system Notification API and the window's approval card.
 *
 * @module desktop-pet/plugins/notifier
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { boolean, number, object, string, type Schema } from '../core/schema.ts'
import { definePlugin, EVENTS } from '../core/plugin.ts'

/** Options for the `notifier` plugin. */
export interface NotifierPluginOptions {
  /** Notify when a chat prompt settles with a reply (default true). */
  taskDone?: boolean | undefined
  /** Only pop task-done while the pet window is NOT focused (default true). */
  taskDoneOnlyWhenUnfocused?: boolean | undefined
  /** Notify when the runtime requests approval (default true). */
  approvals?: boolean | undefined
  /** Clicking a notification focuses and expands the pet window (default true). */
  focusPetOnClick?: boolean | undefined
  /** When set, clicking a notification opens this URL instead of focusing the pet. */
  jumpUrl?: string | undefined
  /** Local notify endpoint port; 0 disables the endpoint (default 17890). */
  notifyPort?: number | undefined
  /** File the chosen port is written to for external discovery (default `<cwd>/.desktop-pet-notify-port`). */
  notifyPortFile?: string | undefined
  /** How long a host-forwarded approval stays answerable before it is dropped (default 600000). */
  approvalTimeoutMs?: number | undefined
}

/** Options schema for the `notifier` plugin. */
export const notifierConfig: Schema<NotifierPluginOptions> = object({
  taskDone: boolean(true),
  taskDoneOnlyWhenUnfocused: boolean(true),
  approvals: boolean(true),
  focusPetOnClick: boolean(true),
  jumpUrl: string(),
  notifyPort: number(17890),
  notifyPortFile: string(),
  approvalTimeoutMs: number(600000),
})

/** One display-only notification payload. */
interface NotifyPayload {
  title: string
  body: string
  jumpUrl?: string | undefined
}

/** One host-forwarded approval request. */
export interface ApprovalRequestPayload {
  requestId: string
  toolName?: string | undefined
  reason?: string | undefined
  sessionId?: string | undefined
  jumpUrl?: string | undefined
  /** Where the decision should be POSTed back (the host's response endpoint). */
  respondUrl?: string | undefined
}

/** The user's decision sent back to the host. */
export interface ApprovalDecision {
  requestId: string
  outcome: 'allowed-once' | 'rejected'
}

/** Truncate a reply to a one-line notification body. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/** Read a string field from the POST body, or undefined. */
function strField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
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

/**
 * The `notifier` plugin. No required plugins; it consumes host events
 * (`turn:done`, `approval:asked`, `approval:respond`) and the window plugin
 * consumes `pet:focus` / `approval:shown`.
 */
export const notifierPlugin = definePlugin<NotifierPluginOptions>({
  name: 'notifier',
  version: '0.1.0',
  description: 'Desktop notifications and approval cards, with a local notify/approval endpoint',
  config: notifierConfig,
  async setup(ctx, options) {
    const disposers: Array<() => void> = []
    const electron = typeof process.versions.electron === 'string'
    /** Pending host-forwarded approvals: requestId → settle + metadata. */
    const pendingApprovals = new Map<string, {
      respondUrl: string | undefined
      timer: NodeJS.Timeout
      settle: (outcome: ApprovalDecision['outcome']) => void
    }>()

    /** Show one notification; headless falls back to a console line. */
    const notify = async (payload: NotifyPayload): Promise<void> => {
      const onJump = (): void => {
        const url = payload.jumpUrl ?? options.jumpUrl
        if (url !== undefined && url !== '') {
          void import('electron').then(({ shell }) => shell.openExternal(url)).catch(() => {})
        } else if (options.focusPetOnClick !== false) {
          ctx.emit(EVENTS.petFocus)
        }
      }
      if (!electron) {
        ctx.logger.info('[notify] %s — %s', payload.title, payload.body)
        return
      }
      const { app, Notification } = await import('electron')
      if (!app.isReady()) await app.whenReady()
      const notification = new Notification({ title: payload.title, body: payload.body })
      notification.on('click', onJump)
      notification.show()
      disposers.push(() => {
        notification.close()
      })
    }

    /** Send the user's decision back to the host (fire and forget). */
    const sendDecision = async (decision: ApprovalDecision): Promise<void> => {
      const pending = pendingApprovals.get(decision.requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      pendingApprovals.delete(decision.requestId)
      if (pending.respondUrl === undefined) return
      try {
        await fetch(pending.respondUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(decision),
        })
      } catch (error) {
        ctx.logger.warn('approval response to host failed: %s', error instanceof Error ? error.message : String(error))
      }
    }

    /** Accept one host-forwarded approval request (card + notification + pending). */
    const acceptApproval = (payload: ApprovalRequestPayload): void => {
      const body = [payload.toolName !== undefined ? `工具 ${payload.toolName}` : undefined, payload.reason]
        .filter((part): part is string => part !== undefined && part !== '')
        .join('：') || '有审批请求待处理'
      void notify({ title: '需要审批', body, jumpUrl: payload.jumpUrl })
      ctx.emit(EVENTS.approvalShown, payload)
      const timer = setTimeout(() => {
        pendingApprovals.delete(payload.requestId)
      }, options.approvalTimeoutMs ?? 600000)
      pendingApprovals.set(payload.requestId, {
        respondUrl: payload.respondUrl,
        timer,
        settle: (outcome) => { void sendDecision({ requestId: payload.requestId, outcome }) },
      })
    }

    // Host-event subscriptions.
    if (options.taskDone !== false) {
      disposers.push(ctx.on(EVENTS.turnDone, (payload) => {
        const reply = (payload as { reply?: unknown } | undefined)?.reply
        if (typeof reply !== 'string' || reply === '') return
        // While the user is watching the pet (window focused), the reply is
        // already visible in the bubble — a popup would just be noise. Only
        // notify when the pet window is not focused (or there is no window,
        // e.g. headless console mode).
        if (options.taskDoneOnlyWhenUnfocused !== false) {
          const win = ctx.get<import('../core/plugin.ts').PetWindowService>('window')
          if (win !== undefined && win.isFocused()) return
        }
        void notify({ title: '任务完成', body: snippet(reply) })
      }))
    }
    if (options.approvals !== false) {
      disposers.push(ctx.on(EVENTS.approvalAsked, (payload) => {
        const toolName = (payload as { toolName?: unknown } | undefined)?.toolName
        void notify({ title: '需要审批', body: typeof toolName === 'string' ? `工具 ${toolName} 需要审批` : '有审批请求待处理' })
      }))
      disposers.push(ctx.on(EVENTS.approvalRespond, (payload) => {
        const decision = payload as ApprovalDecision
        if (typeof decision.requestId === 'string' && (decision.outcome === 'allowed-once' || decision.outcome === 'rejected')) {
          void sendDecision(decision)
        }
      }))
    }

    // Local HTTP endpoint: notify + approval + respond.
    const port = options.notifyPort ?? 0
    if (port > 0) {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          if (req.method === 'GET' && req.url === '/health') {
            json(res, 200, { ok: true, plugin: 'notifier' })
            return
          }
          json(res, 404, { ok: false })
          return
        }
        void (async () => {
          let payload: unknown
          try {
            payload = await readJson(req)
          } catch {
            json(res, 400, { ok: false, error: 'body must be JSON' })
            return
          }
          const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
          if (req.url === '/approval-respond') {
            const requestId = strField(record.requestId)
            const outcome = record.outcome
            if (requestId === undefined || (outcome !== 'allowed-once' && outcome !== 'rejected')) {
              json(res, 400, { ok: false, error: 'expected { requestId, outcome: "allowed-once"|"rejected" }' })
              return
            }
            void sendDecision({ requestId, outcome })
            json(res, 200, { ok: true })
            return
          }
          if (req.url === '/approval') {
            const requestId = strField(record.requestId)
            if (requestId === undefined) {
              json(res, 400, { ok: false, error: 'expected { requestId, ... }' })
              return
            }
            acceptApproval({
              requestId,
              ...strField(record.toolName) !== undefined && { toolName: strField(record.toolName) },
              ...strField(record.reason) !== undefined && { reason: strField(record.reason) },
              ...strField(record.sessionId) !== undefined && { sessionId: strField(record.sessionId) },
              ...strField(record.jumpUrl) !== undefined && { jumpUrl: strField(record.jumpUrl) },
              ...strField(record.respondUrl) !== undefined && { respondUrl: strField(record.respondUrl) },
            })
            json(res, 200, { ok: true })
            return
          }
          // POST / or /notify — display-only.
          void notify({
            title: strField(record.title) ?? '桌宠',
            body: strField(record.body) ?? '',
            ...strField(record.jumpUrl) !== undefined && { jumpUrl: strField(record.jumpUrl) },
          })
          json(res, 200, { ok: true })
        })()
      })
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      })
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      const portFile = options.notifyPortFile ?? `${process.cwd()}/.desktop-pet-notify-port`
      try {
        writeFileSync(portFile, String(actualPort), 'utf8')
      } catch (error) {
        ctx.logger.warn('could not write notify port file: %s', error instanceof Error ? error.message : String(error))
      }
      ctx.logger.info('notify endpoint listening on http://127.0.0.1:%s (port file: %s)', actualPort, portFile)
      disposers.push(() => {
        server.close()
      })
    }

    return () => {
      for (const dispose of disposers) dispose()
      for (const pending of pendingApprovals.values()) clearTimeout(pending.timer)
      pendingApprovals.clear()
    }
  },
})
