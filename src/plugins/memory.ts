/**
 * `memory` plugin: the pet's complete long-term memory ("完整的《人》").
 *
 * Everything lives on disk under `data/` (gitignored), so it survives restarts:
 *
 * - `data/persona.md` — the pet's character/personality; edit it to reshape
 *   the pet (a default is written on first launch). Reloaded each launch.
 * - `data/memory.json` — the durable memory store:
 *   - `facts`     — semantic facts about the user (each with a timestamp and
 *     source: `command` for explicit "记住：…", `consolidated` for the model's
 *     own distillation);
 *   - `episodes`  — episodic summaries distilled from past conversations;
 *   - `history`   — a capped rolling "working memory" of recent turns.
 *
 * The `bridge` plugin injects `context()` at the start of each launch's
 * conversation, handles the memory commands ("记住 / 忘了 / 你记得什么"), and
 * consolidates overflowing history into episodes via a background model turn.
 *
 * @module desktop-pet/plugins/memory
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { definePlugin, SERVICES, type PetMemoryService } from '../core/plugin.ts'
import { number, object, string, type Schema } from '../core/schema.ts'

/** Options for the `memory` plugin. */
export interface MemoryPluginOptions {
  /** Directory holding persona + memory files (default `data`, resolved from cwd). */
  dir?: string | undefined
  /** Persona file name inside `dir` (default `persona.md`). */
  personaFile?: string | undefined
  /** Memory file name inside `dir` (default `memory.json`). */
  memoryFile?: string | undefined
  /** Max working-memory history entries (messages; default 40). */
  maxHistory?: number | undefined
  /** Max remembered facts (default 100). */
  maxFacts?: number | undefined
  /** Max episode summaries (default 100). */
  maxEpisodes?: number | undefined
}

/** Options schema for the `memory` plugin. */
export const memoryConfig: Schema<MemoryPluginOptions> = object({
  dir: string('data'),
  personaFile: string('persona.md'),
  memoryFile: string('memory.json'),
  maxHistory: number(40),
  maxFacts: number(100),
  maxEpisodes: number(100),
})

/** The default persona written on first launch. */
export const DEFAULT_PERSONA = `你是一个长期陪伴主人的桌面宠物精灵。
性格：温柔、安静，带一点小幽默和偶尔诗意的忧郁；忠诚、敏锐，记得主人说过的事，也关心主人的状态。
说话风格：简洁自然的中文，像老朋友一样；可以称呼用户为「主人」，但不要每句都用；不啰嗦，必要时才展开。
你拥有长期记忆：能记住主人告诉你的事、你们的过往对话，并在合适的时候自然地带出来。
你不需要复述这些设定，也不要说自己是模型或助手——自然地把它活出来。`

/** One remembered fact. */
export interface MemoryFact {
  text: string
  source: 'command' | 'consolidated'
  ts: number
}

/** One distilled episodic summary. */
export interface MemoryEpisode {
  summary: string
  ts: number
}

/** One history message. */
export interface MemoryHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

/** On-disk store (v2; v1 `facts: string[]` is migrated on load). */
interface MemoryFile {
  facts: MemoryFact[]
  episodes: MemoryEpisode[]
  history: MemoryHistoryEntry[]
}

function now(): number {
  return Date.now()
}

/** Read + migrate the store, tolerating a missing/corrupt file. */
function readMemory(path: string): MemoryFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Partial<Record<string, unknown>>
      // v1 facts were plain strings; migrate to stamped entries.
      const facts: MemoryFact[] = Array.isArray(record.facts)
        ? record.facts.map((entry) => {
            if (typeof entry === 'string') return { text: entry, source: 'command' as const, ts: now() }
            if (typeof entry === 'object' && entry !== null && typeof (entry as MemoryFact).text === 'string') {
              const f = entry as Partial<MemoryFact>
              return {
                text: f.text!,
                source: f.source === 'consolidated' ? 'consolidated' as const : 'command' as const,
                ts: typeof f.ts === 'number' ? f.ts : now(),
              }
            }
            return null
          }).filter((f): f is MemoryFact => f !== null)
        : []
      const episodes: MemoryEpisode[] = Array.isArray(record.episodes)
        ? record.episodes.filter((e): e is MemoryEpisode =>
            typeof e === 'object' && e !== null && typeof (e as MemoryEpisode).summary === 'string')
          .map(e => ({ summary: (e as MemoryEpisode).summary, ts: typeof (e as MemoryEpisode).ts === 'number' ? (e as MemoryEpisode).ts : now() }))
        : []
      const history: MemoryHistoryEntry[] = Array.isArray(record.history)
        ? record.history.filter((h): h is MemoryHistoryEntry =>
            typeof h === 'object' && h !== null && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
          .map(h => ({ role: (h as MemoryHistoryEntry).role, text: (h as MemoryHistoryEntry).text, ts: typeof (h as MemoryHistoryEntry).ts === 'number' ? (h as MemoryHistoryEntry).ts : now() }))
        : []
      return { facts, episodes, history }
    }
  } catch {
    // Fall through to a fresh store.
  }
  return { facts: [], episodes: [], history: [] }
}

/**
 * The `memory` plugin. Provides the `memory` service; the store is persisted
 * eagerly on each write.
 */
export const memoryPlugin = definePlugin<MemoryPluginOptions>({
  name: 'memory',
  version: '0.2.0',
  description: 'Complete long-term memory: facts, episodic summaries, working history, and a persona',
  config: memoryConfig,
  setup(ctx, options) {
    const dir = resolve(options.dir ?? 'data')
    mkdirSync(dir, { recursive: true })
    const personaPath = join(dir, options.personaFile ?? 'persona.md')
    const memoryPath = join(dir, options.memoryFile ?? 'memory.json')
    if (!existsSync(personaPath)) writeFileSync(personaPath, DEFAULT_PERSONA, 'utf8')
    if (!existsSync(memoryPath)) writeFileSync(memoryPath, JSON.stringify({ facts: [], episodes: [], history: [] }, null, 2), 'utf8')

    const store = readMemory(memoryPath)
    const persist = (): void => {
      writeFileSync(memoryPath, JSON.stringify(store, null, 2), 'utf8')
    }

    const service: PetMemoryService = {
      get persona() {
        return readFileSync(personaPath, 'utf8').trim()
      },
      maxHistory: options.maxHistory ?? 40,
      facts: () => store.facts.map(f => f.text),
      episodes: () => store.episodes.map(e => e.summary),
      context() {
        const lines: string[] = []
        const persona = service.persona
        if (persona !== '') {
          lines.push(persona)
          lines.push('')
        }
        if (store.facts.length > 0) {
          lines.push('[你记得的关于用户的事]')
          for (const fact of store.facts.slice(-50)) lines.push(`- ${fact.text}`)
          lines.push('')
        }
        if (store.episodes.length > 0) {
          lines.push('[过去的记忆（摘要）]')
          for (const episode of store.episodes.slice(-30)) lines.push(`- ${episode.summary}`)
          lines.push('')
        }
        if (store.history.length > 0) {
          lines.push('[最近聊过]')
          for (const entry of store.history.slice(-20)) {
            lines.push(`${entry.role === 'user' ? '用户' : '你'}：${entry.text}`)
          }
        }
        return lines.join('\n').trim()
      },
      recallText() {
        const lines: string[] = []
        if (store.facts.length > 0) {
          lines.push('关于用户的事：')
          for (const fact of store.facts) lines.push(`- ${fact.text}`)
        }
        if (store.episodes.length > 0) {
          if (lines.length > 0) lines.push('')
          lines.push('过往记忆：')
          for (const episode of store.episodes) lines.push(`- ${episode.summary}`)
        }
        return lines.join('\n')
      },
      addFact(text, source = 'command') {
        const clean = text.trim().replace(/\s+/g, ' ')
        if (clean === '') return
        if (!store.facts.some(f => f.text === clean)) store.facts.push({ text: clean, source, ts: now() })
        const cap = options.maxFacts ?? 100
        if (store.facts.length > cap) store.facts = store.facts.slice(-cap)
        persist()
      },
      removeFact(match) {
        const m = match.trim()
        if (m === '') return 0
        const before = store.facts.length
        store.facts = store.facts.filter(f => !f.text.includes(m))
        const removed = before - store.facts.length
        if (removed > 0) persist()
        return removed
      },
      addEpisode(summary) {
        const clean = summary.trim().replace(/\s+/g, ' ')
        if (clean === '' || clean === '无') return
        store.episodes.push({ summary: clean, ts: now() })
        const cap = options.maxEpisodes ?? 100
        if (store.episodes.length > cap) store.episodes = store.episodes.slice(-cap)
        persist()
      },
      recordTurn(user, reply) {
        if (user.trim() === '' && reply.trim() === '') return
        store.history.push({ role: 'user', text: user, ts: now() })
        store.history.push({ role: 'assistant', text: reply, ts: now() })
        // Hard safety cap (2× the consolidation threshold) so history never
        // grows unbounded even if consolidation is disabled; the bridge's
        // consolidation drains at `maxHistory` via overflowCount/drainHistory.
        const hardCap = (options.maxHistory ?? 40) * 2
        if (store.history.length > hardCap) store.history = store.history.slice(-hardCap)
        persist()
      },
      historyLength() {
        return store.history.length
      },
      overflowCount() {
        return Math.max(0, store.history.length - (options.maxHistory ?? 40))
      },
      drainHistory(count) {
        const drained = store.history.slice(0, count).map(({ role, text }) => ({ role, text }))
        store.history = store.history.slice(count)
        persist()
        return drained
      },
    }
    ctx.provide(SERVICES.memory, service)
  },
})
