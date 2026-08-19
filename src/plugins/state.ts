/**
 * `state` plugin: the single source of truth for the pet snapshot. Folds the
 * harness notification stream (pure reducer from `core/state.ts`) and exposes
 * the current snapshot to any plugin through the `state` service, emitting
 * `state:changed` whenever it moves.
 *
 * The `bridge` plugin performs its own folding through `DesktopPetBridge`;
 * this plugin exists so external plugins can read the live snapshot without
 * reaching into the bridge.
 *
 * @module desktop-pet/plugins/state
 */

import { INITIAL_SNAPSHOT, reducePetNotification } from '../core/state.ts'
import { definePlugin, type PetSnapshotValue, type PetStateService } from '../core/plugin.ts'

/**
 * The `state` plugin. Provides the `state` service; no teardown work.
 */
export const statePlugin = definePlugin({
  name: 'state',
  version: '0.1.0',
  description: 'Owns the pet snapshot: folds notifications with the pure state machine',
  setup(ctx) {
    let snapshot: PetSnapshotValue = INITIAL_SNAPSHOT
    const service: PetStateService = {
      get snapshot() {
        return snapshot
      },
      reduce(notification) {
        const next = reducePetNotification(snapshot, notification as Parameters<typeof reducePetNotification>[1])
        if (next !== snapshot) {
          snapshot = next
          ctx.emit('state:changed', next)
        }
        return next
      },
      replace(next) {
        if (next.mood === snapshot.mood && next.speech === snapshot.speech && next.detail === snapshot.detail) return
        snapshot = next
        ctx.emit('state:changed', next)
      },
    }
    ctx.provide('state', service)
  },
})
