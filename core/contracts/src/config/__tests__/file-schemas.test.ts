import { describe, expect, it } from 'vitest';
import { AdapterFileSchema } from '../adapter-file.js';
import { ProviderConfigFileSchema } from '../provider-config-file.js';

describe('ProviderConfigFileSchema', () => {
  it('accepts a minimal provider config file', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a full provider config file', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
      },
      managedBy: { kind: 'client', clientId: 'claude-code' },
      endpointOverrides: { anthropic: 'https://custom.api.com' },
      modelFilterMode: 'allowlist',
      modelVisibility: { 'claude-sonnet-4-6': 'enabled' },
      isDefault: true,
      enabled: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.definitionId).toBe('anthropic');
      expect(result.data.name).toBe('Anthropic Work');
    }
  });

  it('rejects missing $schema', () => {
    const result = ProviderConfigFileSchema.safeParse({
      definitionId: 'anthropic',
    });

    expect(result.success).toBe(false);
  });

  it('rejects blank provider config names', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
      name: '   ',
    });

    expect(result.success).toBe(false);
  });

  it('rejects blank provider definition ids', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: '   ',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects cleartext credential strings inside explicit auth', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: 'fake-api-key-for-test' },
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts stored credential refs inside explicit auth', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: 'stored:providerConfig:anthropic-work:apiKey' },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects extra top-level provider config fields instead of stripping them', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
      typo: 'should-fail',
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown endpoint override keys instead of stripping them', () => {
    const result = ProviderConfigFileSchema.safeParse({
      $schema: 'makaio/provider-config/v2',
      definitionId: 'anthropic',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
      },
      endpointOverrides: {
        anthropic: 'https://custom.api.com',
        typo: 'https://should-fail.example.com',
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires auth and rejects legacy credentials and sentinel fields', () => {
    expect(
      ProviderConfigFileSchema.safeParse({
        $schema: 'makaio/provider-config/v2',
        definitionId: 'anthropic',
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigFileSchema.safeParse({
        $schema: 'makaio/provider-config/v2',
        definitionId: 'anthropic',
        auth: {
          mode: 'none',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
        },
        credentials: {},
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigFileSchema.safeParse({
        $schema: 'makaio/provider-config/v2',
        definitionId: 'anthropic',
        auth: {
          mode: 'none',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'none' },
        },
        isSentinel: false,
      }).success,
    ).toBe(false);
  });
});

describe('AdapterFileSchema', () => {
  it('accepts a minimal adapter file', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a full adapter file', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      enabled: true,
      displayName: 'Claude Agent SDK',
      settings: { maxConcurrency: 5 },
      bindings: [{ providerConfigId: 'anthropic-work', isDefault: true }, { providerConfigId: 'anthropic-personal' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.displayName).toBe('Claude Agent SDK');
      expect(result.data.settings).toEqual({ maxConcurrency: 5 });
      expect(result.data.bindings).toHaveLength(2);
      expect(result.data.bindings?.[0]).toEqual({
        providerConfigId: 'anthropic-work',
        isDefault: true,
      });
      expect(result.data.bindings?.[1]).toEqual({
        providerConfigId: 'anthropic-personal',
      });
    }
  });

  it('rejects extra adapter file fields instead of stripping them', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      displayName: 'Claude Agent SDK',
      bindings: [
        {
          providerConfigId: 'anthropic-work',
          isDefault: true,
          typo: 'should-fail',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects extra top-level adapter file fields instead of stripping them', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      displayName: 'Claude Agent SDK',
      typo: 'should-fail',
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate binding providerConfigIds', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      bindings: [{ providerConfigId: 'anthropic-work', isDefault: true }, { providerConfigId: 'anthropic-work' }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects multiple default bindings', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      bindings: [
        { providerConfigId: 'anthropic-work', isDefault: true },
        { providerConfigId: 'anthropic-personal', isDefault: true },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects malformed help links', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      helpLinks: [{ label: '', url: 'not-a-url' }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects blank binding providerConfigIds', () => {
    const result = AdapterFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v1',
      bindings: [{ providerConfigId: '   ', isDefault: true }],
    });

    expect(result.success).toBe(false);
  });
});
