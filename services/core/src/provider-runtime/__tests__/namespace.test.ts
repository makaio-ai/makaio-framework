import { describe, expect, it } from 'vitest';
import { ProviderRuntimeSchemas, ProviderRuntimeSubjects } from '../namespace.js';

describe('provider-runtime namespace', () => {
  it('registers live model-discovery reads as runtime-only provider seams', () => {
    expect(ProviderRuntimeSubjects.listModelFetchAdapters).toMatchObject({
      subject: 'listModelFetchAdapters',
      $meta: {
        namespace: 'providerRuntime',
      },
    });
    expect(ProviderRuntimeSubjects.fetchModels).toMatchObject({
      subject: 'fetchModels',
      $meta: {
        namespace: 'providerRuntime',
      },
    });
  });

  it('requires a provider config for capability discovery', () => {
    expect(
      ProviderRuntimeSchemas.listModelFetchAdapters.request.safeParse({ providerConfigId: 'anthropic-work' }).success,
    ).toBe(true);
    expect(ProviderRuntimeSchemas.listModelFetchAdapters.request.safeParse({}).success).toBe(false);
  });

  it('requires an exact adapter and provider config for fetchModels requests', () => {
    expect(
      ProviderRuntimeSchemas.fetchModels.request.safeParse({
        adapterName: 'claude-agent-sdk',
        providerConfigId: 'anthropic-work',
      }).success,
    ).toBe(true);
    expect(ProviderRuntimeSchemas.fetchModels.request.safeParse({ providerConfigId: 'anthropic-work' }).success).toBe(
      false,
    );
    expect(ProviderRuntimeSchemas.fetchModels.request.safeParse({ id: 'anthropic-work' }).success).toBe(false);
  });
});
