import { describe, expect, it } from 'vitest'
import {
  assistantTextOf,
  buildJumpUrl,
  Config,
  findPendingApprovalId,
  pushRetryDelayMs,
  respawnDelayMs,
  resolveChildSpec,
  sessionEventNotify,
} from '../src/entries/harness-host.ts'

describe('harness-host Config', () => {
  it('fills the stock launch defaults', () => {
    expect(Config({})).toEqual({})
  })

  it('keeps a custom launch as given', () => {
    expect(Config({ runtime: 'node', runtimeArgs: ['apps/cli/src/bin.ts'], cwd: '/repo', provider: 'custom', model: 'deepseek-v4-pro' }))
      .toEqual({ runtime: 'node', runtimeArgs: ['apps/cli/src/bin.ts'], cwd: '/repo', provider: 'custom', model: 'deepseek-v4-pro' })
  })

  it('rejects non-object input and bad fields', () => {
    expect(() => Config(null)).toThrow(/must be a plain object/)
    expect(() => Config('nope')).toThrow(/must be a plain object/)
    expect(() => Config({ runtime: 42 })).toThrow(/config.runtime must be a string/)
    expect(() => Config({ runtimeArgs: ['ok', 42] })).toThrow(/runtimeArgs must be an array of strings/)
  })
})

describe('resolveChildSpec', () => {
  it('opens the window entry under Electron with the config mapped to DSH_PET_* env', () => {
    const spec = resolveChildSpec(
      { runtime: 'node', runtimeArgs: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'], cwd: '/repo', provider: 'custom', model: 'deepseek-v4-pro' },
      '/bin/electron',
      '/pkg/lib/entries/window.js',
      {},
    )
    expect(spec.command).toBe('/bin/electron')
    expect(spec.args).toEqual(['/pkg/lib/entries/window.js'])
    expect(spec.env).toEqual({
      DSH_PET_RUNTIME: 'node',
      DSH_PET_RUNTIME_ARGS: '["--import","tsx/esm","apps/cli/src/bin.ts"]',
      DSH_PET_CWD: '/repo',
      DSH_PET_PROVIDER: 'custom',
      DSH_PET_MODEL: 'deepseek-v4-pro',
    })
  })

  it('omits DSH_PET_CWD unless the config names one', () => {
    const spec = resolveChildSpec({}, '/bin/electron', '/pkg/lib/entries/window.js', {})
    expect(spec.env.DSH_PET_RUNTIME).toBe('dsh-jsonrpc-agent')
    expect(spec.env.DSH_PET_MODEL).toBe('deepseek-v4-flash')
    expect(spec.env).not.toHaveProperty('DSH_PET_CWD')
  })

  it('inherits the base environment so secrets reach the pet runtime out of band', () => {
    const spec = resolveChildSpec({}, '/bin/electron', '/pkg/lib/entries/window.js', { DEEPSEEK_API_KEY: 'sk-test', PATH: '/usr/bin' })
    expect(spec.env.DEEPSEEK_API_KEY).toBe('sk-test')
    expect(spec.env.PATH).toBe('/usr/bin')
  })
})

describe('harness-host notify helpers', () => {
  it('buildJumpUrl substitutes the session id into the template', () => {
    expect(buildJumpUrl({ webBaseUrl: 'http://localhost:8080' }, 's-1')).toBe('http://localhost:8080/#/session/s-1')
    expect(buildJumpUrl({ webBaseUrl: 'http://localhost:8080', sessionPath: '/session/{sessionId}' }, 's 1')).toBe('http://localhost:8080/session/s%201')
    expect(buildJumpUrl({}, 's-1')).toBeUndefined()
  })

  it('findPendingApprovalId pairs the newest undecided ask matching the call id', () => {
    const events = [
      { type: 'approval/asked', data: { id: 'a1', callId: 'c1' } },
      { type: 'approval/asked', data: { id: 'a2', callId: 'c2' } },
    ]
    expect(findPendingApprovalId(events, 'c2', new Set())).toBe('a2')
    // A decided ask is skipped.
    const decided = [...events, { type: 'approval/decided', data: { id: 'a2', outcome: 'rejected' } }]
    expect(findPendingApprovalId(decided, 'c2', new Set())).toBeUndefined()
    // A claimed ask is skipped.
    expect(findPendingApprovalId(events, 'c2', new Set(['a2']))).toBeUndefined()
    // callId-less asks only pair with callId-less requests.
    const bare = [{ type: 'approval/asked', data: { id: 'b1' } }]
    expect(findPendingApprovalId(bare, undefined, new Set())).toBe('b1')
    expect(findPendingApprovalId(bare, 'c9', new Set())).toBeUndefined()
  })

  it('assistantTextOf concatenates text blocks', () => {
    expect(assistantTextOf({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] } } })).toBe('hello')
    expect(assistantTextOf({ type: 'assistant/message', data: {} })).toBeNull()
    expect(assistantTextOf({ type: 'tool/call', data: {} })).toBeNull()
  })

  it('sessionEventNotify maps approval/asked and completed turn/end, filters subagents', () => {
    const config = { webBaseUrl: 'http://localhost:8080', sessionPath: '/#/session/{sessionId}', onlyRootSessions: true }
    expect(sessionEventNotify(config, 's1', true, '', { type: 'approval/asked', data: { toolName: 'bash', reason: 'risky' } }))
      .toEqual({ title: '需要审批', body: '工具 bash 需要审批：risky', jumpUrl: 'http://localhost:8080/#/session/s1' })
    expect(sessionEventNotify(config, 's1', true, '你好', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
      .toEqual({ title: '任务完成', body: '你好', jumpUrl: 'http://localhost:8080/#/session/s1' })
    // Error turns and subagent sessions produce nothing.
    expect(sessionEventNotify(config, 's1', true, '', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'x' } } } })).toBeNull()
    expect(sessionEventNotify(config, 'child', false, '', { type: 'approval/asked', data: { toolName: 'bash' } })).toBeNull()
    // onlyRootSessions=false forwards children too.
    expect(sessionEventNotify({ ...config, onlyRootSessions: false }, 'child', false, '', { type: 'approval/asked', data: { toolName: 'bash' } }))
      .toEqual({ title: '需要审批', body: '工具 bash 需要审批', jumpUrl: 'http://localhost:8080/#/session/child' })
  })

  it('respawnDelayMs backs off from 2s and caps at 30s', () => {
    expect(respawnDelayMs(1)).toBe(2000)
    expect(respawnDelayMs(2)).toBe(4000)
    expect(respawnDelayMs(3)).toBe(8000)
    expect(respawnDelayMs(4)).toBe(16000)
    expect(respawnDelayMs(5)).toBe(30000)
    expect(respawnDelayMs(10)).toBe(30000)
  })

  it('pushRetryDelayMs backs off 500ms, 1s, 2s across retry attempts', () => {
    expect(pushRetryDelayMs(1)).toBe(500)
    expect(pushRetryDelayMs(2)).toBe(1000)
    expect(pushRetryDelayMs(3)).toBe(2000)
    expect(pushRetryDelayMs(4)).toBe(4000)
  })
})
