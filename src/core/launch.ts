/**
 * Runtime launch resolution for the desktop pet shell. The default launch runs
 * the installed `dsh-jsonrpc-agent` bin; `DSH_PET_*` environment variables
 * override the command, arguments, and session route. Invalid values throw
 * here, before any window opens.
 *
 * @module desktop-pet/launch
 */

import type { HarnessClientOptions } from '../sdk.ts'

/** Session route for the pet's agent: where it works and which model it talks to. */
export interface PetRoute {
  /** Workspace cwd recorded on the pet's session. */
  cwd: string
  /** Provider route for the pet's agent (default `deepseek-official`). */
  provider: string
  /** Conversation model for the pet's agent (default `deepseek-v4-flash`). */
  model: string
}

/** The fully resolved launch: runtime process spec plus session route. */
export interface PetLaunchSpec {
  /** Runtime subprocess spec handed to `DeepSeekHarnessOptions.launch`. */
  launch: HarnessClientOptions
  /** Session route handed to `DeepSeekHarnessOptions`. */
  route: PetRoute
}

/** Parse `DSH_PET_RUNTIME_ARGS`: a JSON array of strings, empty when unset. */
function parseArgs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (parseError) {
    throw new Error(`DSH_PET_RUNTIME_ARGS must be a JSON array of strings; got unparseable JSON: ${raw}`, { cause: parseError })
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`DSH_PET_RUNTIME_ARGS must be a JSON array of strings; got: ${raw}`)
  }
  return value
}

/**
 * Resolve the runtime launch and session route from the environment.
 * @param env - environment to read `DSH_PET_*` overrides from (default `process.env`).
 * @param cwd - fallback workspace cwd when `DSH_PET_CWD` is unset (default `process.cwd()`).
 * @returns the launch spec and route for `DeepSeekHarness`.
 */
export function resolvePetLaunch(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PetLaunchSpec {
  return {
    launch: {
      command: env.DSH_PET_RUNTIME ?? 'dsh-jsonrpc-agent',
      args: parseArgs(env.DSH_PET_RUNTIME_ARGS),
    },
    route: {
      cwd: env.DSH_PET_CWD ?? cwd,
      provider: env.DSH_PET_PROVIDER ?? 'deepseek-official',
      model: env.DSH_PET_MODEL ?? 'deepseek-v4-flash',
    },
  }
}
