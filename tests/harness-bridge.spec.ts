import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { bridgeHost, type CordisLikeContext } from '../src/entries/harness-host.ts'

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

/** A fake pet notifier endpoint: records pushed payloads. */
async function fakePet(): Promise<{ port: number; received: Array<Record<string, unknown>>; close: () => Promise<void> }> {
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

/** A fake Cordis-like host context capturing listeners. */
function fakeCtx(): { ctx: CordisLikeContext; handlers: Map<string, Array<(this: unknown, ...args: unknown[]) => unknown>> } {
  const handlers = new Map<string, Array<(this: unknown, ...args: unknown[]) => unknown>>()
  const ctx: CordisLikeContext = {
    logger: () => ({ warn: () => {}, info: () => {} }),
    effect: () => {},
    on: (event, handler, options) => {
      const list = handlers.get(event) ?? []
      if (options?.prepend === true) list.unshift(handler)
      else list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
  }
  return { ctx, handlers }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('harness-host bridge', () => {
  it('forwards approval/asked and completed turn/end to the pet with jump URLs (notify-only mode)', async () => {
    const pet = await fakePet()
    const { ctx, handlers } = fakeCtx()
    const teardown = bridgeHost(ctx, {
      notifyUrl: `http://127.0.0.1:${pet.port}`,
      webBaseUrl: 'http://localhost:8080',
      sessionPath: '/#/session/{sessionId}',
    })
    try {
      const sessionHandler = handlers.get('session/event')![0]!
      sessionHandler.call(null,
        { header: { id: 's1', parentSession: null } },
        { type: 'approval/asked', data: { toolName: 'bash', reason: 'risky' } },
      )
      sessionHandler.call(null,
        { header: { id: 's1', parentSession: null } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '搞定' }] } } },
      )
      sessionHandler.call(null,
        { header: { id: 's1', parentSession: null } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      )
      await waitFor(() => pet.received.length >= 2)
      expect(pet.received).toContainEqual({
        title: '需要审批',
        body: '工具 bash 需要审批：risky',
        jumpUrl: 'http://localhost:8080/#/session/s1',
      })
      expect(pet.received).toContainEqual({
        title: '任务完成',
        body: '搞定',
        jumpUrl: 'http://localhost:8080/#/session/s1',
      })
    } finally {
      teardown()
      await pet.close()
    }
  })

  it('answers approvals end-to-end: push to pet, pet decides, waterfall resolves (answer mode)', async () => {
    const pet = await fakePet()
    const { ctx, handlers } = fakeCtx()
    const teardown = bridgeHost(ctx, {
      notifyUrl: `http://127.0.0.1:${pet.port}`,
      answerApprovals: true,
      responseTimeoutMs: 5000,
      webBaseUrl: 'http://localhost:8080',
    })
    try {
      const answerer = handlers.get('approval/request')![0]!
      let delegated = false
      const outcomePromise = Promise.resolve(answerer.call(null, {
        agent: { session: { id: 's1', events: [{ type: 'approval/asked', data: { id: 'a1', callId: 'c1' } }] } },
        toolName: 'bash',
        callId: 'c1',
      }, () => {
        delegated = true
        return Promise.resolve('unavailable')
      }))

      await waitFor(() => pet.received.length > 0)
      const push = pet.received[0]!
      expect(push.requestId).toBe('a1')
      expect(push.sessionId).toBe('s1')
      expect(push.respondUrl).toContain('/approval-response')
      expect(push.jumpUrl).toBe('http://localhost:8080/#/session/s1')

      // The pet (via its window card) POSTs the decision back.
      const respond = await fetch(push.respondUrl as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'a1', outcome: 'allowed-once' }),
      })
      expect(respond.ok).toBe(true)
      expect(await outcomePromise).toBe('allowed-once')
      expect(delegated).toBe(false)
    } finally {
      teardown()
      await pet.close()
    }
  })

  it('defers to the next answerer when the pet does not respond in time', async () => {
    const pet = await fakePet()
    const { ctx, handlers } = fakeCtx()
    const teardown = bridgeHost(ctx, {
      notifyUrl: `http://127.0.0.1:${pet.port}`,
      answerApprovals: true,
      responseTimeoutMs: 120,
    })
    try {
      const answerer = handlers.get('approval/request')![0]!
      const outcome = await Promise.resolve(answerer.call(null, {
        agent: { session: { id: 's1', events: [{ type: 'approval/asked', data: { id: 'a1', callId: 'c1' } }] } },
        toolName: 'bash',
        callId: 'c1',
      }, () => Promise.resolve('unavailable')))
      expect(outcome).toBe('unavailable')
    } finally {
      teardown()
      await pet.close()
    }
  })

  it('retries a push while the pet endpoint is briefly down (pet restart)', async () => {
    // The "pet" drops the first two connections (notifier port not yet
    // rebound mid-restart), then accepts — the push must land after retries.
    let hits = 0
    const received: Array<Record<string, unknown>> = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits += 1
      if (hits <= 2) {
        req.socket.destroy()
        return
      }
      void readJson(req).then((payload) => {
        received.push(typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {})
        res.writeHead(200)
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const { ctx, handlers } = fakeCtx()
    const teardown = bridgeHost(ctx, { notifyUrl: `http://127.0.0.1:${port}` })
    try {
      handlers.get('session/event')![0]!.call(null,
        { header: { id: 's1', parentSession: null } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      )
      await waitFor(() => received.length > 0, 5000)
      expect(hits).toBeGreaterThanOrEqual(3)
      expect(received[0]!.title).toBe('任务完成')
    } finally {
      teardown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
})
