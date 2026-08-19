import { describe, expect, it } from 'vitest'
import { array, boolean, number, object, optional, record, SchemaValidationError, string, union } from '../src/core/schema.ts'

describe('schema combinators', () => {
  it('validates an object shape with defaults', () => {
    const schema = object({
      name: string('pet'),
      size: number(10),
      visible: boolean(true),
      tags: array(string()),
    })
    expect(schema({})).toEqual({ name: 'pet', size: 10, visible: true, tags: undefined })
    expect(schema({ name: 'cat', size: 3, visible: false, tags: ['a', 'b'] }))
      .toEqual({ name: 'cat', size: 3, visible: false, tags: ['a', 'b'] })
  })

  it('rejects wrong types with a dotted path', () => {
    const schema = object({ nested: object({ count: number() }) })
    expect(() => schema({ nested: { count: 'nope' } })).toThrow(SchemaValidationError)
    try {
      schema({ nested: { count: 'nope' } })
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError)
      expect((error as SchemaValidationError).path).toBe('nested.count')
    }
  })

  it('drops unknown object keys', () => {
    expect(object({ a: string() })({ a: 'x', b: 1 })).toEqual({ a: 'x' })
  })

  it('validates record fields', () => {
    expect(record(number())({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
    expect(() => record(number())({ a: 'x' })).toThrow(SchemaValidationError)
    expect(record(string())(undefined)).toEqual({})
  })

  it('passes undefined through optional', () => {
    expect(optional(string())(undefined)).toBeUndefined()
    expect(optional(string())('x')).toBe('x')
  })

  it('picks the first matching union member', () => {
    const schema = union([string(), number()])
    expect(schema('a')).toBe('a')
    expect(schema(1)).toBe(1)
    expect(() => schema(true)).toThrow(/did not match any union member/)
  })

  it('validates array elements', () => {
    const schema = array(number(), [1, 2])
    expect(schema(undefined)).toEqual([1, 2])
    expect(schema([3])).toEqual([3])
    expect(() => schema([3, 'x'])).toThrow(/\[1\]: expected a number/)
  })
})
