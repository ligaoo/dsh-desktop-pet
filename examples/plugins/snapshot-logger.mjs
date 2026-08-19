/**
 * Example external plugin: watches the pet's snapshots and logs mood changes.
 *
 * Everything is a plugin: drop this file (or any *.mjs/*.js exporting a
 * PetPlugin) into the `plugins/` directory of the project — or reference it
 * by path in desktop-pet.config.json — and it is loaded automatically.
 *
 * A plugin receives a PluginContext with:
 *   - ctx.on(event, handler) / ctx.emit(event, payload)  — the event bus
 *   - ctx.get(key) / ctx.provide(key, value)             — shared services
 *   - ctx.config                                         — merged options
 *   - ctx.logger                                         — namespaced logging
 * and may return a disposer for teardown (run in reverse start order).
 *
 * Built-in events: 'snapshot', 'state:changed', 'harness:closed', 'quit',
 * 'plugin:started' / 'plugin:disposed' / 'plugin:error'.
 * Built-in services: 'harness', 'pet' (prompt/snapshot/listen), 'state'.
 */

export default {
  name: 'snapshot-logger',
  version: '1.0.0',
  description: 'Logs every pet mood change to the console',
  setup(ctx) {
    const dispose = ctx.on('snapshot', (snapshot) => {
      const { mood, speech, detail } = snapshot
      ctx.logger.info(`mood -> ${mood}${detail !== null ? ` (${detail})` : ''}${speech !== null ? `: ${speech}` : ''}`)
    })
    return dispose
  },
}
