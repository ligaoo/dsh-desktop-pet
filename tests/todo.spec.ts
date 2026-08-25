import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetHost } from '../src/core/host.ts'
import { SERVICES, definePlugin } from '../src/core/plugin.ts'
import { todoPlugin } from '../src/plugins/todo.ts'
import { bridgePlugin, detectBulkTodoList, extractTodoHeuristic } from '../src/plugins/bridge.ts'
import type { HarnessNotification, RunResult } from '../src/sdk.ts'
import type { PetHarness, PetHarnessSession } from '../src/types.ts'
import type { PetTodoService } from '../src/core/plugin.ts'

async function hostWithTodo(dir: string, extra: Record<string, unknown> = {}): Promise<PetHost> {
  const host = new PetHost()
  host.use(todoPlugin, { dir, ...extra })
  await host.start()
  return host
}

function todoOf(host: PetHost): PetTodoService {
  return host.get<PetTodoService>(SERVICES.todo)!
}

/** A fake harness that records every prompt input (like tests/plugins.spec.ts). */
class FakeHarness implements PetHarness {
  calls: string[] = []
  closed = false
  constructor(
    private readonly replies: Record<string, string> = {},
    private readonly onInput?: (input: string) => string | undefined,
  ) {}
  start(): Promise<void> {
    return Promise.resolve()
  }
  session(id: string): PetHarnessSession {
    return {
      id,
      run: (input, options) => {
        this.calls.push(input)
        const reply = this.onInput?.(input) ?? this.replies[input] ?? `reply:${input}`
        const notify = (notification: HarnessNotification): void => options?.onNotification?.(notification)
        notify({ method: 'session.status', params: { sessionId: id, status: 'running' } })
        notify({ method: 'session.event', params: { sessionId: id, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } } } })
        notify({ method: 'session.status', params: { sessionId: id, status: 'idle' } })
        const result: RunResult = { sessionId: id, finalResponse: reply, events: [], notifications: [] }
        return Promise.resolve(result)
      },
    }
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** Host with the todo plugin + a bridge against a fake harness. */
function hostWithTodoAndBridge(dir: string, fake: FakeHarness, todoOptions: Record<string, unknown> = {}): PetHost {
  const host = new PetHost()
  host.use(definePlugin({
    name: 'runtime',
    description: 'test double for the runtime plugin',
    setup(ctx) {
      ctx.provide<PetHarness>(SERVICES.harness, fake)
    },
  }))
  host.use(todoPlugin, { dir, ...todoOptions })
  host.use(bridgePlugin)
  return host
}

describe('todo plugin', () => {
  it('creates an empty todos.json on first launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      await hostWithTodo(dir)
      const file = JSON.parse(await readFile(join(dir, 'todos.json'), 'utf8'))
      expect(file).toEqual({ items: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists todos across host instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const host1 = await hostWithTodo(dir)
      const todo1 = todoOf(host1)
      const added = todo1.add('下午3点开会')
      todo1.add('买牛奶')
      todo1.complete('开会')
      await host1.dispose()

      const host2 = await hostWithTodo(dir)
      const todo2 = todoOf(host2)
      const items = todo2.list()
      expect(items).toHaveLength(2)
      expect(items.find(item => item.id === added.id)?.done).toBe(true)
      expect(todo2.openCount()).toBe(1)
      await host2.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates open items with the same text but allows re-adding a done one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const host = await hostWithTodo(dir)
      const todo = todoOf(host)
      const first = todo.add('买牛奶')
      const second = todo.add('  买牛奶  ')
      expect(second.id).toBe(first.id)
      expect(todo.list()).toHaveLength(1)

      todo.complete('买牛奶')
      const third = todo.add('买牛奶')
      expect(third.id).not.toBe(first.id)
      expect(todo.list()).toHaveLength(2)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('completes, uncompletes, removes, and clears by id or text match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const host = await hostWithTodo(dir)
      const todo = todoOf(host)
      const a = todo.add('写周报')
      todo.add('给妈妈打电话')

      // Complete by text substring.
      expect(todo.complete('周报')).toBe(1)
      expect(todo.list().find(item => item.id === a.id)?.done).toBe(true)
      expect(todo.openCount()).toBe(1)

      // Uncomplete by exact id.
      expect(todo.uncomplete(a.id)).toBe(1)
      expect(todo.openCount()).toBe(2)

      // Remove by exact id removes exactly one item.
      expect(todo.remove(a.id)).toBe(1)
      expect(todo.list()).toHaveLength(1)

      // Clear removes everything.
      expect(todo.clear()).toBe(1)
      expect(todo.list()).toHaveLength(0)
      expect(todo.clear()).toBe(0)

      // No-op matches return 0.
      expect(todo.complete('不存在的')).toBe(0)
      expect(todo.remove('不存在的')).toBe(0)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists newest first and formats listText with open and done sections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const host = await hostWithTodo(dir)
      const todo = todoOf(host)
      todo.add('第一条')
      todo.add('第二条')
      const text = todo.listText()
      expect(text).toContain('未完成（2 条）')
      expect(text.indexOf('第二条')).toBeLessThan(text.indexOf('第一条'))
      expect(text).not.toContain('已完成')

      todo.complete('第一条')
      const text2 = todo.listText()
      expect(text2).toContain('未完成（1 条）')
      expect(text2).toContain('已完成（1 条）')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('notifies listeners with the full list on every mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const host = await hostWithTodo(dir)
      const todo = todoOf(host)
      const seen: string[][] = []
      const dispose = todo.listen(items => seen.push(items.map(item => item.text)))
      todo.add('买牛奶')
      todo.complete('买牛奶')
      todo.remove('买牛奶')
      expect(seen).toEqual([['买牛奶'], ['买牛奶'], []])
      dispose()
      todo.add('不会再通知')
      expect(seen).toHaveLength(3)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('todo chat commands (bridge)', () => {
  it('records a todo from 记个待办, completes it with 完成待办, and deletes with 删除待办', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!

      await pet.prompt('记个待办：下午3点开会')
      expect(todo.list().map(item => item.text)).toContain('下午3点开会')

      await pet.prompt('完成待办：开会')
      expect(todo.list().find(item => item.text === '下午3点开会')?.done).toBe(true)

      await pet.prompt('删除待办：开会')
      expect(todo.list()).toHaveLength(0)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('injects the todo list into the model when the user asks to view todos', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness({ '查看待办': '你目前有：1. 买牛奶' })
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      todo.add('买牛奶')
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!

      const reply = await pet.prompt('查看待办')
      expect(reply.response).toContain('买牛奶')
      const lastCall = fake.calls[fake.calls.length - 1]!
      expect(lastCall).toContain('买牛奶')
      expect(lastCall).toContain('主人目前的待办清单')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clears all todos with 清空待办', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      todo.add('买牛奶')
      todo.add('写周报')
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('清空待办')
      expect(todo.list()).toHaveLength(0)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('auto-records casual plans and reminders from conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!

      await pet.prompt('我明天要交周报')
      expect(todo.list().map(item => item.text)).toContain('交周报')

      await pet.prompt('别忘了给妈妈打电话')
      expect(todo.list().map(item => item.text)).toContain('给妈妈打电话')

      await pet.prompt('明天得去银行')
      expect(todo.list().map(item => item.text)).toContain('去银行')

      await pet.prompt('该写周报了')
      expect(todo.list().map(item => item.text)).toContain('写周报')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never auto-records questions, pet requests, recall, or recollection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!

      await pet.prompt('你明天要做什么？')       // question
      await pet.prompt('帮我查一下明天的天气')     // pet request
      await pet.prompt('你记得什么')              // recall command
      await pet.prompt('我记得你上次说喜欢猫')     // recollection
      expect(todo.list()).toHaveLength(0)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not double-record an explicit 记个待办 command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('记个待办：买牛奶')
      const items = todo.list()
      expect(items).toHaveLength(1)
      expect(items[0]!.text).toBe('买牛奶')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tells the model when a todo was auto-recorded so it can confirm', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('我明天要交周报')
      const lastCall = fake.calls[fake.calls.length - 1]!
      expect(lastCall).toContain('交周报')
      expect(lastCall).toContain('待办清单')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('respects todo.autoRecord: false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness()
      const host = hostWithTodoAndBridge(dir, fake, { autoRecord: false })
      await host.start()
      const todo = todoOf(host)
      expect(todo.autoRecord).toBe(false)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('我明天要交周报')
      expect(todo.list()).toHaveLength(0)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('extracts a numbered list into separate todos via the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness({}, (input) =>
        input.includes('请把下面这段文字里的待办事项逐条提取出来')
          ? 'token消耗\n生图、米塔api\n案例上传大小的问题\n技能库、技能审核后台\n技能跟素材上传的端（小程序需求）'
          : undefined)
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('别忘了 下面五个待办 1、token消耗 2、生图、米塔api 3、案例上传大小的问题 4、技能库、技能审核后台 5. 技能跟素材上传的端 （小程序需求）')

      const texts = todo.list().map(item => item.text)
      expect(texts).toContain('token消耗')
      expect(texts).toContain('生图、米塔api')
      expect(texts).toContain('案例上传大小的问题')
      expect(texts).toContain('技能库、技能审核后台')
      expect(texts).toContain('技能跟素材上传的端（小程序需求）')
      // The whole list must NOT be recorded as one item.
      expect(texts).not.toContain('下面五个待办')

      // The pet's reply prompt confirms the recorded count.
      const lastCall = fake.calls[fake.calls.length - 1]!
      expect(lastCall).toContain('5 条')
      expect(lastCall).toContain('token消耗')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('extracts a 待办-led comma list via the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness({}, (input) =>
        input.includes('请把下面这段文字里的待办事项逐条提取出来')
          ? '买菜\n拖地\n倒垃圾'
          : undefined)
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('待办：买菜、拖地、倒垃圾')
      const texts = todo.list().map(item => item.text)
      expect(texts).toContain('买菜')
      expect(texts).toContain('拖地')
      expect(texts).toContain('倒垃圾')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records a numbered list that starts with 帮我记录一下 and 下面几个代办', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-todo-'))
    try {
      const fake = new FakeHarness({}, (input) =>
        input.includes('请把下面这段文字里的待办事项逐条提取出来')
          ? 'token消耗\n生图、米塔api\n案例上传大小的问题\n技能库、技能审核后台\n技能跟素材上传的端（小程序需求）'
          : undefined)
      const host = hostWithTodoAndBridge(dir, fake)
      await host.start()
      const todo = todoOf(host)
      const pet = host.get<import('../src/core/plugin.ts').PetService>(SERVICES.pet)!
      await pet.prompt('帮我记录一下 下面几个代办1、token消耗 2、生图、米塔api 3、案例上传大小的问题 4、技能库、技能审核后台 5.  技能跟素材上传的端 （小程序需求）')

      const texts = todo.list().map(item => item.text)
      expect(texts).toContain('token消耗')
      expect(texts).toContain('生图、米塔api')
      expect(texts).toContain('案例上传大小的问题')
      expect(texts).toContain('技能库、技能审核后台')
      expect(texts).toContain('技能跟素材上传的端（小程序需求）')
      expect(texts).not.toContain('下面几个代办')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('detectBulkTodoList', () => {
  it('detects numbered lists and 待办-led comma lists', () => {
    expect(detectBulkTodoList('别忘了 下面五个待办 1、token消耗 2、生图、米塔api 3、案例上传大小的问题')).toBe(true)
    expect(detectBulkTodoList('待办：买菜、拖地、倒垃圾')).toBe(true)
    expect(detectBulkTodoList('我明天要交周报')).toBe(false)
    expect(detectBulkTodoList('你明天要做什么？')).toBe(false)
    expect(detectBulkTodoList('帮我列一下 1、a 2、b')).toBe(false)
    expect(detectBulkTodoList('')).toBe(false)
  })

  it('recognizes 帮我记录一下…待办 statements and reversed 下面…待办 phrasing', () => {
    expect(detectBulkTodoList('帮我记录一下 下面几个代办1、token消耗 2、生图、米塔api 3、案例上传大小的问题')).toBe(true)
    expect(detectBulkTodoList('下面几个待办：买菜、拖地、倒垃圾')).toBe(true)
    expect(detectBulkTodoList('待办1、买菜 2、拖地')).toBe(true)
    // A pet request WITHOUT todo vocabulary stays excluded.
    expect(detectBulkTodoList('帮我查一下天气')).toBe(false)
  })
})

describe('extractTodoHeuristic', () => {
  it('extracts plans and reminders', () => {
    expect(extractTodoHeuristic('我明天要交周报')).toBe('交周报')
    expect(extractTodoHeuristic('明天得去银行')).toBe('去银行')
    expect(extractTodoHeuristic('别忘了给妈妈打电话')).toBe('给妈妈打电话')
    expect(extractTodoHeuristic('记得买牛奶')).toBe('买牛奶')
    expect(extractTodoHeuristic('该写周报了')).toBe('写周报')
    expect(extractTodoHeuristic('我要去医院看牙')).toBe('去医院看牙')
  })

  it('returns null for questions, pet requests, recall, and recollection', () => {
    expect(extractTodoHeuristic('你明天要做什么？')).toBeNull()
    expect(extractTodoHeuristic('帮我查一下天气')).toBeNull()
    expect(extractTodoHeuristic('你记得什么')).toBeNull()
    expect(extractTodoHeuristic('我记得你上次说喜欢猫')).toBeNull()
    expect(extractTodoHeuristic('你叫什么名字')).toBeNull()
    expect(extractTodoHeuristic('')).toBeNull()
  })
})
