import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverExternalPlugins, importExternalPlugin, resolvePlugins } from '../src/core/loader.ts'
import { buildConfig } from '../src/core/config.ts'

const PLUGIN_SOURCE = `export default {
  name: 'hello',
  version: '1.0.0',
  description: 'a test plugin',
  setup(ctx) {
    ctx.provide('greeting', 'hello from plugin')
  },
}
`

describe('discoverExternalPlugins', () => {
  it('finds *.mjs plugins in configured directories and explicit config rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-loader-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await writeFile(join(dir, 'plugins', 'hello.mjs'), PLUGIN_SOURCE, 'utf8')
      const config = buildConfig({ plugins: { './custom.mjs': {} }, pluginDirs: ['plugins'] }, {}, {})
      const entries = await discoverExternalPlugins(config, join(dir, 'config.json'), [])
      const names = entries.map(entry => entry.path)
      expect(names).toContain(join(dir, 'plugins', 'hello.mjs'))
      expect(names).toContain(join(dir, 'custom.mjs'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates by absolute path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-loader-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await writeFile(join(dir, 'plugins', 'hello.mjs'), PLUGIN_SOURCE, 'utf8')
      const config = buildConfig({ plugins: { './plugins/hello.mjs': {} }, pluginDirs: ['plugins'] }, {}, {})
      const entries = await discoverExternalPlugins(config, join(dir, 'config.json'), [])
      expect(entries.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('importExternalPlugin', () => {
  it('imports a module default-exporting one plugin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-import-'))
    try {
      const path = join(dir, 'one.mjs')
      await writeFile(path, PLUGIN_SOURCE, 'utf8')
      const plugins = await importExternalPlugin(path)
      expect(plugins).toHaveLength(1)
      expect(plugins[0]!.name).toBe('hello')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('imports a module default-exporting an array of plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-import-'))
    try {
      const path = join(dir, 'two.mjs')
      await writeFile(path, `export default [{ name: 'a', setup() {} }, { name: 'b', setup() {} }]`, 'utf8')
      expect((await importExternalPlugin(path)).map(plugin => plugin.name)).toEqual(['a', 'b'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects modules without a plugin export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-import-'))
    try {
      const path = join(dir, 'bad.mjs')
      await writeFile(path, 'export default 42', 'utf8')
      await expect(importExternalPlugin(path)).rejects.toThrow(/must export a PetPlugin/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePlugins', () => {
  it('skips disabled built-ins and includes external rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-resolve-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await writeFile(join(dir, 'plugins', 'hello.mjs'), PLUGIN_SOURCE, 'utf8')
      const config = buildConfig({
        plugins: { runtime: false, window: false, bridge: false },
        pluginDirs: ['plugins'],
      }, {}, {})
      const rows = await resolvePlugins(
        config,
        {
          runtime: () => ({ name: 'runtime', setup() {} }),
          state: () => ({ name: 'state', setup() {} }),
          bridge: () => ({ name: 'bridge', setup() {} }),
          window: () => ({ name: 'window', setup() {} }),
        },
        join(dir, 'config.json'),
      )
      expect(rows.map(row => row.key)).toEqual(['state', 'hello'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
