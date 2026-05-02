import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

const interceptValidationNamespace = MakaioBus.registerNamespace('interceptValidation', {
  event: z.object({ value: z.string() }),
  getData: {
    request: z.object({ id: z.string() }),
    response: z.object({ data: z.string() }),
  },
});

describe('intercept validation', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('request subject rejection', () => {
    it('should throw when intercepting a request subject', () => {
      const handler = vi.fn();

      expect(() => {
        MakaioBus.intercept(interceptValidationNamespace.subjects.getData, handler);
      }).toThrow('intercept() only supports event subjects, not request subjects. Use middleware for requests.');
    });
  });

  describe('wildcard subject rejection', () => {
    it('should throw when intercepting a namespace wildcard ($all)', () => {
      const handler = vi.fn();

      expect(() => {
        MakaioBus.intercept(interceptValidationNamespace.subjects.$all, handler);
      }).toThrow('intercept() requires exact subjects, not wildcards. Wildcards are only supported for on().');
    });

    it('should throw when intercepting a malformed wildcard subject', () => {
      const handler = vi.fn();
      const malformedSubject = {
        subject: 'foo*bar',
        $meta: { namespace: 'interceptValidation', isRequest: false, local: false, channel: false },
      };

      expect(() => {
        // @ts-expect-error - testing runtime validation of malformed subject
        MakaioBus.intercept(malformedSubject, handler);
      }).toThrow('intercept() requires exact subjects, not wildcards. Wildcards are only supported for on().');
    });
  });
});
