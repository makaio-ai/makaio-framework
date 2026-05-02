import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { getProviderConfigDetailView } from './selectors.js';

describe('getProviderConfigDetailView', () => {
  it('omits empty credentialRefs so detail views do not treat "{}" as stored credentials', async () => {
    const bus = createBusInstance();

    bus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
      ctx.setResult({
        config: {
          id: 'cfg-empty-creds',
          definitionId: 'anthropic',
          name: 'Anthropic Empty',
          modelFilterMode: 'show-all',
          isDefault: false,
          enabled: true,
          isSentinel: false,
          hasCredentials: false,
        },
      });
    });

    bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
      ctx.setResult({
        context: {
          providerConfigId: 'cfg-empty-creds',
          definitionId: 'anthropic',
          credentialRefs: {},
        },
      });
    });

    bus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({
        provider: {
          id: 'anthropic',
          packageName: '@makaio/provider-anthropic',
          name: 'Anthropic',
          availableModels: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    });

    const detail = await getProviderConfigDetailView(bus, 'cfg-empty-creds');

    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty('credentialRefs');
  });

  it('returns null when context building observes a missing config', async () => {
    const bus = createBusInstance();

    bus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
      ctx.setResult({
        config: {
          id: 'cfg-deleted',
          definitionId: 'anthropic',
          name: 'Deleted Anthropic',
          modelFilterMode: 'show-all',
          isDefault: false,
          enabled: true,
          isSentinel: false,
          hasCredentials: false,
        },
      });
    });

    bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
      expect(ctx.payload.providerConfigId).toBe('cfg-deleted');
      ctx.setResult({ context: null });
    });

    bus.on(ProviderStorageSubjects.get, (ctx) => {
      expect(ctx.payload.id).toBe('anthropic');
      ctx.setResult({
        provider: {
          id: 'anthropic',
          packageName: '@makaio/provider-anthropic',
          name: 'Anthropic',
          availableModels: [],
          defaultModelFilterMode: 'show-all',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    });

    await expect(getProviderConfigDetailView(bus, 'cfg-deleted')).resolves.toBeNull();
  });

  it('returns null when config and context snapshots disagree on provider definition', async () => {
    const bus = createBusInstance();
    let providerLookupCount = 0;

    bus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
      ctx.setResult({
        config: {
          id: 'cfg-changed',
          definitionId: 'anthropic',
          name: 'Changed Anthropic',
          modelFilterMode: 'show-all',
          isDefault: false,
          enabled: true,
          isSentinel: false,
          hasCredentials: false,
        },
      });
    });

    bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
      expect(ctx.payload.providerConfigId).toBe('cfg-changed');
      ctx.setResult({
        context: {
          providerConfigId: 'cfg-changed',
          definitionId: 'openai',
          credentialRefs: {},
        },
      });
    });

    bus.on(ProviderStorageSubjects.get, () => {
      providerLookupCount += 1;
      throw new Error('Provider lookup should be skipped for mismatched config/context snapshots');
    });

    await expect(getProviderConfigDetailView(bus, 'cfg-changed')).resolves.toBeNull();
    expect(providerLookupCount).toBe(0);
  });
});
