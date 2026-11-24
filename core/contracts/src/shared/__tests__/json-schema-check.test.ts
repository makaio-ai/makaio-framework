import { describe, expect, it } from 'vitest';
import { compileJsonSchemaCheck } from '../json-schema-check.js';
import type { JsonObject } from '../json-value.js';
import type { JsonSchemaCheckResult } from '../json-schema-check.js';

describe('compileJsonSchemaCheck', () => {
  const cases: ReadonlyArray<[string, JsonObject, unknown, JsonSchemaCheckResult]> = [
    [
      'accepts a value matching the schema',
      { type: 'object', properties: { name: { type: 'string' } } },
      { name: 'ada' },
      { valid: true },
    ],
    [
      'reports a type mismatch with its path and expected type',
      { type: 'object', properties: { age: { type: 'number' } } },
      { age: 'thirty' },
      {
        valid: false,
        issues: [{ path: 'age', reason: expect.any(String) as string, expectedType: 'number' }],
      },
    ],
    [
      'reports a missing required property at the property name',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      {},
      { valid: false, issues: [{ path: 'id', reason: expect.any(String) as string }] },
    ],
    [
      'reports an additional property rejected under additionalProperties: false',
      { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      { id: 'abc', extra: 1 },
      { valid: false, issues: [{ path: 'extra', reason: expect.any(String) as string }] },
    ],
    [
      'reports an enum violation with the allowed values',
      { type: 'object', properties: { color: { enum: ['red', 'blue'] } } },
      { color: 'green' },
      {
        valid: false,
        issues: [{ path: 'color', reason: expect.any(String) as string, allowedValues: ['red', 'blue'] }],
      },
    ],
    [
      'reports a nested rejection with a dotted path',
      { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'number' } } } } },
      { a: { b: 'not-a-number' } },
      { valid: false, issues: [{ path: 'a.b', reason: expect.any(String) as string, expectedType: 'number' }] },
    ],
    [
      'decodes an escaped ~1 pointer token back to the property name it encodes (a literal "/")',
      { type: 'object', properties: { 'a/b': { type: 'number' } } },
      { 'a/b': 'not-a-number' },
      { valid: false, issues: [{ path: 'a/b', reason: expect.any(String) as string, expectedType: 'number' }] },
    ],
    [
      'decodes an escaped ~0 pointer token back to the property name it encodes (a literal "~")',
      { type: 'object', properties: { 'a~b': { type: 'number' } } },
      { 'a~b': 'not-a-number' },
      { valid: false, issues: [{ path: 'a~b', reason: expect.any(String) as string, expectedType: 'number' }] },
    ],
  ];

  it.each(cases)('%s', (_case, schema, data, expected) => {
    const check = compileJsonSchemaCheck(schema);

    expect(check(data)).toEqual(expected);
  });

  it('compiles a draft 2020-12 $schema with the 2020 dialect, which enforces prefixItems', () => {
    const schema: JsonObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      prefixItems: [{ type: 'string' }],
    };
    const check = compileJsonSchemaCheck(schema);

    const result = check([42]);

    expect(result.valid).toBe(false);
  });

  it('throws compiling the same schema without $schema, because the default dialect does not know prefixItems', () => {
    // Same schema as the previous case, minus $schema: the default dialect has
    // no notion of `prefixItems`, and strictSchema rejects unknown keywords
    // rather than silently ignoring them. This is the dialect-selection branch
    // taken from the opposite side of the previous case.
    const schema: JsonObject = {
      type: 'array',
      prefixItems: [{ type: 'string' }],
    };

    expect(() => compileJsonSchemaCheck(schema)).toThrow();
  });

  it('throws compiling a schema with an unregistered custom keyword because strictSchema is on', () => {
    const schema: JsonObject = { type: 'object', 'x-makaio-custom': 'note' };

    expect(() => compileJsonSchemaCheck(schema)).toThrow();
  });

  it('lets a declared annotation keyword compile, without it affecting validation', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: { id: { type: 'string' } },
      'x-makaio-custom': 'note',
    };
    const check = compileJsonSchemaCheck(schema, { annotationKeywords: ['x-makaio-custom'] });

    expect(check({ id: 'abc' })).toEqual({ valid: true });
  });

  it('throws compiling a schema declaring $async: true, because the returned check is synchronous', () => {
    const schema: JsonObject = { $async: true, type: 'object', properties: { id: { type: 'string' } } };

    expect(() => compileJsonSchemaCheck(schema)).toThrow();
  });

  it('enforces a format keyword, e.g. rejecting a value that is not a valid email', () => {
    const schema: JsonObject = { type: 'string', format: 'email' };
    const check = compileJsonSchemaCheck(schema);

    expect(check('not-an-email')).toEqual({
      valid: false,
      issues: [{ path: '', reason: expect.any(String) as string }],
    });
    expect(check('ada@example.test')).toEqual({ valid: true });
  });
});
