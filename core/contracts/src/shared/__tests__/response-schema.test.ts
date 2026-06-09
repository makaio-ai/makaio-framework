import { describe, expect, it } from 'vitest';
import { ResponseSchemaDescriptorSchema, StructuredOutputValidationSchema } from '../response-schema.js';

describe('ResponseSchemaDescriptorSchema', () => {
  it('accepts a JSON-safe schema descriptor with name and strict hint', () => {
    const result = ResponseSchemaDescriptorSchema.parse({
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
      name: 'answer_schema',
      strict: true,
    });

    expect(result.name).toBe('answer_schema');
    expect(result.strict).toBe(true);
  });

  it('rejects invalid provider schema names', () => {
    const result = ResponseSchemaDescriptorSchema.safeParse({
      schema: { type: 'object' },
      name: 'invalid name with spaces',
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-JSON schema values', () => {
    const result = ResponseSchemaDescriptorSchema.safeParse({
      schema: { type: 'object', validator: () => true },
    });

    expect(result.success).toBe(false);
  });
});

describe('StructuredOutputValidationSchema', () => {
  it('accepts failed validation metadata with normalized errors', () => {
    expect(
      StructuredOutputValidationSchema.parse({
        status: 'failed',
        errors: [{ message: 'must have required property answer', instancePath: '', schemaPath: '#/required' }],
      }),
    ).toEqual({
      status: 'failed',
      errors: [{ message: 'must have required property answer', instancePath: '', schemaPath: '#/required' }],
    });
  });

  it('accepts passed status with no errors', () => {
    expect(StructuredOutputValidationSchema.parse({ status: 'passed' })).toEqual({ status: 'passed' });
  });

  it('accepts enforced status with no errors', () => {
    expect(StructuredOutputValidationSchema.parse({ status: 'enforced' })).toEqual({ status: 'enforced' });
  });

  it('rejects failed status with an empty errors array', () => {
    const result = StructuredOutputValidationSchema.safeParse({ status: 'failed', errors: [] });
    expect(result.success).toBe(false);
  });

  it('rejects passed status when errors are present', () => {
    const result = StructuredOutputValidationSchema.safeParse({
      status: 'passed',
      errors: [{ message: 'unexpected error', instancePath: '', schemaPath: '#/required' }],
    });
    expect(result.success).toBe(false);
  });
});
