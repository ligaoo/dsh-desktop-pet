import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHarnessApiKey, resolveDshHome, resolveHarnessApiKey } from '../src/core/credentials.ts'

describe('resolveDshHome', () => {
  it('prefers DSH_HOME over ~/.dsh', () => {
    expect(resolveDshHome({ DSH_HOME: 'C:/custom-home' })).toBe('C:/custom-home')
    expect(resolveDshHome({ DSH_HOME: '' })).toContain('.dsh')
    expect(resolveDshHome({})).toContain('.dsh')
  })
})

describe('readHarnessApiKey', () => {
  it('reads an unquoted key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-cred-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-test-123\n', 'utf8')
      expect(readHarnessApiKey(dir)).toBe('sk-test-123')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('strips single and double quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-cred-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), "DEEPSEEK_API_KEY: 'sk-quoted'\n", 'utf8')
      expect(readHarnessApiKey(dir)).toBe('sk-quoted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined when the file is missing or keyless', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-cred-'))
    try {
      expect(readHarnessApiKey(join(dir, 'nope'))).toBeUndefined()
      await writeFile(join(dir, '.credentials.yaml'), 'OTHER_KEY: x\n', 'utf8')
      expect(readHarnessApiKey(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveHarnessApiKey', () => {
  it('prefers the ambient environment over the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-cred-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-store\n', 'utf8')
      expect(resolveHarnessApiKey({ DSH_HOME: dir, DEEPSEEK_API_KEY: 'sk-ambient' })).toBe('sk-ambient')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the store when the environment lacks the key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pet-cred-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-store\n', 'utf8')
      expect(resolveHarnessApiKey({ DSH_HOME: dir })).toBe('sk-store')
      expect(resolveHarnessApiKey({ DSH_HOME: dir, DEEPSEEK_API_KEY: '' })).toBe('sk-store')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined when neither source has a key', () => {
    expect(resolveHarnessApiKey({ DSH_HOME: 'Z:/missing-dsh-home' })).toBeUndefined()
  })
})
