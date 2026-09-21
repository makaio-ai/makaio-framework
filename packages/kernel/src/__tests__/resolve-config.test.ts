import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { ExtensionOperatorConfigEntry, JsonValue } from '@makaio/contracts';
import { MakaioError } from '@makaio/core';
import { ExtensionOperatorConfigError, resolveConfig, type ResolveConfigInput } from '../extension/resolve-config.js';

const OPERATOR_SOURCE = 'operator entry for "layered"';

/**
 * Build a usable operator entry for tests.
 * @param config - Operator-supplied configuration object.
 * @returns A `config` entry carrying the shared test source label.
 */
function operatorValue(config: Record<string, JsonValue>): ExtensionOperatorConfigEntry {
  return { kind: 'config', source: OPERATOR_SOURCE, config };
}

/**
 * Resolve in the mode a lifecycle transition uses, where an operator-attributed
 * failure is raised rather than degraded.
 * @param input - Every resolution input except the mode.
 * @returns Whatever {@link resolveConfig} returns for those inputs.
 */
function resolveActivating(input: Omit<ResolveConfigInput, 'mode'>): unknown {
  return resolveConfig({ ...input, mode: 'activate' });
}

describe('resolveConfig', () => {
  describe('layer composition', () => {
    it('lets the operator entry win per top-level key over both lower layers', () => {
      const schema = z.object({ host: z.string(), port: z.number() });

      const resolved = resolveActivating({
        name: 'layered',
        configSchema: schema,
        configDefaults: { host: 'default-host', port: 1234 },
        storedConfig: { host: 'stored-host', port: 9999 },
        operatorEntry: operatorValue({ host: 'operator-host', port: 6299 }),
      });

      expect(resolved).toEqual({ host: 'operator-host', port: 6299 });
    });

    it('keeps keys the operator entry does not declare', () => {
      const schema = z.object({ host: z.string(), port: z.number(), timeout: z.number() });

      const resolved = resolveActivating({
        name: 'layered',
        configSchema: schema,
        configDefaults: { host: 'default-host', port: 1234, timeout: 30 },
        storedConfig: { host: 'stored-host' },
        operatorEntry: operatorValue({ port: 6299 }),
      });

      expect(resolved).toEqual({ host: 'stored-host', port: 6299, timeout: 30 });
    });

    it('replaces a nested object wholesale because merging is shallow', () => {
      const schema = z.object({ upstreams: z.record(z.string(), z.string()) });

      const resolved = resolveActivating({
        name: 'layered',
        configSchema: schema,
        configDefaults: { upstreams: { primary: 'https://a.example', backup: 'https://b.example' } },
        storedConfig: undefined,
        operatorEntry: operatorValue({ upstreams: { primary: 'https://operator.example' } }),
      });

      expect(resolved).toEqual({ upstreams: { primary: 'https://operator.example' } });
    });
  });

  describe('unusable operator entries', () => {
    it.each([
      ['unreadable', 'could not be read'],
      ['invalid-json', 'is not valid JSON'],
      ['not-an-object', 'is not a JSON object'],
    ] as const)('throws naming the extension and source for a %s entry', (reason, phrase) => {
      const call = (): unknown =>
        resolveActivating({
          name: 'layered',
          configSchema: z.object({ host: z.string().default('x') }),
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: { kind: 'failure', source: OPERATOR_SOURCE, reason },
        });

      expect(call).toThrow(ExtensionOperatorConfigError);
      expect(call).toThrow(`Operator config for extension "layered" (source: ${OPERATOR_SOURCE}) ${phrase}`);
    });

    it('appends the producer-supplied detail to the diagnostic', () => {
      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: z.object({ host: z.string().default('x') }),
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: {
            kind: 'failure',
            source: OPERATOR_SOURCE,
            reason: 'invalid-json',
            detail: 'Unexpected end of JSON input',
          },
        }),
      ).toThrow(/is not valid JSON: Unexpected end of JSON input$/);
    });

    it('reports an unusable entry even when the extension declares no config schema', () => {
      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: { kind: 'failure', source: OPERATOR_SOURCE, reason: 'unreadable' },
        }),
      ).toThrow(ExtensionOperatorConfigError);
    });

    it('exposes the extension name and source on the thrown error', () => {
      try {
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: { kind: 'failure', source: OPERATOR_SOURCE, reason: 'unreadable' },
        });
        expect.unreachable('resolveConfig should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ExtensionOperatorConfigError);
        expect((err as ExtensionOperatorConfigError).extensionName).toBe('layered');
        expect((err as ExtensionOperatorConfigError).source).toBe(OPERATOR_SOURCE);
      }
    });
  });

  describe('diagnostic hygiene', () => {
    it('flattens control characters and newlines in a producer detail', () => {
      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: {
            kind: 'failure',
            source: OPERATOR_SOURCE,
            reason: 'invalid-json',
            detail: 'line one\n\tline two\u0000line three',
          },
        }),
      ).toThrow('is not valid JSON: line one line two line three');
    });

    it('caps an oversized detail and marks the truncation', () => {
      const call = (): unknown =>
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: {
            kind: 'failure',
            source: OPERATOR_SOURCE,
            reason: 'unreadable',
            detail: 'x'.repeat(5_000),
          },
        });

      try {
        call();
        expect.unreachable('resolveConfig should have thrown');
      } catch (err) {
        const detail = (err as Error).message.split('could not be read: ')[1] ?? '';
        expect(detail).toHaveLength(200);
        expect(detail.endsWith('\u2026')).toBe(true);
      }
    });

    it('omits the separator when a detail flattens to nothing', () => {
      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: { kind: 'failure', source: OPERATOR_SOURCE, reason: 'unreadable', detail: '\n\t ' },
        }),
      ).toThrow(/could not be read$/);
    });

    it('is a MakaioError so host error handling can categorize it', () => {
      try {
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: { kind: 'failure', source: OPERATOR_SOURCE, reason: 'unreadable' },
        });
        expect.unreachable('resolveConfig should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MakaioError);
        expect((err as Error).name).toBe('ExtensionOperatorConfigError');
      }
    });
  });

  describe('observe mode', () => {
    it('applies a usable operator entry exactly as activate mode does', () => {
      const schema = z.object({ host: z.string(), port: z.number() });

      expect(
        resolveConfig({
          name: 'layered',
          configSchema: schema,
          configDefaults: { host: 'default-host', port: 1234 },
          storedConfig: undefined,
          operatorEntry: operatorValue({ host: 'operator-host' }),
          mode: 'observe',
        }),
      ).toEqual({ host: 'operator-host', port: 1234 });
    });

    it('warns and resolves the remaining layers instead of throwing for an unusable entry', () => {
      const schema = z.object({ retries: z.number() });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolved = resolveConfig({
        name: 'layered',
        configSchema: schema,
        configDefaults: { retries: 7 },
        storedConfig: undefined,
        operatorEntry: { kind: 'failure', source: OPERATOR_SOURCE, reason: 'invalid-json' },
        mode: 'observe',
      });

      expect(resolved).toEqual({ retries: 7 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resolving without the operator layer'));
      warnSpy.mockRestore();
    });

    it('warns and defaults instead of throwing for an operator-attributed schema rejection', () => {
      const schema = z.object({ retries: z.number().default(3) });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolved = resolveConfig({
        name: 'layered',
        configSchema: schema,
        configDefaults: { retries: 5 },
        storedConfig: undefined,
        operatorEntry: operatorValue({ retries: 'not-a-number' }),
        mode: 'observe',
      });

      expect(resolved).toEqual({ retries: 3 });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Config parse failed for "layered"'),
        expect.any(String),
      );
      warnSpy.mockRestore();
    });
  });

  describe('merge hygiene', () => {
    it('lets an explicit null in the operator entry override a lower layer', () => {
      const schema = z.object({ endpoint: z.string().nullable() });

      const resolved = resolveActivating({
        name: 'layered',
        configSchema: schema,
        configDefaults: { endpoint: 'https://default.example' },
        storedConfig: undefined,
        operatorEntry: operatorValue({ endpoint: null }),
      });

      expect(resolved).toEqual({ endpoint: null });
    });

    it('does not let a prototype key in an operator entry pollute Object.prototype', () => {
      const schema = z.looseObject({ safe: z.string() });
      const parsedFromJson: Record<string, JsonValue> = JSON.parse(
        '{"safe":"yes","__proto__":{"polluted":"whoops"}}',
      ) as Record<string, JsonValue>;

      const resolved = resolveActivating({
        name: 'layered',
        configSchema: schema,
        configDefaults: { safe: 'no' },
        storedConfig: undefined,
        operatorEntry: operatorValue(parsedFromJson),
      });

      expect(resolved).toMatchObject({ safe: 'yes' });
      expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
    });
  });

  describe('schema failures', () => {
    it('throws when the operator entry is what the schema rejects', () => {
      const schema = z.object({ retries: z.number().default(3) });

      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: schema,
          configDefaults: { retries: 5 },
          storedConfig: undefined,
          operatorEntry: operatorValue({ retries: 'not-a-number' }),
        }),
      ).toThrow(
        `Operator config for extension "layered" (source: ${OPERATOR_SOURCE}) ` +
          `is part of a configuration rejected by the extension's config schema:`,
      );
    });

    it('fails the extension when the operator entry is the sole source of a rejected required field', () => {
      // Nothing beneath the operator layer supplies `apiKey`, so the lower
      // layers do not parse either. That is not evidence the operator is
      // blameless — it is exactly what an operator file that supplies the only
      // value looks like — and the malformed entry must not be discarded.
      const schema = z.object({ apiKey: z.string() });

      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: schema,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: operatorValue({ apiKey: 123 }),
        }),
      ).toThrow(
        `Operator config for extension "layered" (source: ${OPERATOR_SOURCE}) ` +
          `is part of a configuration rejected by the extension's config schema:`,
      );
    });

    it('fails the extension when an operator entry is present and a lower layer holds the rejected value', () => {
      // The operator sets `label` and `retries` was already invalid in stored
      // config. Resolution still cannot be honoured, and the operator's file is
      // the input a person can act on, so the failure names it rather than
      // silently starting on schema defaults.
      const schema = z.object({ retries: z.number().default(3), label: z.string().default('none') });

      expect(() =>
        resolveActivating({
          name: 'layered',
          configSchema: schema,
          configDefaults: undefined,
          storedConfig: { retries: 'not-a-number' },
          operatorEntry: operatorValue({ label: 'operator' }),
        }),
      ).toThrow(ExtensionOperatorConfigError);
    });

    it('reports the schema rejection detail alongside the operator source', () => {
      const schema = z.object({ retries: z.number() });

      try {
        resolveActivating({
          name: 'layered',
          configSchema: schema,
          configDefaults: undefined,
          storedConfig: undefined,
          operatorEntry: operatorValue({ retries: 'not-a-number' }),
        });
        expect.unreachable('resolveConfig should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain(OPERATOR_SOURCE);
        expect((err as Error).message).toContain('retries');
      }
    });

    it('attaches the untruncated schema rejection as the error cause', () => {
      const schema = z.object({ retries: z.number() });

      try {
        resolveActivating({
          name: 'layered',
          configSchema: schema,
          configDefaults: { retries: 1 },
          storedConfig: undefined,
          operatorEntry: operatorValue({ retries: 'not-a-number' }),
        });
        expect.unreachable('resolveConfig should have thrown');
      } catch (err) {
        expect((err as ExtensionOperatorConfigError).cause).toBeInstanceOf(z.ZodError);
      }
    });

    it('preserves the warn-and-default path when no operator entry is present', () => {
      const schema = z.object({ retries: z.number().default(3) });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolved = resolveActivating({
        name: 'layered',
        configSchema: schema,
        configDefaults: undefined,
        storedConfig: { retries: 'not-a-number' },
        operatorEntry: undefined,
      });

      expect(resolved).toEqual({ retries: 3 });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Config parse failed for "layered"'),
        expect.any(String),
      );
      warnSpy.mockRestore();
    });

    it('returns undefined when no schema is declared and the operator entry is usable', () => {
      expect(
        resolveActivating({
          name: 'layered',
          configSchema: undefined,
          configDefaults: { a: 1 },
          storedConfig: { b: 2 },
          operatorEntry: operatorValue({ c: 3 }),
        }),
      ).toBeUndefined();
    });
  });
});
