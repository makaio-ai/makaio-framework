/**
 * Tests for the `kernel.restart` RPC schema.
 *
 * Verifies that the subject is registered on `KernelSubjects` and that the
 * request/response Zod schemas accept and reject values correctly.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import { KernelSubjects, KernelNamespace } from '../namespace/index.js';

describe('KernelSubjects.restart', () => {
  it('exists and is accessible', () => {
    expect(KernelSubjects.restart).toBeDefined();
  });

  describe('schema registration', () => {
    it('is registered as a request/response subject (RPC)', () => {
      MakaioBus.registerNamespace(KernelNamespace);
      const schema = MakaioBus.getSchema(KernelSubjects.restart);
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('request');
      expect(schema).toHaveProperty('response');
    });
  });

  describe('request schema', () => {
    let requestSchema: z.ZodType;

    beforeAll(() => {
      MakaioBus.registerNamespace(KernelNamespace);
      const schema = MakaioBus.getSchema(KernelSubjects.restart) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      requestSchema = schema.request;
    });

    it('accepts an empty object (no reason)', () => {
      expect(() => requestSchema.parse({})).not.toThrow();
    });

    it('accepts an object with a reason string', () => {
      expect(() => requestSchema.parse({ reason: 'setup' })).not.toThrow();
    });

    it('preserves the reason value when provided', () => {
      const result = requestSchema.parse({ reason: 'setup' });
      expect(result).toMatchObject({ reason: 'setup' });
    });

    it('omits reason from the parsed result when not provided', () => {
      const result = requestSchema.parse({}) as { reason?: string };
      expect(result.reason).toBeUndefined();
    });
  });

  describe('response schema', () => {
    let responseSchema: z.ZodType;

    beforeAll(() => {
      MakaioBus.registerNamespace(KernelNamespace);
      const schema = MakaioBus.getSchema(KernelSubjects.restart) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      responseSchema = schema.response;
    });

    it('accepts { accepted: true }', () => {
      expect(() => responseSchema.parse({ accepted: true })).not.toThrow();
    });

    it('accepts { accepted: false }', () => {
      expect(() => responseSchema.parse({ accepted: false })).not.toThrow();
    });

    it('rejects a missing accepted field', () => {
      expect(() => responseSchema.parse({})).toThrow();
    });

    it('preserves the accepted boolean value', () => {
      expect(responseSchema.parse({ accepted: true })).toMatchObject({ accepted: true });
      expect(responseSchema.parse({ accepted: false })).toMatchObject({ accepted: false });
    });
  });
});
