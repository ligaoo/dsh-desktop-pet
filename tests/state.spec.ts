import { describe, expect, it } from 'vitest'
import type { HarnessNotification } from '../src/sdk.ts'
import { INITIAL_SNAPSHOT, reducePetNotification } from '../src/core/state.ts'
import type { PetSnapshot } from '../src/types.ts'

const SPEAKING: PetSnapshot = { mood: 'speaking', speech: 'hello', detail: null }

function status(status: string): HarnessNotification {
  return { method: 'session.status', params: { sessionId: 'desktop-pet', status } }
}

function sessionEvent(event: unknown): HarnessNotification {
  return { method: 'session.event', params: { sessionId: 'desktop-pet', event } }
}

describe('reducePetNotification', () => {
  it('starts from an idle snapshot with empty bubble', () => {
    expect(INITIAL_SNAPSHOT).toEqual({ mood: 'idle', speech: null, detail: null })
  })

  it('switches to thinking on session.status running and clears the bubble', () => {
    expect(reducePetNotification(SPEAKING, status('running')))
      .toEqual({ mood: 'thinking', speech: null, detail: null })
  })

  it('returns to idle on session.status idle and keeps the last reply', () => {
    expect(reducePetNotification(SPEAKING, status('idle')))
      .toEqual({ mood: 'idle', speech: 'hello', detail: null })
  })

  it('ignores unknown session statuses', () => {
    expect(reducePetNotification(SPEAKING, status('paused'))).toBe(SPEAKING)
  })

  it('ignores notifications that are not session events', () => {
    const notification: HarnessNotification = { method: 'subagent.started', params: { sessionId: 'child' } }
    expect(reducePetNotification(SPEAKING, notification)).toBe(SPEAKING)
  })

  it('ignores malformed session-event envelopes', () => {
    expect(reducePetNotification(SPEAKING, sessionEvent(undefined))).toBe(SPEAKING)
    expect(reducePetNotification(SPEAKING, sessionEvent('tool/call'))).toBe(SPEAKING)
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 42 }))).toBe(SPEAKING)
  })

  it('switches to thinking on turn/start', () => {
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'turn/start', data: { turn: 1 } })))
      .toEqual({ mood: 'thinking', speech: 'hello', detail: null })
  })

  it('switches to acting on tool/call and names the tool', () => {
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'tool/call', data: { name: 'bash' } })))
      .toEqual({ mood: 'acting', speech: 'hello', detail: 'bash' })
  })

  it('acts without a detail when tool/call carries no string name', () => {
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'tool/call', data: {} })))
      .toEqual({ mood: 'acting', speech: 'hello', detail: null })
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'tool/call' })))
      .toEqual({ mood: 'acting', speech: 'hello', detail: null })
  })

  it('switches to speaking on assistant/message with concatenated text', () => {
    const event = {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hel' }, { type: 'thinking', text: '…' }, { type: 'text', text: 'lo' }] } },
    }
    expect(reducePetNotification(INITIAL_SNAPSHOT, sessionEvent(event)))
      .toEqual({ mood: 'speaking', speech: 'hello', detail: null })
  })

  it('ignores assistant/message events without usable text', () => {
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'assistant/message', data: {} }))).toBe(SPEAKING)
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'assistant/message', data: { message: { content: 'nope' } } }))).toBe(SPEAKING)
    const empty = { type: 'assistant/message', data: { message: { content: [{ type: 'image', url: 'x' }] } } }
    expect(reducePetNotification(SPEAKING, sessionEvent(empty))).toBe(SPEAKING)
  })

  it('ignores unknown session-event types by identity', () => {
    expect(reducePetNotification(SPEAKING, sessionEvent({ type: 'todo/write', data: {} }))).toBe(SPEAKING)
  })
})
