import { describe, expect, it } from 'vitest'
import type { HarnessNotification, RunResult } from '../src/sdk.ts'
import { collectImageSources, DesktopPetBridge, imageSourceOf } from '../src/core/bridge.ts'
import { INITIAL_SNAPSHOT } from '../src/core/state.ts'
import type { PetHarness, PetHarnessSession, PetReply, PetSnapshot } from '../src/types.ts'

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
    await expect(bridge.prompt('hi')).resolves.toEqual({ response: 'done', images: [] })

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
    expect([first, second]).toEqual([{ response: 'one', images: [] }, { response: 'two', images: [] }])
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
    await expect(bridge.prompt('again')).resolves.toEqual({ response: 'ok', images: [] })
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
    await expect(bridge.prompt('hi')).resolves.toEqual({ response: '你好啊', images: [] })
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

describe('imageSourceOf', () => {
  it('reads imageUrl / url / src from an image content block', () => {
    expect(imageSourceOf({ type: 'image', imageUrl: 'https://x/y.png' })).toBe('https://x/y.png')
    expect(imageSourceOf({ type: 'image', url: 'data:image/png;base64,AAAA' })).toBe('data:image/png;base64,AAAA')
    expect(imageSourceOf({ type: 'image', src: '/workspace/out.png' })).toBe('/workspace/out.png')
  })

  it('reads a string image field and nested image url/data', () => {
    expect(imageSourceOf({ type: 'image', image: 'data:image/jpeg;base64,BBBB' })).toBe('data:image/jpeg;base64,BBBB')
    expect(imageSourceOf({ type: 'image', image: { url: 'https://x/z.webp' } })).toBe('https://x/z.webp')
    expect(imageSourceOf({ type: 'image', alt: 'a picture' })).toBeNull()
  })

  it('wraps raw base64 data with its mediaType, and passes through a data URL', () => {
    expect(imageSourceOf({ type: 'image', mediaType: 'image/webp', data: 'CCCC' })).toBe('data:image/webp;base64,CCCC')
    expect(imageSourceOf({ type: 'image', mediaType: 'image/webp', data: 'data:image/png;base64,DDDD' })).toBe('data:image/png;base64,DDDD')
  })

  it('returns null for non-image or attachment-only blocks', () => {
    expect(imageSourceOf({ type: 'text', text: 'hi' })).toBeNull()
    expect(imageSourceOf({ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 4 } })).toBeNull()
    expect(imageSourceOf(undefined)).toBeNull()
  })
})

describe('collectImageSources', () => {
  it('collects image blocks from assistant messages and chunk block-ends, deduplicated', () => {
    const events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }, { type: 'image', imageUrl: 'https://x/a.png' }, { type: 'image', imageUrl: 'https://x/a.png' }] } } },
      { type: 'assistant/chunk', data: { chunk: { type: 'block-end', block: { type: 'image', imageUrl: 'https://x/b.png' } } } },
    ]
    const result: RunResult = { sessionId: 'desktop-pet', finalResponse: 'ok', events, notifications: [] }
    expect(collectImageSources(result)).toEqual(['https://x/a.png', 'https://x/b.png'])
  })

  it('extracts markdown and HTML image sources from the reply text', () => {
    const result: RunResult = {
      sessionId: 'desktop-pet',
      finalResponse: '看这个 ![result](https://x/c.png) 和 <img src="https://x/d.png" alt="d">',
      events: [],
      notifications: [],
    }
    expect(collectImageSources(result)).toEqual(['https://x/c.png', 'https://x/d.png'])
  })

  it('skips attachment-only image blocks', () => {
    const events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 4 } }] } } },
    ]
    const result: RunResult = { sessionId: 'desktop-pet', finalResponse: '', events, notifications: [] }
    expect(collectImageSources(result)).toEqual([])
  })

  it('returns no images for a plain text run', () => {
    const result: RunResult = { sessionId: 'desktop-pet', finalResponse: '你好', events: [], notifications: [] }
    expect(collectImageSources(result)).toEqual([])
  })
})

describe('DesktopPetBridge images', () => {
  it('resolves with the reply text and images from the run result', async () => {
    const harness = new FakeHarness((_input, onNotification) => {
      onNotification?.({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '图来了' }, { type: 'image', imageUrl: 'https://x/out.png' }] } } } } })
      return Promise.resolve<RunResult>({ sessionId: 'desktop-pet', finalResponse: '图来了', events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '图来了' }, { type: 'image', imageUrl: 'https://x/out.png' }] } } }], notifications: [] })
    })
    const bridge = new DesktopPetBridge(harness)
    const reply: PetReply = await bridge.prompt('画个图')
    expect(reply).toEqual({ response: '图来了', images: ['https://x/out.png'] })
  })

  it('strips markdown image references from the displayed text', async () => {
    const harness = new FakeHarness((_input, onNotification) => {
      onNotification?.({ method: 'session.event', params: { sessionId: 'desktop-pet', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看 ![x](https://x/a.png) 这张' }] } } } } })
      return Promise.resolve<RunResult>({ sessionId: 'desktop-pet', finalResponse: '看 ![x](https://x/a.png) 这张', events: [], notifications: [] })
    })
    const bridge = new DesktopPetBridge(harness)
    const reply: PetReply = await bridge.prompt('画个图')
    expect(reply.response).toBe('看 这张')
    expect(reply.images).toEqual(['https://x/a.png'])
  })
})
