import { beforeAll, describe, it, expect } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { ExtensionNamespace, ExtensionSubjects } from '../observability/extension-namespace.js';

describe('ExtensionSubjects.warnings', () => {
  beforeAll(() => {
    MakaioBus.registerNamespace(ExtensionNamespace);
  });

  describe('warnings.list subject', () => {
    it('exposes warnings.list subject', () => {
      expect(ExtensionSubjects.warnings.list).toBeDefined();
    });

    it('has the correct subject key and namespace', () => {
      expect(ExtensionSubjects.warnings.list.subject).toBe('warnings.list');
      expect(ExtensionSubjects.warnings.list.$meta.namespace).toBe('kernel:extension');
    });

    it('is registered as a request subject', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list);
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('request');
      expect(schema).toHaveProperty('response');
    });

    it('accepts a request with no extensionName filter', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.request.safeParse({}).success).toBe(true);
    });

    it('accepts a request with an extensionName filter', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.request.safeParse({ extensionName: 'docker' }).success).toBe(true);
    });

    it('accepts a valid list response with warning entries', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({
        entries: [
          {
            extensionName: 'docker',
            warnings: [
              {
                severity: 'degraded',
                title: 'Docker unavailable',
                message: 'Docker daemon is not running.',
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid list response with an empty entries array', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.response.safeParse({ entries: [] }).success).toBe(true);
    });

    it('rejects a response missing the entries key', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.response.safeParse({}).success).toBe(false);
    });

    it('rejects a warning entry with an invalid severity', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({
        entries: [
          {
            extensionName: 'docker',
            warnings: [
              {
                severity: 'critical', // not a valid severity
                title: 'Docker unavailable',
                message: 'Docker daemon is not running.',
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('warnings.changed subject', () => {
    it('exposes warnings.changed subject', () => {
      expect(ExtensionSubjects.warnings.changed).toBeDefined();
    });

    it('has the correct subject key and namespace', () => {
      expect(ExtensionSubjects.warnings.changed.subject).toBe('warnings.changed');
      expect(ExtensionSubjects.warnings.changed.$meta.namespace).toBe('kernel:extension');
    });

    it('is registered as an event subject (not a request)', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.changed);
      expect(schema).toBeDefined();
      expect(schema).not.toHaveProperty('request');
      expect(schema).not.toHaveProperty('response');
    });

    it('accepts a valid warnings.changed payload with warnings', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.changed) as z.ZodType;
      const result = schema.safeParse({
        extensionName: 'docker',
        warnings: [
          {
            severity: 'recommended',
            title: 'Missing config',
            message: 'Docker config file not found.',
            action: { kind: 'open-url', url: 'https://example.com/setup' },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid warnings.changed payload with an empty warnings array', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.changed) as z.ZodType;
      expect(schema.safeParse({ extensionName: 'docker', warnings: [] }).success).toBe(true);
    });

    it('rejects a payload missing extensionName', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.changed) as z.ZodType;
      expect(
        schema.safeParse({
          warnings: [{ severity: 'info', title: 'Note', message: 'Some info.' }],
        }).success,
      ).toBe(false);
    });

    it('rejects a payload missing warnings array', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.changed) as z.ZodType;
      expect(schema.safeParse({ extensionName: 'docker' }).success).toBe(false);
    });

    it('rejects a warning with a missing title', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.warnings.changed) as z.ZodType;
      const result = schema.safeParse({
        extensionName: 'docker',
        warnings: [{ severity: 'info', message: 'Some info.' }],
      });
      expect(result.success).toBe(false);
    });
  });
});
