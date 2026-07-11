import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { getProviderConfigDetailView, listCompatibleAuthOptions } from './selectors.js';

const SAFE_CONFIG = {
  id: 'cfg-anthropic',
  definitionId: 'anthropic',
  name: 'Anthropic',
  modelFilterMode: 'show-all' as const,
  isDefault: true,
  enabled: true,
  auth: {
    mode: 'explicit' as const,
    method: { owner: 'provider' as const, providerDefinitionId: 'anthropic', methodId: 'api-key' },
    hasCredentials: true as const,
  },
};

describe('provider config selectors', () => {
  it('builds detail from the safe summary without requesting runtime credential refs', async () => {
    const bus = createBusInstance();
    bus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => ctx.setResult({ config: SAFE_CONFIG }));
    bus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({
        provider: {
          id: 'anthropic',
          packageName: '@makaio/provider-anthropic',
          name: 'Anthropic',
          endpoints: { anthropic: 'https://api.anthropic.test' },
          availableModels: [],
          authMethods: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    });

    await expect(getProviderConfigDetailView(bus, SAFE_CONFIG.id)).resolves.toEqual({
      ...SAFE_CONFIG,
      supportedProtocols: ['anthropic'],
    });
  });

  it('returns null for a missing safe config without reading provider metadata', async () => {
    const bus = createBusInstance();
    let providerReads = 0;
    bus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => ctx.setResult({ config: null }));
    bus.on(ProviderStorageSubjects.get, () => {
      providerReads += 1;
      throw new Error('provider metadata must not be read for a missing config');
    });

    await expect(getProviderConfigDetailView(bus, 'missing')).resolves.toBeNull();
    expect(providerReads).toBe(0);
  });

  it('returns compatible method definitions without refs or plaintext', async () => {
    const bus = createBusInstance();
    const option = {
      definitionId: 'anthropic',
      method: { owner: 'client' as const, clientId: 'claude-code', methodId: 'native' },
      mode: 'inferred' as const,
      label: 'Claude Code sign-in',
      fields: [],
      compatibleAdapterNames: ['claude-code-cli'],
      portability: 'local-only' as const,
    };
    bus.on(AdapterSubsystemSubjects.listCompatibleAuthOptions, (ctx) => ctx.setResult({ options: [option] }));

    const options = await listCompatibleAuthOptions(bus, 'anthropic');
    expect(options).toEqual([option]);
    expect(JSON.stringify(options)).not.toContain('credentialRefs');
  });
});
