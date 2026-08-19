/**
 * Shared types for the desktop pet: the rendered mood, the snapshot the pet
 * window consumes, and the harness surface the bridge drives.
 *
 * @module desktop-pet/types
 */

import type { HarnessNotification, RunResult } from './sdk.ts'

/** Visual mood the pet renders; one per agent activity class. */
export type PetMood = 'idle' | 'thinking' | 'acting' | 'speaking' | 'error'

/** Everything the pet window needs to render one frame. */
export interface PetSnapshot {
  /** Current activity class driving the animation. */
  mood: PetMood
  /** Latest assistant text for the speech bubble; null hides the bubble. */
  speech: string | null
  /** Short status detail such as the running tool's name; null when none. */
  detail: string | null
}

/** The session-handle surface {@link DesktopPetBridge} consumes. */
export interface PetHarnessSession {
  /** Stable wire session id. */
  readonly id: string
  /**
   * Queue one prompt and observe the session through its next idle.
   * @param input - prompt text.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string, options?: { onNotification?: (notification: HarnessNotification) => void }): Promise<RunResult>
}

/**
 * The SDK surface {@link DesktopPetBridge} drives; structurally satisfied by
 * `DeepSeekHarness` from the vendored SDK client (`./sdk.ts`).
 */
export interface PetHarness {
  /**
   * Start the runtime subprocess and perform the initialize handshake.
   * @returns settlement of the handshake.
   */
  start(): Promise<void>
  /**
   * Open (or reuse) the named session handle.
   * @param id - the wire session id.
   * @returns the session handle.
   */
  session(id: string): PetHarnessSession
  /**
   * Shut down and reap the runtime subprocess.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void>
}
