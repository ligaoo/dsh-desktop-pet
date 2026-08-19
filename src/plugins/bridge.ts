/**
 * `bridge` plugin: the chat bridge between the pet and one harness runtime.
 * Wraps the Electron-free {@link DesktopPetBridge} core, publishes the `pet`
 * service, and re-emits snapshot changes as host `snapshot` events so the
 * window plugin (or any external plugin) can render them. It also surfaces
 * raw wire signals the state machine ignores: `turn:done` when a prompt
 * settles with a reply, and `approval:asked` when the runtime requests user
 * approval.
 *
 * @module desktop-pet/plugins/bridge
 */

import { DesktopPetBridge } from '../core/bridge.ts'
import { definePlugin, EVENTS, SERVICES, type PetService } from '../core/plugin.ts'
import { object, string, type Schema } from '../core/schema.ts'
import type { PetHarness } from '../types.ts'

/** Options for the `bridge` plugin. */
export interface BridgePluginOptions {
  /** Stable session id; every pet chat shares one conversation (default `desktop-pet`). */
  sessionId?: string | undefined
}

/** Options schema for the `bridge` plugin. */
export const bridgeConfig: Schema<BridgePluginOptions> = object({
  sessionId: string('desktop-pet'),
})

/** Extract `{ id, toolName }` from an `approval/asked` session event, or null when malformed. */
function approvalPayload(event: unknown): { id: unknown; toolName: unknown } | null {
  if (typeof event !== 'object' || event === null) return null
  const record = event as Record<string, unknown>
  const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : {}
  return { id: data['id'], toolName: data['toolName'] }
}

/**
 * The `bridge` plugin. Requires the `runtime` plugin (for the `harness`
 * service). Teardown closes the bridge, which settles the queued prompt and
 * reaps the runtime through the harness.
 */
export const bridgePlugin = definePlugin<BridgePluginOptions>({
  name: 'bridge',
  version: '0.1.0',
  description: 'Serializes chat prompts onto one session and folds notifications into snapshots',
  requires: ['runtime'],
  config: bridgeConfig,
  setup(ctx, options) {
    const harness = ctx.getOrThrow<PetHarness>('harness')
    const bridge = new DesktopPetBridge(harness, {
      ...options.sessionId !== undefined && { sessionId: options.sessionId },
      onNotification: (notification) => {
        const event = notification.params.event
        if (typeof event === 'object' && event !== null && (event as Record<string, unknown>).type === 'approval/asked') {
          const payload = approvalPayload(event)
          ctx.emit(EVENTS.approvalAsked, payload ?? { id: undefined, toolName: undefined })
        }
      },
    })
    const disposeListen = bridge.listen((snapshot) => ctx.emit(EVENTS.snapshot, snapshot))
    // On the first prompt of each launch, inject the pet's identity, persona,
    // and long-term memory so the conversation starts from a remembered self.
    let memorySent = false
    let consolidating = false

    /** Distill overflowing working history into an episode via a separate session. */
    const maybeConsolidate = async (): Promise<void> => {
      const memory = ctx.get<import('../core/plugin.ts').PetMemoryService>(SERVICES.memory)
      if (memory === undefined || consolidating) return
      const overflow = memory.overflowCount()
      if (overflow <= 0) return
      consolidating = true
      try {
        const drained = memory.drainHistory(overflow)
        const transcript = drained.map(e => `${e.role === 'user' ? '用户' : '你'}：${e.text}`).join('\n')
        const prompt = [
          '请把下面这段对话整理成长期记忆要点。只输出要点本身，每行一条，',
          '用第三人称（「用户」/「宠物」）简洁记录用户透露的信息、偏好、约定和重要事件；',
          '省略寒暄与无关细节。若没有值得长期记住的内容，只输出「无」。',
          '',
          '[对话]',
          transcript,
        ].join('\n')
        const result = await harness.session(`${options.sessionId ?? 'desktop-pet'}-memory`).run(prompt)
        memory.addEpisode(result.finalResponse)
      } catch (error) {
        ctx.logger.warn('memory consolidation failed: %s', error instanceof Error ? error.message : String(error))
      } finally {
        consolidating = false
      }
    }

    const service: PetService = {
      prompt: async (text) => {
        const memory = ctx.get<import('../core/plugin.ts').PetMemoryService>(SERVICES.memory)
        const trimmed = text.trim()

        // --- Memory commands (handled in-band; the message still reaches the model).
        if (memory !== undefined) {
          // "记住：X" / "请记住：X" / "帮我记住：X" / "别忘了：X"
          const taught = /^(?:请|帮我)?(?:记住|别忘了)[:：]\s*(.+)$/.exec(trimmed)
          if (taught !== null) memory.addFact(taught[1]!, 'command')
          // "忘了：X" / "忘记：X"
          const forgotten = /^(?:请|帮我)?(?:忘了|忘记)[:：]\s*(.+)$/.exec(trimmed)
          if (forgotten !== null) memory.removeFact(forgotten[1]!)
        }
        // "你记得什么" → force-inject the current facts/episodes so the model can recite.
        const recalling = /你(?:都)?记得(?:什么|哪些|哪些事)|你的记忆|你记住了什么/.test(trimmed)

        let input = text
        if (!memorySent || recalling) {
          if (!recalling) memorySent = true
          const identity = ctx.get<import('../core/plugin.ts').PetIdentityService>(SERVICES.identity)?.name
          const parts: string[] = []
          if (!recalling && identity !== undefined && identity !== '' && identity !== '桌宠') {
            parts.push(`你的名字叫「${identity}」，用户会这样称呼你。`)
          }
          if (memory !== undefined) {
            if (recalling) {
              const recall = memory.recallText()
              parts.push(recall === '' ? '你还没有任何长期记忆。' : `[你目前记得的]：\n${recall}`)
            } else {
              const context = memory.context()
              if (context !== '') parts.push(context)
            }
          }
          if (parts.length > 0) {
            input = `[系统设定与长期记忆，请自然地活出来，不要复述。]\n${parts.join('\n\n')}\n\n[用户现在说：]\n${text}`
          }
        }

        const reply = await bridge.prompt(input)
        if (memory !== undefined) {
          memory.recordTurn(text, reply)
          void maybeConsolidate()
        }
        if (reply !== '') ctx.emit(EVENTS.turnDone, { reply })
        return reply
      },
      get snapshot() {
        return bridge.snapshot
      },
      listen: (listener) => bridge.listen(listener),
    }
    ctx.provide('pet', service)
    return async () => {
      disposeListen()
      await bridge.close()
    }
  },
})
