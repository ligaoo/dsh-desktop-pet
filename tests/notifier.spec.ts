import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { PetHost } from '../src/core/host.ts'
import { EVENTS } from '../src/core/plugin.ts'
import { notifierPlugin } from '../src/plugins/notifier.ts'
import { statePlugin } from '../src/plugins/state.ts'

/** Read the JSON body of an HTTP request. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** A tiny HTTP server that records POSTed payloads (stands in for the host's response endpoint). */
async function captureServer(): Promise<{ port: number; received: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const received: Array<Record<string, unknown>> = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readJson(req).then((payload) => {
      received.push(typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }).catch(() => {
      res.writeHead(400)
      res.end()
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    received,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  }
}

/** Find a free TCP port by binding and releasing one. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return port
}

/** Start a headless host with the notifier plugin on a free port. */
async function hostWithNotifier(extra: Record<string, unknown> = {}): Promise<{ host: PetHost; port: number }> {
  const port = await freePort()
  const host = new PetHost()
  host.use(statePlugin)
  host.use(notifierPlugin, { notifyPort: port, ...extra })
  await host.start()
  return { host, port }
}

describe('notifier endpoints', () => {
  it('POST /notify pushes a display notification and /health answers', async () => {
    const { host, port } = await hostWithNotifier()
    try {
      const info = console.info
      const logs: unknown[][] = []
      console.info = (...args: unknown[]) => { logs.push(args) }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '任务完成', body: '你好' }),
        })
        expect(response.ok).toBe(true)
      } finally {
        console.info = info
      }
      expect(logs.some(args => args.join(' ').includes('任务完成'))).toBe(true)
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
      expect(health).toEqual({ ok: true, plugin: 'notifier' })
    } finally {
      await host.dispose()
    }
  })

  it('POST /approval emits approval:shown and POST /approval-respond forwards the decision to respondUrl', async () => {
    const capture = await captureServer()
    const { host, port } = await hostWithNotifier()
    const shown: unknown[] = []
    host.on(EVENTS.approvalShown, payload => shown.push(payload))
    try {
      const response = await fetch(`http://127.0.0.1:${port}/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'a1',
          toolName: 'bash',
          reason: 'risky',
          sessionId: 's1',
          jumpUrl: 'http://localhost:8080/#/session/s1',
          respondUrl: `http://127.0.0.1:${capture.port}/approval-response`,
        }),
      })
      expect(response.ok).toBe(true)
      expect(shown).toEqual([expect.objectContaining({ requestId: 'a1', toolName: 'bash' })])

      // The window would call respondApproval; here we drive the same path.
      const respond = await fetch(`http://127.0.0.1:${port}/approval-respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'a1', outcome: 'allowed-once' }),
      })
      expect(respond.ok).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(capture.received).toEqual([{ requestId: 'a1', outcome: 'allowed-once' }])
    } finally {
      await host.dispose()
      await capture.close()
    }
  })

  it('skips task-done popups while the pet window is focused, and notifies when unfocused', async () => {
    const { host } = await hostWithNotifier()
    host.provide('window', { isFocused: () => true })
    const logs: unknown[][] = []
    const info = console.info
    console.info = (...args: unknown[]) => logs.push(args)
    try {
      host.emit(EVENTS.turnDone, { reply: '正在看着你呢' })
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(logs.some(args => args.join(' ').includes('任务完成'))).toBe(false)

      host.provide('window', { isFocused: () => false })
      host.emit(EVENTS.turnDone, { reply: '你不在，提醒你一下' })
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(logs.some(args => args.join(' ').includes('任务完成'))).toBe(true)
    } finally {
      console.info = info
      await host.dispose()
    }
  })
})
