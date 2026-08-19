import { describe, expect, it } from 'vitest'
import { applyEnvOverrides, buildConfig, resolvePluginRow } from '../src/core/config.ts'

describe('buildConfig', () => {
  it('enables stock plugins with empty options by default (window off outside Electron)', () => {
    const config = buildConfig(undefined, {}, {})
    expect(config.plugins.runtime).toEqual({})
    expect(config.plugins.state).toEqual({})
    expect(config.plugins.bridge).toEqual({})
    // Under vitest (plain node) the window and notifier plugins default to disabled.
    expect(config.plugins.window).toBe(false)
    expect(config.plugins.notifier).toBe(false)
  })

  it('merges file rows, defaults, and disables with false', () => {
    const config = buildConfig({
      defaults: { model: 'deepseek-v4-pro' },
      plugins: {
        runtime: { command: 'node' },
        bridge: false,
        './plugins/x.mjs': { opt: 1 },
      },
    }, {}, {})
    expect(config.defaults.model).toBe('deepseek-v4-pro')
    expect(config.plugins.runtime).toEqual({ command: 'node' })
    expect(config.plugins.bridge).toBe(false)
    expect(config.plugins['./plugins/x.mjs']).toEqual({ opt: 1 })
  })

  it('maps the top-level name into the identity plugin row', () => {
    const config = buildConfig({ name: '小蓝' }, {}, {})
    expect(config.plugins.identity).toEqual({ name: '小蓝' })
    // An explicit identity row wins over the top-level name.
    const config2 = buildConfig({ name: '小蓝', plugins: { identity: { name: '阿蓝' } } }, {}, {})
    expect(config2.plugins.identity).toEqual({ name: '阿蓝' })
    expect(buildConfig(undefined, {}, {}).plugins.identity).toEqual({})
  })

  it('merges CLI overrides last', () => {
    const config = buildConfig({ cli: undefined }, { verbose: true }, {})
    expect(config.cli.verbose).toBe(true)
  })
})

describe('applyEnvOverrides', () => {
  it('maps DSH_PET_* runtime vars into the runtime row', () => {
    const config = applyEnvOverrides(buildConfig(undefined, {}, {}), {
      DSH_PET_RUNTIME: 'node',
      DSH_PET_RUNTIME_ARGS: '["--import","tsx/esm"]',
      DSH_PET_CWD: '/repo',
      DSH_PET_PROVIDER: 'custom',
      DSH_PET_MODEL: 'deepseek-v4-pro',
    })
    expect(config.plugins.runtime).toEqual({
      command: 'node',
      args: ['--import', 'tsx/esm'],
      cwd: '/repo',
      provider: 'custom',
      model: 'deepseek-v4-pro',
    })
  })

  it('explicit config wins over the environment', () => {
    const config = applyEnvOverrides(buildConfig({ plugins: { runtime: { command: 'from-config' } } }, {}, {}), {
      DSH_PET_RUNTIME: 'from-env',
    })
    expect(config.plugins.runtime).toEqual({ command: 'from-config' })
  })

  it('maps unknown DSH_PET_* vars to cli keys', () => {
    const config = applyEnvOverrides(buildConfig(undefined, {}, {}), { DSH_PET_VERBOSE: '1' })
    expect(config.cli.verbose).toBe('1')
  })
})

describe('resolvePluginRow', () => {
  it('returns null for disabled rows', () => {
    expect(resolvePluginRow(buildConfig({ plugins: { window: false } }, {}, {}), 'window')).toBeNull()
  })

  it('merges stock defaults, global defaults, and the row', () => {
    const config = buildConfig({
      defaults: { model: 'deepseek-v4-pro' },
      plugins: { runtime: { command: 'node' } },
    }, {}, {})
    expect(resolvePluginRow(config, 'runtime')).toEqual({ command: 'node', model: 'deepseek-v4-pro' })
  })
})
