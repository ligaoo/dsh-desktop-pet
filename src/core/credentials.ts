/**
 * Harness credential reuse: the pet never assembles a provider request, but
 * it DOES own the runtime subprocess's launch environment. When the launching
 * environment lacks `DEEPSEEK_API_KEY`, this module reads the key from the
 * harness credentials store (`$DSH_HOME/.credentials.yaml`, default
 * `~/.dsh/.credentials.yaml`) so the pet works with zero extra configuration
 * on any machine that already has a key stored for DeepSeek Harness.
 *
 * The store is a strict `CredentialRef`-to-string mapping (see
 * `@deepseek-ai/dsh-credentials-local`); the minimal line parser below covers
 * the standard unquoted/single-quoted `KEY: value` form.
 *
 * @module desktop-pet/credentials
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEY_REF = 'DEEPSEEK_API_KEY'
const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The harness home directory: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** Parse a `KEY: value` line; handles optional surrounding quotes. */
function parseValue(raw: string): string | undefined {
  const match = /^\s*DEEPSEEK_API_KEY\s*:\s*(.*?)\s*$/.exec(raw)
  if (match === null) return undefined
  let value = match[1] ?? ''
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
  return value === '' ? undefined : value
}

/**
 * Read `DEEPSEEK_API_KEY` from the harness credentials store.
 * @param dshHome - harness home directory (default via {@link resolveDshHome}).
 * @returns the stored key, or undefined when the file is missing or has no key.
 */
export function readHarnessApiKey(dshHome: string): string | undefined {
  try {
    const text = readFileSync(join(dshHome, CREDENTIALS_FILENAME), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const value = parseValue(line)
      if (value !== undefined) return value
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the API key for the pet's runtime: the launching environment wins
 * (a CI secret or explicit export is this run's intent); otherwise fall back
 * to the harness credentials store.
 * @param env - the launching environment (default `process.env`).
 * @returns the resolved key, or undefined when neither source has one.
 */
export function resolveHarnessApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ambient = env[KEY_REF]
  if (ambient !== undefined && ambient !== '') return ambient
  return readHarnessApiKey(resolveDshHome(env))
}
