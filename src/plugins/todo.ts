/**
 * `todo` plugin: the pet's todo list ("待办"). Everything lives on disk under
 * `data/` (gitignored), so it survives restarts:
 *
 * - `data/todos.json` — the durable todo store:
 *   - `items` — todo entries, each with a stable `id`, `text`, `done` flag,
 *     `createdAt`, and `completedAt`.
 *
 * The `bridge` plugin handles the chat commands in-band ("记个待办：X",
 * "查看待办", "完成待办：X", "删除待办：X", "清空待办") and the `window`
 * plugin exposes the same service over IPC for the pet's built-in todo panel.
 * Every mutation emits the host `todo:changed` event with the full list, so
 * the panel and any external plugin stay in sync live.
 *
 * @module desktop-pet/plugins/todo
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { definePlugin, EVENTS, SERVICES, type PetTodoService, type TodoItem } from '../core/plugin.ts'
import { boolean, number, object, string, type Schema } from '../core/schema.ts'

/** Options for the `todo` plugin. */
export interface TodoPluginOptions {
  /** Directory holding the todo file (default `data`, resolved from cwd). */
  dir?: string | undefined
  /** Todo file name inside `dir` (default `todos.json`). */
  file?: string | undefined
  /** Max number of kept todos (open + done; default 200). */
  maxItems?: number | undefined
  /**
   * Auto-record todos from casual conversation (default true): the bridge
   * watches for plan/reminder phrasing such as "我明天要交周报" / "别忘了买牛奶"
   * and records a todo without needing an explicit command.
   */
  autoRecord?: boolean | undefined
}

/** Options schema for the `todo` plugin. */
export const todoConfig: Schema<TodoPluginOptions> = object({
  dir: string('data'),
  file: string('todos.json'),
  maxItems: number(200),
  autoRecord: boolean(true),
})

/** On-disk store. */
interface TodoFile {
  items: TodoItem[]
}

function now(): number {
  return Date.now()
}

/** Read the store, tolerating a missing/corrupt file. */
function readTodo(path: string): TodoFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Partial<Record<string, unknown>>
      const items: TodoItem[] = Array.isArray(record.items)
        ? record.items.filter((item): item is TodoItem =>
            typeof item === 'object' && item !== null
            && typeof (item as TodoItem).id === 'string'
            && typeof (item as TodoItem).text === 'string'
            && typeof (item as TodoItem).done === 'boolean')
          .map(item => ({
            id: (item as TodoItem).id,
            text: (item as TodoItem).text,
            done: (item as TodoItem).done,
            createdAt: typeof (item as TodoItem).createdAt === 'number' ? (item as TodoItem).createdAt : now(),
            completedAt: typeof (item as TodoItem).completedAt === 'number' ? (item as TodoItem).completedAt : null,
          }))
        : []
      return { items }
    }
  } catch {
    // Fall through to a fresh store.
  }
  return { items: [] }
}

/**
 * The `todo` plugin. Provides the `todo` service; the store is persisted
 * eagerly on each write and every mutation emits `todo:changed`.
 */
export const todoPlugin = definePlugin<TodoPluginOptions>({
  name: 'todo',
  version: '0.1.0',
  description: 'A persistent todo list: record, view, complete, and delete todos from chat or the built-in panel',
  config: todoConfig,
  setup(ctx, options) {
    const dir = resolve(options.dir ?? 'data')
    mkdirSync(dir, { recursive: true })
    const todoPath = join(dir, options.file ?? 'todos.json')
    if (!existsSync(todoPath)) writeFileSync(todoPath, JSON.stringify({ items: [] }, null, 2), 'utf8')

    const store = readTodo(todoPath)
    const persist = (): void => {
      writeFileSync(todoPath, JSON.stringify(store, null, 2), 'utf8')
    }
    /** Trim to the configured cap (keeps the newest items). */
    const trim = (): void => {
      const cap = options.maxItems ?? 200
      if (store.items.length > cap) store.items = store.items.slice(0, cap)
    }
    /** Normalize a todo text: trimmed, whitespace collapsed, non-empty. */
    const clean = (text: string): string => text.trim().replace(/\s+/g, ' ')
    const notify = (): void => {
      ctx.emit(EVENTS.todoChanged, service.list())
    }
    /** Match an item by exact id first, then by text substring. */
    const matches = (item: TodoItem, match: string): boolean =>
      item.id === match || item.text.toLowerCase().includes(match.toLowerCase())

    const service: PetTodoService = {
      autoRecord: options.autoRecord ?? true,
      list() {
        // Most recently added first, so a fresh todo lands on top.
        return [...store.items].sort((a, b) => b.createdAt - a.createdAt)
      },
      add(text) {
        const cleaned = clean(text)
        if (cleaned === '') throw new Error('todo text must be non-empty')
        const existing = store.items.find(item => !item.done && item.text === cleaned)
        if (existing !== undefined) return { ...existing }
        const item: TodoItem = { id: randomUUID(), text: cleaned, done: false, createdAt: now(), completedAt: null }
        store.items.push(item)
        trim()
        persist()
        notify()
        return { ...item }
      },
      toggle(id) {
        const item = store.items.find(candidate => candidate.id === id)
        if (item === undefined) return undefined
        item.done = !item.done
        item.completedAt = item.done ? now() : null
        persist()
        notify()
        return { ...item }
      },
      complete(match) {
        const target = match.trim()
        if (target === '') return 0
        const changed = store.items.filter(item => !item.done && matches(item, target))
        for (const item of changed) {
          item.done = true
          item.completedAt = now()
        }
        if (changed.length > 0) {
          persist()
          notify()
        }
        return changed.length
      },
      uncomplete(match) {
        const target = match.trim()
        if (target === '') return 0
        const changed = store.items.filter(item => item.done && matches(item, target))
        for (const item of changed) {
          item.done = false
          item.completedAt = null
        }
        if (changed.length > 0) {
          persist()
          notify()
        }
        return changed.length
      },
      remove(match) {
        const target = match.trim()
        if (target === '') return 0
        const before = store.items.length
        store.items = store.items.filter(item => !matches(item, target))
        const removed = before - store.items.length
        if (removed > 0) {
          persist()
          notify()
        }
        return removed
      },
      clear() {
        const removed = store.items.length
        if (removed === 0) return 0
        store.items = []
        persist()
        notify()
        return removed
      },
      openCount() {
        return store.items.filter(item => !item.done).length
      },
      listText() {
        // Same order as list(): newest first.
        const ordered = service.list()
        const open = ordered.filter(item => !item.done)
        const done = ordered.filter(item => item.done)
        const lines: string[] = []
        if (open.length > 0) {
          lines.push(`未完成（${open.length} 条）：`)
          open.forEach((item, index) => lines.push(`${index + 1}. ${item.text}`))
        }
        if (done.length > 0) {
          if (lines.length > 0) lines.push('')
          lines.push(`已完成（${done.length} 条）：`)
          for (const item of done) lines.push(`- ${item.text}`)
        }
        return lines.join('\n')
      },
      listen(listener) {
        const handler = (items: TodoItem[]): void => listener(items)
        return ctx.on(EVENTS.todoChanged, handler)
      },
    }
    // `service` closes over `notify`, which references `service`; both are
    // assigned before any mutation can run, so the cycle is safe.
    ctx.provide(SERVICES.todo, service)
  },
})
