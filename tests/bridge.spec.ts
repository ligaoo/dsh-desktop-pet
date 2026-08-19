import { describe, expect, it } from 'vitest'
import type { HarnessNotification, RunResult } from '../src/sdk.ts'
import { DesktopPetBridge } from '../src/core/bridge.ts'
import { INITIAL_SNAPSHOT } from '../src/core/state.ts'
import type { PetHarness, PetHarnessSession, PetSnapshot } from '../src/types.ts'

type Observer = ((notification: HarnessNotification) => void) | undefined
type RunHandler = (input: string, onNotification: Observer) => Promise<RunResult>

function runResult(finalResponse: string): RunResult {
  return { sessionId: 'desktop-pet', finalResponse, events: [], notifications: [] }
}

class FakeHarness implements PetHarness {
  started = false
  closed = false
  readonly sessionIds: string[] = []
  readonly calls: string[] = []

  constructor(private readonly handler: RunHandler) {}

  start(): Promise<void> {
    this.started = true
    return Promise.resolve()
  }

  session(id: string): PetHarnessSession {
    this.sessionIds.push(id)
    return {
      id,
      run: (input, options) => {
        this.calls.push(input)
        return this.handler(input, options?.onNotification)
      },
    }
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** A handler streaming one realistic turn for the root session. */
function turnHandler(reply: string): RunHandler {
  return (_input, onNotification) => {
    const notify = (notification: HarnessNotification): void => onNotification?.(notification)
    notify({ method: 'session.status', params: { sessionId: 'desktop-pet', status: 'running' } })
    notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'tool/call', data: { name: 'bash' } } } })
    notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } } } })
    notify({ method: 'session.status', params: { sessionId: 'desktop-pet', status: 'idle' } })
    return Promise.resolve(runResult(reply))
  }
}

/** A handler streaming `text-delta` chunks into a live bubble. */
function streamingHandler(chunks: string[]): RunHandler {
  const reply = chunks.join('')
  return (_input, onNotification) => {
    const notify = (notification: HarnessNotification): void => onNotification?.(notification)
    notify({ method: 'session.status', params: { sessionId: 'desktop-pet', status: 'running' } })
    notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'turn/start', data: { turn: 1 } } } })
    for (const text of chunks) {
      notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } } } } })
    }
    notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } } } })
    notify({ method: 'session.status', params: { sessionId: 'desktop-pet', status: 'idle' } })
    return Promise.resolve(runResult(reply))
  }
}

describe('DesktopPetBridge', () => {
  it('starts the runtime and streams snapshot changes for one prompt', async () => {
    const harness = new FakeHarness(turnHandler('done'))
    const bridge = new DesktopPetBridge(harness)
    expect(bridge.snapshot).toBe(INITIAL_SNAPSHOT)
    await bridge.start()
    expect(harness.started).toBe(true)

    const seen: PetSnapshot[] = []
    bridge.listen(snapshot => seen.push(snapshot))
    await expect(bridge.prompt('hi')).resolves.toBe('done')

    expect(seen.map(snapshot => snapshot.mood)).toEqual(['thinking', 'acting', 'speaking', 'idle'])
    expect(bridge.snapshot).toEqual({ mood: 'idle', speech: 'done', detail: null })
    expect(harness.sessionIds).toEqual(['desktop-pet'])
  })

  it('ignores notifications from other sessions in the tree', async () => {
    const harness = new FakeHarness((_input, onNotification) => {
      onNotification?.({ method: 'session.status', params: { sessionId: 'child-1', status: 'running' } })
      onNotification?.({ method: 'session.event', params: { sessionId: 'child-1', event: { type: 'tool/call', data: { name: 'bash' } } } })
      return Promise.resolve(runResult(''))
    })
    const bridge = new DesktopPetBridge(harness)
    let delivered = 0
    bridge.listen(() => delivered++)
    await bridge.prompt('go')
    expect(delivered).toBe(0)
    expect(bridge.snapshot).toBe(INITIAL_SNAPSHOT)
  })

  it('serializes concurrent prompts onto the shared session', async () => {
    const order: string[] = []
    const harness = new FakeHarness(async (input) => {
      order.push(`start:${input}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${input}`)
      return runResult(input)
    })
    const bridge = new DesktopPetBridge(harness)
    const [first, second] = await Promise.all([bridge.prompt('one'), bridge.prompt('two')])
    expect([first, second]).toEqual(['one', 'two'])
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
  })

  it('rejects blank prompts without touching the runtime', async () => {
    const harness = new FakeHarness(() => Promise.resolve(runResult('')))
    const bridge = new DesktopPetBridge(harness)
    await expect(bridge.prompt('   ')).rejects.toThrow('prompt text must be non-empty')
    expect(harness.calls).toEqual([])
  })

  it('publishes the error mood on failure and keeps the queue usable', async () => {
    let fail = true
    const harness = new FakeHarness(() => fail ? Promise.reject(new Error('boom')) : Promise.resolve(runResult('ok')))
    const bridge = new DesktopPetBridge(harness)
    const seen: PetSnapshot[] = []
    bridge.listen(snapshot => seen.push(snapshot))

    await expect(bridge.prompt('go')).rejects.toThrow('boom')
    expect(bridge.snapshot).toEqual({ mood: 'error', speech: null, detail: 'boom' })

    fail = false
    await expect(bridge.prompt('again')).resolves.toBe('ok')
    expect(harness.calls).toEqual(['go', 'again'])
  })

  it('stringifies non-Error rejections into the error detail', async () => {
    const harness = new FakeHarness(() => Promise.reject(new Error('wrapped', { cause: 'plain' })))
    const bridge = new DesktopPetBridge(harness)
    await expect(bridge.prompt('go')).rejects.toThrow('wrapped')
    expect(bridge.snapshot.detail).toBe('wrapped')
  })

  it('stops delivering after the listener disposes', async () => {
    const harness = new FakeHarness(turnHandler('done'))
    const bridge = new DesktopPetBridge(harness)
    let delivered = 0
    const dispose = bridge.listen(() => delivered++)
    dispose()
    await bridge.prompt('hi')
    expect(delivered).toBe(0)
    expect(bridge.snapshot.mood).toBe('idle')
  })

  it('closes idempotently and refuses prompts afterwards', async () => {
    const harness = new FakeHarness(turnHandler('done'))
    const bridge = new DesktopPetBridge(harness)
    await bridge.prompt('hi')
    await bridge.close()
    await bridge.close()
    expect(harness.closed).toBe(true)
    await expect(bridge.prompt('late')).rejects.toThrow('desktop pet bridge is closed')
  })

  it('disposes through await using', async () => {
    const harness = new FakeHarness(turnHandler('done'))
    {
      await using bridge = new DesktopPetBridge(harness)
      await bridge.prompt('hi')
    }
    expect(harness.closed).toBe(true)
  })

  it('honors an explicit session id', async () => {
    const harness = new FakeHarness(turnHandler('done'))
    const bridge = new DesktopPetBridge(harness, { sessionId: 'pet-42' })
    await bridge.prompt('hi')
    expect(harness.sessionIds).toEqual(['pet-42'])
  })

  it('streams text-delta chunks into the speech bubble as they arrive', async () => {
    const harness = new FakeHarness(streamingHandler(['你', '好', '啊']))
    const bridge = new DesktopPetBridge(harness)
    const seen: Array<{ mood: string; speech: string | null }> = []
    bridge.listen(snapshot => seen.push({ mood: snapshot.mood, speech: snapshot.speech }))
    await expect(bridge.prompt('hi')).resolves.toBe('你好啊')
    expect(seen).toEqual([
      { mood: 'thinking', speech: null },
      { mood: 'speaking', speech: '你' },
      { mood: 'speaking', speech: '你好' },
      { mood: 'speaking', speech: '你好啊' },
      { mood: 'idle', speech: '你好啊' },
    ])
    expect(bridge.snapshot).toEqual({ mood: 'idle', speech: '你好啊', detail: null })
  })

  it('ignores non-text chunk kinds while streaming', async () => {
    const harness = new FakeHarness((_input, onNotification) => {
      const notify = (notification: HarnessNotification): void => onNotification?.(notification)
      notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } } } } })
      notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{}' } } } } })
      notify({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'complete' } } } } } })
      return Promise.resolve(runResult(''))
    })
    const bridge = new DesktopPetBridge(harness)
    let delivered = 0
    bridge.listen(() => delivered++)
    await bridge.prompt('go')
    expect(delivered).toBe(0)
    expect(bridge.snapshot).toBe(INITIAL_SNAPSHOT)
  })

  it('forwards every root-session notification to the onNotification hook before folding', async () => {
    const harness = new FakeHarness(turnHandler('done'))
    const seen: string[] = []
    const bridge = new DesktopPetBridge(harness, {
      onNotification: (notification) => {
        seen.push(notification.method)
      },
    })
    await bridge.prompt('hi')
    // status running, tool/call, assistant/message, status idle
    expect(seen).toEqual(['session.status', 'session.event', 'session.event', 'session.status'])
  })
})
