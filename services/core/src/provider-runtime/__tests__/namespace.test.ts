import { describe, expect, it } from 'vitest';
import { ProviderRuntimeSchemas, ProviderRuntimeSubjects } from '../namespace.js';

describe('provider-runtime namespace', () => {
  it('registers fetchModels as the runtime-only provider model seam', () => {
    expect(ProviderRuntimeSubjects.fetchModels).toMatchObject({
      subject: 'fetchModels',
      $meta: {
        namespace: 'providerRuntime',
      },
    });
  });

  it('keys fetchModels requests by providerConfigId', () => {
    expect(ProviderRuntimeSchemas.fetchModels.request.safeParse({ providerConfigId: 'anthropic-work' }).success).toBe(
      true,
    );
    expect(ProviderRuntimeSchemas.fetchModels.request.safeParse({ id: 'anthropic-work' }).success).toBe(false);
  });
});
