/**
 * The bridge between the pet window and one harness runtime: owns a
 * `DeepSeekHarness`-compatible client, serializes chat prompts onto a single
 * long-lived session, and republishes the wire notification stream as pet
 * snapshots. Electron-free — the Electron shell in the `window` plugin is a
 * thin IPC adapter over this class.
 *
 * @module desktop-pet/bridge
 */

import { INITIAL_SNAPSHOT, reducePetNotification } from './state.ts'
import type { HarnessNotification, RunResult } from '../sdk.ts'
import type { PetHarness, PetReply, PetSnapshot } from '../types.ts'

/** Options for {@link DesktopPetBridge}. */
export interface DesktopPetBridgeOptions {
  /** Stable session id; every pet chat shares one conversation (default `desktop-pet`). */
  sessionId?: string
  /**
   * Optional observer invoked with every root-session wire notification,
   * BEFORE it is folded into the snapshot. Lets callers react to raw events
   * the state machine ignores (e.g. `approval/asked`).
   */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One pet-to-runtime bridge. Listeners receive the snapshot only when it
 * actually changes; the initial snapshot is {@link INITIAL_SNAPSHOT}.
 */
export class DesktopPetBridge implements AsyncDisposable {
  private snapshotValue: PetSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<(snapshot: PetSnapshot) => void>()
  private readonly sessionId: string
  private readonly onNotification: ((notification: HarnessNotification) => void) | undefined
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * @param harness - the SDK harness driving the runtime subprocess.
   * @param options - session routing options.
   */
  constructor(private readonly harness: PetHarness, options: DesktopPetBridgeOptions = {}) {
    this.sessionId = options.sessionId ?? 'desktop-pet'
    this.onNotification = options.onNotification
  }

  /** The current pet snapshot. */
  get snapshot(): PetSnapshot {
    return this.snapshotValue
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - invoked with each changed snapshot, in publish order.
   * @returns the subscription's disposer.
   */
  listen(listener: (snapshot: PetSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Start the runtime subprocess (memoized by the harness handshake).
   * @returns settlement of the handshake.
   */
  start(): Promise<void> {
    return this.harness.start()
  }

  /**
   * Queue one chat prompt; prompts serialize so the session sees them one at a
   * time. The returned promise resolves with the activity interval's final
   * assistant text plus any images it produced, and rejects on transport loss
   * or a protocol error after publishing the `error` mood.
   * @param text - the user's message; blank text is a usage error.
   * @returns the final assistant response text and its images.
   */
  prompt(text: string): Promise<PetReply> {
    if (this.closed) return Promise.reject(new Error('desktop pet bridge is closed'))
    const trimmed = text.trim()
    if (trimmed === '') return Promise.reject(new Error('prompt text must be non-empty'))
    const run = this.tail.then(() => this.runOne(trimmed))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Close the bridge: settle the queued prompt, then reap the runtime.
   * Idempotent and terminal.
   * @returns settlement of the complete teardown.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.tail
    await this.harness.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** Publish a snapshot only when it differs from the current one. */
  private publish(next: PetSnapshot): void {
    const previous = this.snapshotValue
    if (previous.mood === next.mood && previous.speech === next.speech && previous.detail === next.detail) return
    this.snapshotValue = next
    for (const listener of this.listeners) listener(next)
  }

  /** Run one prompt on the shared session, folding its notifications into the snapshot. */
  private async runOne(text: string): Promise<PetReply> {
    const sessionId = this.sessionId
    // Streaming accumulator: `assistant/chunk` carries `text-delta` fragments
    // (not cumulative text), so the pet concatenates them into a live speech
    // bubble instead of waiting for the final `assistant/message`.
    let streamed = ''
    try {
      const result = await this.harness.session(sessionId).run(text, {
        onNotification: (notification) => {
          // The SDK streams the whole session tree; the pet renders only its
          // own root session, so descendant (subagent) ids are skipped here.
          if (notification.params.sessionId !== sessionId) return
          this.onNotification?.(notification)
          const event = notification.params.event
          if (isRecord(event) && event.type === 'assistant/chunk') {
            const chunk = isRecord(event.data) ? event.data.chunk : null
            if (isRecord(chunk) && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              streamed += chunk.text
              this.publish({ mood: 'speaking', speech: streamed, detail: null })
            }
            // Other chunk kinds (reasoning deltas, tool-call deltas, block
            // boundaries, finish) do not move the bubble; the final
            // `assistant/message` event carries the assembled text.
            return
          }
          // A new turn starts a fresh bubble; the running status also clears it.
          if (event !== undefined && isRecord(event) && event.type === 'turn/start') streamed = ''
          this.publish(reducePetNotification(this.snapshotValue, notification))
        },
      })
      return {
        response: stripMarkdownImages(result.finalResponse),
        images: collectImageSources(result),
      }
    } catch (error) {
      this.publish({ mood: 'error', speech: null, detail: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

/** Narrow an unknown wire value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Collect every renderable image source produced during a run. Images come
 * from two places:
 * - `assistant/message` and `assistant/chunk` (block-end) content blocks of
 *   `type: 'image'` — the multimodal output path;
 * - `![alt](src)` / `<img src="...">` markdown in the final reply text — a
 *   fallback for models that reference a generated image inline.
 *
 * Sources are deduplicated and empty/`undefined` candidates skipped. A block
 * that only carries an opaque attachment reference (no URL/bytes) is skipped,
 * because the pet cannot resolve raw bytes through the SDK wire.
 *
 * @param result - the activity interval's run result.
 * @returns renderable image sources in first-seen order.
 */
export function collectImageSources(result: RunResult): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  const add = (source: string | null): void => {
    if (source === null || source === '' || seen.has(source)) return
    seen.add(source)
    found.push(source)
  }
  for (const event of result.events) {
    if (event.type === 'assistant/chunk') {
      const data = isRecord(event.data) ? event.data : null
      const chunk = data !== null && isRecord(data.chunk) ? data.chunk : null
      if (chunk !== null && chunk.type === 'block-end') add(imageSourceOf(chunk.block))
    } else if (event.type === 'assistant/message') {
      const data = isRecord(event.data) ? event.data : null
      const message = data !== null && isRecord(data.message) ? data.message : null
      const content = message !== null && Array.isArray(message.content) ? message.content : null
      if (content === null) continue
      for (const block of content) {
        if (isRecord(block) && block.type === 'image') add(imageSourceOf(block))
      }
    }
  }
  for (const source of markdownImageSources(result.finalResponse)) add(source)
  return found
}

/**
 * Resolve a renderable source out of one `image` content block. Handles the
 * block shapes that carry a directly-displayable source (the SDK's
 * `imageUrl`/`image` fields) and common URL/base64 variants; a block that only
 * references an opaque attachment (no bytes) returns null.
 *
 * @param block - a content block, expected to be `{ type: 'image', ... }`.
 * @returns an image source URL, or null when none is renderable.
 */
export function imageSourceOf(block: unknown): string | null {
  if (!isRecord(block) || block.type !== 'image') return null
  for (const key of ['imageUrl', 'url', 'src']) {
    const value = block[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const image = block.image
  if (typeof image === 'string' && image !== '') return image
  if (isRecord(image)) {
    for (const key of ['url', 'src', 'imageUrl', 'data']) {
      const value = image[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  // A block carrying `data` + `mediaType` (base64 payload), or a full data URL.
  const data = typeof block.data === 'string' ? block.data : null
  if (data !== null) {
    if (data.startsWith('data:')) return data
    const mediaType = typeof block.mediaType === 'string' ? block.mediaType : null
    if (mediaType !== null) return `data:${mediaType};base64,${data}`
  }
  return null
}

/** Regex matching `![alt](src)` markdown image references. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

/** Regex matching `<img src="...">` / `<img src='...'>` HTML image tags. */
const HTML_IMAGE_RE = /<img[^>]+src=["']([^"']+)["']/gi

/** Extract every image source referenced by markdown/HTML in a reply text. */
function markdownImageSources(text: string): string[] {
  const sources: string[] = []
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const source = match[1]
    if (typeof source === 'string' && source !== '') sources.push(source)
  }
  for (const match of text.matchAll(HTML_IMAGE_RE)) {
    const source = match[1]
    if (typeof source === 'string' && source !== '') sources.push(source)
  }
  return sources
}

/** Remove markdown/HTML image references so the chat text does not show a
 * giant inline `data:` blob next to the rendered image. The reference and the
 * whitespace immediately around it collapse to a single space so the text
 * stays readable after a sentence-inline image is pulled out. */
function stripMarkdownImages(text: string): string {
  return text
    .replace(/\s*!\[[^\]]*\]\([^)\s]+\)\s*/g, ' ')
    .replace(/\s*<img[^>]+src=["'][^"']+["'][^>]*>\s*/gi, ' ')
    // Collapse the blank line a now-empty image reference leaves behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
