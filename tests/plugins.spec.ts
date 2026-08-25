import { describe, expect, it } from 'vitest'
import type { HarnessNotification, RunResult } from '../src/sdk.ts'
import { PetHost } from '../src/core/host.ts'
import { definePlugin, EVENTS, SERVICES } from '../src/core/plugin.ts'
import { bridgePlugin } from '../src/plugins/bridge.ts'
import { statePlugin } from '../src/plugins/state.ts'
import { runtimePlugin, buildRuntimeEnv, resolveRuntimeOptions } from '../src/plugins/runtime.ts'
import type { PetHarness, PetHarnessSession, PetSnapshot } from '../src/types.ts'

/** A fake harness injected instead of the real runtime plugin's subprocess. */
class FakeHarness implements PetHarness {
  calls: string[] = []
  closed = false
  constructor(private readonly replies: Record<string, string> = {}) {}
  start(): Promise<void> {
    return Promise.resolve()
  }
  session(id: string): PetHarnessSession {
    return {
      id,
      run: (input, options) => {
        this.calls.push(input)
        // The bridge stamps every prompt with a time note; strip it for the
        // canned-reply lookup so tests can map clean user texts.
        const stripped = input.replace(/^\[系统提示：当前时间[^\]]*\]\n\n/, '')
        const reply = this.replies[stripped] ?? `reply:${stripped}`
        const notify = (notification: HarnessNotification): void => options?.onNotification?.(notification)
        notify({ method: 'session.status', params: { sessionId: id, status: 'running' } })
        notify({ method: 'session.event', params: { sessionId: id, event: { type: 'tool/call', data: { name: 'bash' } } } })
        notify({ method: 'session.event', params: { sessionId: id, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } } } })
        notify({ method: 'session.status', params: { sessionId: id, status: 'idle' } })
        const result: RunResult = { sessionId: id, finalResponse: reply, events: [], notifications: [] }
        return Promise.resolve(result)
      },
    }
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** Register the built-in bridge/state plugins against a fake harness. */
function hostWithFakeHarness(fake: FakeHarness): PetHost {
  const host = new PetHost()
  // The bridge plugin requires a plugin named "runtime" providing "harness";
  // in tests a fake takes that role (the real runtime plugin would spawn a
  // subprocess, which is not wanted here).
  host.use(definePlugin({
    name: 'runtime',
    description: 'test double for the runtime plugin',
    setup(ctx) {
      ctx.provide<PetHarness>(SERVICES.harness, fake)
    },
  }))
  host.use(statePlugin)
  host.use(bridgePlugin)
  return host
}

describe('built-in plugin wiring', () => {
  it('bridges a prompt through the host and emits snapshots', async () => {
    const fake = new FakeHarness({ hi: 'hello there' })
    const host = hostWithFakeHarness(fake)
    const snapshots: PetSnapshot[] = []
    host.on(EVENTS.snapshot, snapshot => snapshots.push(snapshot as PetSnapshot))
    await host.start()

    const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
    await expect(pet.prompt('hi')).resolves.toEqual({ response: 'hello there', images: [] })
    expect(fake.calls[0]).toMatch(/^\[系统提示：当前时间 .+\]\n\nhi$/)
    expect(snapshots.map(snapshot => snapshot.mood)).toEqual(['thinking', 'acting', 'speaking', 'idle'])

    await host.dispose()
    expect(fake.closed).toBe(true)
  })

  it('exposes the live snapshot through the state service', async () => {
    const host = hostWithFakeHarness(new FakeHarness())
    const stateEvents: PetSnapshot[] = []
    host.on(EVENTS.stateChanged, snapshot => stateEvents.push(snapshot as PetSnapshot))
    await host.start()
    const state = host.get<import('../src/core/plugin.ts').PetStateService>(SERVICES.state)!
    expect(state.snapshot).toEqual({ mood: 'idle', speech: null, detail: null })
    state.reduce({ method: 'session.status', params: { sessionId: 'x', status: 'running' } })
    expect(state.snapshot.mood).toBe('thinking')
    expect(stateEvents.map(event => event.mood)).toEqual(['thinking'])
    await host.dispose()
  })

  it('resolves runtime options from the environment when unset', () => {
    const options = resolveRuntimeOptions({}, {
      DSH_PET_RUNTIME: 'node',
      DSH_PET_RUNTIME_ARGS: '["--import","tsx/esm"]',
      DSH_PET_CWD: '/work',
      DSH_PET_PROVIDER: 'custom',
      DSH_PET_MODEL: 'deepseek-v4-pro',
    })
    expect(options.command).toBe('node')
    expect(options.args).toEqual(['--import', 'tsx/esm'])
    expect(options.cwd).toBe('/work')
    expect(options.provider).toBe('custom')
    expect(options.model).toBe('deepseek-v4-pro')
  })

  it('keeps explicit runtime options over the environment', () => {
    const options = resolveRuntimeOptions({ command: 'from-config' }, { DSH_PET_RUNTIME: 'from-env' })
    expect(options.command).toBe('from-config')
  })

  it('emits approval:asked and turn:done host events from the bridge', async () => {
    const approvals: unknown[] = []
    const done: unknown[] = []
    const harness: PetHarness = {
      start: () => Promise.resolve(),
      session: (id) => ({
        id,
        run: (input, options) => {
          options?.onNotification?.({
            method: 'session.event',
            params: { sessionId: id, event: { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } } },
          })
          options?.onNotification?.({ method: 'session.status', params: { sessionId: id, status: 'idle' } })
          const result: RunResult = { sessionId: id, finalResponse: 'done', events: [], notifications: [] }
          return Promise.resolve(result)
        },
      }),
      close: () => Promise.resolve(),
    }
    const host = new PetHost()
    host.use(definePlugin({
      name: 'runtime',
      setup(ctx) {
        ctx.provide<PetHarness>(SERVICES.harness, harness)
      },
    }))
    host.use(bridgePlugin)
    host.on(EVENTS.approvalAsked, payload => approvals.push(payload))
    host.on(EVENTS.turnDone, payload => done.push(payload))
    await host.start()
    const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
    await pet.prompt('hi')
    expect(approvals).toEqual([{ id: 'a1', toolName: 'bash' }])
    expect(done).toEqual([{ reply: 'done', images: [] }])
    await host.dispose()
  })

  it('the runtime plugin is a plain object with the right contract', () => {
    expect(runtimePlugin.name).toBe('runtime')
    expect(runtimePlugin.requires).toBeUndefined()
    expect(typeof runtimePlugin.setup).toBe('function')
  })

  it('buildRuntimeEnv merges overrides onto the inherited env and injects the harness key', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'pet-env-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-from-store\n', 'utf8')
      const env = buildRuntimeEnv({ env: { EXTRA: '1' } }, {
        PATH: '/usr/bin',
        DSH_HOME: dir,
      })
      expect(env.PATH).toBe('/usr/bin')
      expect(env.EXTRA).toBe('1')
      expect(env.DEEPSEEK_API_KEY).toBe('sk-from-store')
      // Each launch gets its own session store so a stable session id never
      // collides with a previous launch's persisted log.
      expect(env.DSH_SESSION_ROOT).toBe(join(process.cwd(), '.sessions', String(process.pid)))
      // An ambient key wins over the store.
      const env2 = buildRuntimeEnv({}, { DSH_HOME: dir, DEEPSEEK_API_KEY: 'sk-ambient' })
      expect(env2.DEEPSEEK_API_KEY).toBe('sk-ambient')
      // An explicit DSH_SESSION_ROOT is honored.
      const env3 = buildRuntimeEnv({}, { DSH_SESSION_ROOT: 'C:/custom-sessions' })
      expect(env3.DSH_SESSION_ROOT).toBe('C:/custom-sessions')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('identity plugin provides the pet name and the bridge introduces it on the first prompt', async () => {
    const harness = new FakeHarness({ hi: 'hello' })
    const host = new PetHost()
    host.use(definePlugin({
      name: 'runtime',
      setup(ctx) {
        ctx.provide<PetHarness>(SERVICES.harness, harness)
      },
    }))
    host.use(statePlugin)
    host.use(bridgePlugin)
    const { identityPlugin } = await import('../src/plugins/identity.ts')
    host.use(identityPlugin, { name: '小蓝' })
    await host.start()

    const identity = host.get<import('../src/core/plugin.ts').PetIdentityService>(SERVICES.identity)!
    expect(identity.name).toBe('小蓝')

    const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
    await pet.prompt('hi')
    expect(harness.calls[0]).toContain('小蓝')
    expect(harness.calls[0]).toContain('hi')
    // The second prompt goes out verbatim (plus the time stamp).
    await pet.prompt('again')
    expect(harness.calls[1]).toMatch(/^\[系统提示：当前时间 .+\]\n\nagain$/)
    await host.dispose()
  })

  it('identity defaults to 桌宠 and the bridge skips the introduction', async () => {
    const harness = new FakeHarness({ hi: 'hello' })
    const host = new PetHost()
    host.use(definePlugin({
      name: 'runtime',
      setup(ctx) {
        ctx.provide<PetHarness>(SERVICES.harness, harness)
      },
    }))
    host.use(statePlugin)
    host.use(bridgePlugin)
    const { identityPlugin } = await import('../src/plugins/identity.ts')
    host.use(identityPlugin)
    await host.start()
    const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
    await pet.prompt('hi')
    expect(harness.calls[0]).toMatch(/^\[系统提示：当前时间 .+\]\n\nhi$/)
    await host.dispose()
  })

  it('stamps every prompt with the current local time (and can be disabled)', async () => {
    const { formatNow, buildTimeNote } = await import('../src/plugins/bridge.ts')
    expect(formatNow(new Date(2025, 7, 20, 14, 32, 45))).toBe('2025年8月20日 星期三 14:32:45')
    expect(buildTimeNote(new Date(2025, 7, 20, 14, 32, 45))).toContain('2025年8月20日 星期三 14:32:45')

    const fake = new FakeHarness({ hi: 'hello' })
    const host = hostWithFakeHarness(fake)
    await host.start()
    const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
    await pet.prompt('hi')
    expect(fake.calls[0]).toMatch(/^\[系统提示：当前时间 .+\]\n\nhi$/)
    // Every turn is stamped, not just the first one.
    await pet.prompt('again')
    expect(fake.calls[1]).toMatch(/^\[系统提示：当前时间 .+\]\n\nagain$/)
    await host.dispose()

    // timeNote: false sends the prompt through verbatim.
    const off = new FakeHarness({ hi: 'hello' })
    const hostOff = new PetHost()
    hostOff.use(definePlugin({
      name: 'runtime',
      setup(ctx) {
        ctx.provide<PetHarness>(SERVICES.harness, off)
      },
    }))
    hostOff.use(bridgePlugin, { timeNote: false })
    await hostOff.start()
    const petOff = hostOff.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
    await petOff.prompt('hi')
    expect(off.calls).toEqual(['hi'])
    await hostOff.dispose()
  })

  it('injects persona and memory on the first prompt and teaches facts via 记住', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'pet-bridge-mem-'))
    try {
      const harness = new FakeHarness({ hi: 'hello' })
      const host = new PetHost()
      host.use(definePlugin({
        name: 'runtime',
        setup(ctx) {
          ctx.provide<PetHarness>(SERVICES.harness, harness)
        },
      }))
      const { identityPlugin } = await import('../src/plugins/identity.ts')
      const { memoryPlugin } = await import('../src/plugins/memory.ts')
      host.use(identityPlugin, { name: '小蓝' })
      host.use(memoryPlugin, { dir })
      host.use(statePlugin)
      host.use(bridgePlugin)
      await host.start()

      const memory = host.get<import('../src/core/plugin.ts').PetMemoryService>(SERVICES.memory)!
      memory.addFact('用户喜欢猫')
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('你好')
      expect(harness.calls[0]).toContain('小蓝')
      expect(harness.calls[0]).toContain('桌面宠物精灵')
      expect(harness.calls[0]).toContain('用户喜欢猫')
      expect(harness.calls[0]).toContain('你好')

      // Later prompts go out verbatim (plus the time stamp).
      await pet.prompt('再说一遍')
      expect(harness.calls[1]).toMatch(/^\[系统提示：当前时间 .+\]\n\n再说一遍$/)

      // "记住：…" teaches a persistent fact.
      await pet.prompt('记住：我喜欢喝咖啡')
      expect(memory.facts()).toContain('我喜欢喝咖啡')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists user images to the workspace and references the paths in the prompt', async () => {
    const { mkdtemp, rm, readdir, readFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'pet-bridge-img-'))
    try {
      const fake = new FakeHarness({ '看一下': '看到了' })
      const host = new PetHost()
      host.use(definePlugin({
        name: 'runtime',
        description: 'test double providing a harness and a workspace dir',
        setup(ctx) {
          ctx.provide<PetHarness>(SERVICES.harness, fake)
          ctx.provide<string>(SERVICES.workspace, dir)
        },
      }))
      host.use(statePlugin)
      host.use(bridgePlugin)
      await host.start()
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      // 1x1 transparent PNG.
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      const reply = await pet.prompt('看一下', [{ dataUrl }])
      expect(typeof reply.response).toBe('string')
      expect(reply.response.length).toBeGreaterThan(0)

      const files = await readdir(join(dir, 'pet-uploads'))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^img-.*\.png$/)
      const bytes = await readFile(join(dir, 'pet-uploads', files[0]!))
      expect(bytes.length).toBeGreaterThan(0)

      // The prompt the model received references the persisted file path.
      const lastCall = fake.calls[fake.calls.length - 1]!
      expect(lastCall).toContain('pet-uploads')
      expect(lastCall).toContain(files[0]!)
      expect(lastCall).toContain('主人发来 1 张图片')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
