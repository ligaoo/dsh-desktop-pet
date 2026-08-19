import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetHost } from '../src/core/host.ts'
import { SERVICES } from '../src/core/plugin.ts'
import { memoryPlugin } from '../src/plugins/memory.ts'

async function hostWithMemory(dir: string, extra: Record<string, unknown> = {}): Promise<PetHost> {
  const host = new PetHost()
  host.use(memoryPlugin, { dir, ...extra })
  await host.start()
  return host
}

describe('memory plugin', () => {
  it('creates default persona and memory files on first launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-mem-'))
    try {
      await hostWithMemory(dir)
      const persona = await readFile(join(dir, 'persona.md'), 'utf8')
      expect(persona).toContain('桌面宠物精灵')
      const memory = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8'))
      expect(memory).toEqual({ facts: [], episodes: [], history: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists facts, episodes, and history across host instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-mem-'))
    try {
      const host1 = await hostWithMemory(dir)
      const mem1 = host1.get(SERVICES.memory)!
      mem1.addFact('用户喜欢猫')
      mem1.addEpisode('用户曾提到在写一个桌面宠物项目')
      mem1.recordTurn('你好', '你好呀主人')
      await host1.dispose()

      const host2 = await hostWithMemory(dir)
      const mem2 = host2.get(SERVICES.memory)!
      expect(mem2.facts()).toEqual(['用户喜欢猫'])
      expect(mem2.episodes()).toEqual(['用户曾提到在写一个桌面宠物项目'])
      expect(mem2.historyLength()).toBe(2)
      await host2.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates facts, removes by match, and caps history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-mem-'))
    try {
      const host = await hostWithMemory(dir, { maxHistory: 4 })
      const mem = host.get(SERVICES.memory)!
      mem.addFact('喜欢猫')
      mem.addFact('喜欢猫')
      expect(mem.facts()).toEqual(['喜欢猫'])

      mem.addFact('喜欢咖啡')
      expect(mem.removeFact('喜欢')).toBe(2)
      expect(mem.facts()).toEqual([])

      mem.recordTurn('a', 'b')
      mem.recordTurn('c', 'd')
      mem.recordTurn('e', 'f')
      // 6 messages, maxHistory 4 → 2 overflow awaiting consolidation.
      expect(mem.historyLength()).toBe(6)
      expect(mem.overflowCount()).toBe(2)
      const drained = mem.drainHistory(2)
      expect(drained).toEqual([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }])
      expect(mem.historyLength()).toBe(4)
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('context() includes persona, facts, episodes, and recent history; recallText() omits history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-mem-'))
    try {
      const host = await hostWithMemory(dir)
      const mem = host.get(SERVICES.memory)!
      mem.addFact('用户住在杭州')
      mem.addEpisode('聊过天气')
      mem.recordTurn('早上好', '早安，主人')
      const context = mem.context()
      expect(context).toContain('桌面宠物精灵')
      expect(context).toContain('用户住在杭州')
      expect(context).toContain('聊过天气')
      expect(context).toContain('用户：早上好')
      const recall = mem.recallText()
      expect(recall).toContain('用户住在杭州')
      expect(recall).toContain('聊过天气')
      expect(recall).not.toContain('早上好')
      await host.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
