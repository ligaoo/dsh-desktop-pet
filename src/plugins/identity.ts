/**
 * `identity` plugin: gives the pet a name. Every other plugin reads it
 * through the `identity` service:
 *
 * - the `bridge` plugin injects the name into the session so the agent knows
 *   what the user calls it (first prompt of each pet launch);
 * - the `window` plugin uses it for the window title, the chat-panel header
 *   and the tray tooltip;
 * - external plugins can read it too (`ctx.get('identity')`).
 *
 * Set the name in the config file: `{ "name": "小蓝", ... }` — or the
 * plugin row `plugins.identity.name`.
 *
 * @module desktop-pet/plugins/identity
 */

import { definePlugin, type PetIdentityService } from '../core/plugin.ts'
import { object, string, type Schema } from '../core/schema.ts'

/** Options for the `identity` plugin. */
export interface IdentityPluginOptions {
  /** The pet's name (default `桌宠`). */
  name?: string | undefined
}

/** Options schema for the `identity` plugin. */
export const identityConfig: Schema<IdentityPluginOptions> = object({
  name: string('桌宠'),
})

/**
 * The `identity` plugin. Provides the `identity` service; no teardown work.
 */
export const identityPlugin = definePlugin<IdentityPluginOptions>({
  name: 'identity',
  version: '0.1.0',
  description: 'Provides the pet name to every other plugin',
  config: identityConfig,
  setup(ctx, options) {
    const service: PetIdentityService = { name: options.name ?? '桌宠' }
    ctx.provide('identity', service)
  },
})
