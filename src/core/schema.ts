/**
 * A tiny, dependency-free schema validator for plugin options.
 *
 * The original extension validated its Cordis plugin config with
 * `@deepseek-ai/schemastery`. To keep this standalone project free of the
 * vendored schemastery/cosmokit closure, the pet ships its own minimal
 * combinator set covering everything the built-in plugins (and most external
 * plugins) need: strings, numbers, booleans, arrays, objects, optional
 * fields with defaults, and unions.
 *
 * A `Schema<T>` is a pure function: `(value, path?) => T`. It throws
 * {@link SchemaValidationError} on invalid input and applies `default`
 * whenever the input is `undefined` (for optional fields).
 *
 * @module desktop-pet/schema
 */

/** Raised when a value fails its schema; `path` is the dotted field location. */
export class SchemaValidationError extends TypeError {
  /** @param path - dotted path of the offending field (empty for the root). */
  constructor(message: string, readonly path: string) {
    super(path === '' ? message : `${path}: ${message}`)
    this.name = 'SchemaValidationError'
  }
}

/** A value validator/coercer. `path` accumulates for error messages. */
export type Schema<T> = (value: unknown, path?: string) => T

/** True when the value is a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new SchemaValidationError(message, path)
}

/** `string` field; invalid when present and not a string. */
export function string(defaultValue?: string): Schema<string | undefined> {
  return (value, path = '') => {
    if (value === undefined) return defaultValue
    if (typeof value !== 'string') fail(path, 'expected a string')
    return value
  }
}

/** `string` field that rejects `undefined` (unlike {@link string}). */
export function strictString(): Schema<string> {
  return (value, path = '') => {
    if (typeof value !== 'string') fail(path, 'expected a string')
    return value
  }
}

/** `number` field; invalid when present and not a finite number. */
export function number(defaultValue?: number): Schema<number | undefined> {
  return (value, path = '') => {
    if (value === undefined) return defaultValue
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a number')
    return value
  }
}

/** `boolean` field; invalid when present and not a boolean. */
export function boolean(defaultValue?: boolean): Schema<boolean | undefined> {
  return (value, path = '') => {
    if (value === undefined) return defaultValue
    if (typeof value !== 'boolean') fail(path, 'expected a boolean')
    return value
  }
}

/** Array field; every element must satisfy `item`. */
export function array<S>(item: Schema<S>, defaultValue?: S[]): Schema<S[] | undefined> {
  return (value, path = '') => {
    if (value === undefined) return defaultValue
    if (!Array.isArray(value)) fail(path, 'expected an array')
    return value.map((element, index) => item(element, `${path}[${index}]`))
  }
}

/** Object field; unknown keys are dropped, known keys are validated. */
export function object<S extends Record<string, Schema<unknown>>>(shape: S): Schema<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (value, path = '') => {
    if (value === undefined) return {} as { [K in keyof S]: ReturnType<S[K]> }
    if (!isRecord(value)) fail(path, 'expected an object')
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) {
      result[key] = shape[key]!(value[key], path === '' ? key : `${path}.${key}`)
    }
    return result as { [K in keyof S]: ReturnType<S[K]> }
  }
}

/** Record field: every value must satisfy `item`; unknown keys are kept. */
export function record<S>(item: Schema<S>): Schema<Record<string, S>> {
  return (value, path = '') => {
    if (value === undefined) return {} as Record<string, S>
    if (!isRecord(value)) fail(path, 'expected an object')
    const result: Record<string, S> = {}
    for (const [key, element] of Object.entries(value)) {
      result[key] = item(element, path === '' ? key : `${path}.${key}`)
    }
    return result
  }
}

/** Union field; tries each member in order, keeping the first success. */
export function union<S>(members: Schema<S>[]): Schema<S> {
  return (value, path = '') => {
    if (value === undefined) fail(path, 'expected a value')
    for (const member of members) {
      try {
        return member(value, path)
      } catch (error) {
        if (!(error instanceof SchemaValidationError)) throw error
      }
    }
    fail(path, 'did not match any union member')
  }
}

/** Optional wrapper: `undefined` passes through as `undefined`. */
export function optional<S>(schema: Schema<S>): Schema<S | undefined> {
  return (value, path = '') => (value === undefined ? undefined : schema(value, path))
}
