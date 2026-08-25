import { describe, expect, it } from 'vitest'
import { resolvePetLaunch } from '../src/core/launch.ts'

describe('resolvePetLaunch', () => {
  it('defaults to the installed dsh-jsonrpc-agent bin and the stock route', () => {
    expect(resolvePetLaunch({}, '/work')).toEqual({
      launch: { command: 'dsh-jsonrpc-agent', args: [] },
      route: { cwd: '/work', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    })
  })

  it('honors DSH_PET_* overrides', () => {
    const spec = resolvePetLaunch({
      DSH_PET_RUNTIME: 'node',
      DSH_PET_RUNTIME_ARGS: '["--import", "tsx/esm", "apps/cli/src/bin.ts"]',
      DSH_PET_CWD: '/repo',
      DSH_PET_PROVIDER: 'custom',
      DSH_PET_MODEL: 'deepseek-v4-pro',
    })
    expect(spec.launch).toEqual({ command: 'node', args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'] })
    expect(spec.route).toEqual({ cwd: '/repo', provider: 'custom', model: 'deepseek-v4-pro' })
  })

  it('treats blank DSH_PET_RUNTIME_ARGS as unset', () => {
    expect(resolvePetLaunch({ DSH_PET_RUNTIME_ARGS: '   ' }, '/work').launch.args).toEqual([])
  })

  it('fails loud on unparseable DSH_PET_RUNTIME_ARGS', () => {
    expect(() => resolvePetLaunch({ DSH_PET_RUNTIME_ARGS: 'not json' }, '/work'))
      .toThrow(/DSH_PET_RUNTIME_ARGS must be a JSON array of strings; got unparseable JSON/)
  })

  it('fails loud on non-array or non-string DSH_PET_RUNTIME_ARGS', () => {
    expect(() => resolvePetLaunch({ DSH_PET_RUNTIME_ARGS: '{"a": 1}' }, '/work'))
      .toThrow(/DSH_PET_RUNTIME_ARGS must be a JSON array of strings/)
    expect(() => resolvePetLaunch({ DSH_PET_RUNTIME_ARGS: '["--flag", 1]' }, '/work'))
      .toThrow(/DSH_PET_RUNTIME_ARGS must be a JSON array of strings/)
  })
})
