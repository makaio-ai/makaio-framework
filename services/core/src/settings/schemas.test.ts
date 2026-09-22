import { describe, expect, it } from 'vitest';
import { AdapterInfoSchema, SettingsSchemas } from './schemas.js';

describe('AdapterInfoSchema', () => {
  it('requires the canonical readiness derived by the adapter subsystem', () => {
    expect(
      AdapterInfoSchema.safeParse({
        adapterName: 'claude-code',
        displayName: 'Claude Code',
        enabled: true,
        configCount: 1,
        supportsLogImport: false,
      }).success,
    ).toBe(false);
  });
});

describe('SettingsSchemas extension.getConfigSchema response', () => {
  const responseSchema = SettingsSchemas['extension.getConfigSchema'].response;

  it('accepts a response without operatorConfig', () => {
    expect(responseSchema.safeParse({ hasSchema: false, schema: null, uiConfig: null }).success).toBe(true);
  });

  it('accepts a response with operatorConfig and round-trips its keys and values', () => {
    const input = {
      hasSchema: true,
      schema: { type: 'object', properties: { apiKey: { type: 'string' } } },
      uiConfig: null,
      operatorConfig: { source: '/etc/makaio/operator.json', keys: ['apiKey'], values: { apiKey: 'op-key' } },
    };
    const result = responseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.operatorConfig).toEqual({
      source: '/etc/makaio/operator.json',
      keys: ['apiKey'],
      values: { apiKey: 'op-key' },
    });
  });

  it('accepts operatorConfig without values so owned keys stay lockable when resolution fails', () => {
    const result = responseSchema.safeParse({
      hasSchema: true,
      schema: { type: 'object', properties: { apiKey: { type: 'string' } } },
      uiConfig: null,
      operatorConfig: { source: '/etc/makaio/operator.json', keys: ['apiKey'] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.operatorConfig?.keys).toEqual(['apiKey']);
    expect(result.data.operatorConfig?.values).toBeUndefined();
  });

  it('rejects operatorConfig without keys, since locking has no other source', () => {
    expect(
      responseSchema.safeParse({
        hasSchema: false,
        schema: null,
        uiConfig: null,
        operatorConfig: { source: '/etc/makaio/operator.json', values: { apiKey: 'op-key' } },
      }).success,
    ).toBe(false);
  });

  it('accepts a response where operatorConfig.values holds nested JSON values', () => {
    const input = {
      hasSchema: false,
      schema: null,
      uiConfig: null,
      operatorConfig: {
        source: '/etc/makaio/operator.json',
        keys: ['nested', 'count', 'tags'],
        values: { nested: { deep: true }, count: 42, tags: ['a', 'b'] },
      },
    };
    expect(responseSchema.safeParse(input).success).toBe(true);
  });
});
