import { describe, expect, it } from 'vitest'
import { definePlugin, type PetPlugin } from '../src/core/plugin.ts'
import { PetHost } from '../src/core/host.ts'
import { object, string } from '../src/core/schema.ts'

/** A plugin that records its lifecycle calls on a shared ledger. */
function recorder(name: string, options: { requires?: string[]; optional?: string[]; failSetup?: boolean; failDispose?: boolean; setupError?: string } = {}): PetPlugin {
  return definePlugin({
    name,
    requires: options.requires,
    optional: options.optional,
    setup(ctx) {
      if (options.failSetup === true) throw new Error(options.setupError ?? `${name} setup boom`)
      ctx.provide(`service:${name}`, `value:${name}`)
      return () => {
        if (options.failDispose === true) throw new Error(`${name} dispose boom`)
        ctx.emit('disposed', name)
      }
    },
  })
}

describe('PetHost', () => {
  it('starts plugins in registration order and disposes in reverse', async () => {
    const host = new PetHost()
    const order: string[] = []
    host.on('disposed', (name) => order.push(`dispose:${String(name)}`))
    host.use(recorder('a'))
    host.use(recorder('b'))
    host.use(recorder('c'))
    await host.start()
    expect(host.startOrder).toEqual(['a', 'b', 'c'])
    await host.dispose()
    expect(order).toEqual(['dispose:c', 'dispose:b', 'dispose:a'])
  })

  it('orders by requires edges', async () => {
    const host = new PetHost()
    host.use(recorder('window', { requires: ['bridge'] }))
    host.use(recorder('state'))
    host.use(recorder('bridge', { requires: ['runtime'] }))
    host.use(recorder('runtime'))
    await host.start()
    // Every requirement must run before its dependents.
    const order = host.startOrder
    expect(order).toEqual(['runtime', 'bridge', 'window', 'state'])
    expect(order.indexOf('runtime')).toBeLessThan(order.indexOf('bridge'))
    expect(order.indexOf('bridge')).toBeLessThan(order.indexOf('window'))
  })

  it('throws when a required plugin is missing', async () => {
    const host = new PetHost()
    host.use(recorder('a', { requires: ['ghost'] }))
    await expect(host.start()).rejects.toThrow(/requires "ghost"/)
  })

  it('throws on dependency cycles', async () => {
    const host = new PetHost()
    host.use(recorder('a', { requires: ['b'] }))
    host.use(recorder('b', { requires: ['a'] }))
    await expect(host.start()).rejects.toThrow(/dependency cycle/)
  })

  it('skips a failed setup but keeps the rest running', async () => {
    const host = new PetHost()
    const started: string[] = []
    host.on('plugin:started', (payload) => started.push((payload as { name: string }).name))
    host.use(recorder('ok1'))
    host.use(recorder('bad', { failSetup: true }))
    host.use(recorder('ok2'))
    await host.start()
    expect(started).toEqual(['ok1', 'ok2'])
  })

  it('aborts when a fatal plugin fails', async () => {
    const host = new PetHost({ fatalPlugins: ['bad'] })
    host.use(recorder('ok1'))
    host.use(recorder('bad', { failSetup: true }))
    await expect(host.start()).rejects.toThrow('bad setup boom')
  })

  it('shares services between plugins', async () => {
    const host = new PetHost()
    let seen: string | undefined
    host.use(definePlugin({
      name: 'provider',
      setup(ctx) {
        ctx.provide('greeting', 'hello')
      },
    }))
    host.use(definePlugin({
      name: 'consumer',
      requires: ['provider'],
      setup(ctx) {
        seen = ctx.getOrThrow<string>('greeting')
        expect(ctx.get<string>('missing')).toBeUndefined()
      },
    }))
    await host.start()
    expect(seen).toBe('hello')
  })

  it('dispose is idempotent and clears the start order', async () => {
    const host = new PetHost()
    host.use(recorder('a'))
    await host.start()
    await host.dispose()
    await host.dispose()
    expect(host.startOrder).toEqual([])
  })

  it('emits lifecycle events', async () => {
    const host = new PetHost()
    const events: string[] = []
    host.on('plugin:started', (payload) => events.push(`started:${(payload as { name: string }).name}`))
    host.on('plugin:disposed', (payload) => events.push(`disposed:${(payload as { name: string }).name}`))
    host.use(recorder('a'))
    await host.start()
    await host.dispose()
    expect(events).toEqual(['started:a', 'disposed:a'])
  })

  it('validates plugin options through the config schema', async () => {
    const host = new PetHost()
    expect(() => host.use(definePlugin({
      name: 'typed',
      config: object({ greeting: string('hi') }),
      setup(ctx, config) {
        ctx.provide('greeting', config.greeting)
      },
    }), { greeting: 42 } as unknown as Record<string, unknown>)).toThrow(/plugin "typed" options are invalid/)
  })

  it('rejects registering after start', async () => {
    const host = new PetHost()
    await host.start()
    expect(() => host.use(recorder('late'))).toThrow(/after start/)
  })
})
