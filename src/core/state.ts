/**
 * Pure pet state machine: folds the harness notification stream into the
 * snapshot the pet window renders. No I/O — every transition is a function of
 * the current snapshot and one wire notification, so the whole behavior is
 * unit-testable without a runtime or a display.
 *
 * @module desktop-pet/state
 */

import type { HarnessNotification } from '../sdk.ts'
import type { PetSnapshot } from '../types.ts'

/** Snapshot before any notification arrives: idle pet, empty bubble. */
export const INITIAL_SNAPSHOT: PetSnapshot = { mood: 'idle', speech: null, detail: null }

/** Narrow an unknown wire value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Extract the concatenated text of an `assistant/message` event, or null when malformed or empty. */
function assistantText(event: Record<string, unknown>): string | null {
  const data = isRecord(event.data) ? event.data : null
  const message = data !== null && isRecord(data.message) ? data.message : null
  const content = message !== null && Array.isArray(message.content) ? message.content : null
  if (content === null) return null
  let text = ''
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    text += block.text
  }
  return text === '' ? null : text
}

/**
 * Fold one wire notification into the pet snapshot. Notifications that carry
 * no pet-visible meaning — unknown methods, unknown session-event types of the
 * merge-extensible session log, malformed envelopes — leave the snapshot
 * untouched (returned by identity).
 * @param snapshot - the current pet snapshot.
 * @param notification - one notification as received off the SDK wire.
 * @returns the next pet snapshot.
 */
export function reducePetNotification(snapshot: PetSnapshot, notification: HarnessNotification): PetSnapshot {
  if (notification.method === 'session.status') {
    const status = notification.params.status
    if (status === 'running') return { mood: 'thinking', speech: null, detail: null }
    // Idle keeps the last reply in the bubble so it stays readable after the turn.
    if (status === 'idle') return { ...snapshot, mood: 'idle', detail: null }
    return snapshot
  }
  if (notification.method !== 'session.event') return snapshot
  const event = notification.params.event
  if (!isRecord(event) || typeof event.type !== 'string') return snapshot
  switch (event.type) {
    case 'turn/start':
      return { ...snapshot, mood: 'thinking', detail: null }
    case 'tool/call': {
      const name = isRecord(event.data) && typeof event.data.name === 'string' ? event.data.name : null
      return { ...snapshot, mood: 'acting', detail: name }
    }
    case 'assistant/message': {
      const text = assistantText(event)
      return text === null ? snapshot : { mood: 'speaking', speech: text, detail: null }
    }
    default:
      return snapshot
  }
}
