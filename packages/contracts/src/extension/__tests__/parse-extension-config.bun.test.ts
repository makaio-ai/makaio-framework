import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { parseExtensionConfig } from '../parse-extension-config.js';

const TestConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retries: z.number().default(3),
  label: z.string().optional(),
});

describe('parseExtensionConfig', () => {
  it('applies schema defaults when rawConfig is undefined', () => {
    const config = parseExtensionConfig(TestConfigSchema, undefined);
    expect(config).toStrictEqual({ enabled: true, retries: 3 });
  });

  it('applies schema defaults for missing fields in partial config', () => {
    const config = parseExtensionConfig(TestConfigSchema, { retries: 5 });
    expect(config).toStrictEqual({ enabled: true, retries: 5 });
  });

  it('passes through a fully-specified config', () => {
    const config = parseExtensionConfig(TestConfigSchema, {
      enabled: false,
      retries: 1,
      label: 'custom',
    });
    expect(config).toStrictEqual({ enabled: false, retries: 1, label: 'custom' });
  });

  it('throws on invalid config values', () => {
    expect(() => parseExtensionConfig(TestConfigSchema, { retries: 'not-a-number' })).toThrow();
  });
});
