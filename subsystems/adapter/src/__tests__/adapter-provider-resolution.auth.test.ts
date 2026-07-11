import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { defineAdapterProviderAuth, type ProviderDefinitionInput } from '@makaio/contracts';
import { ClientDefinitionSchema } from '@makaio/contracts/client';
import { resolveProviderDefinitions, type ProviderDefinitionCacheEntry } from '../adapter-provider-resolution.js';

const providerDefinition = {
  id: 'test-provider',
  name: 'Test Provider',
  authMethods: [
    {
      id: 'api-key',
      mode: 'explicit',
      label: 'API key',
      fields: [
        {
          id: 'apiKey',
          label: 'API key',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'PROVIDER_SOURCE_TOKEN' }],
        },
      ],
    },
  ],
} satisfies ProviderDefinitionInput;

const clientDefinition = ClientDefinitionSchema.parse({
  id: 'test-client',
  name: 'Test Client',
  version: '1.0.0',
  nativeTools: [],
  defaultApprovalPolicy: 'always-ask',
  authMethods: [
    {
      id: 'access-token',
      mode: 'explicit',
      label: 'Access token',
      fields: [
        {
          id: 'accessToken',
          label: 'Access token',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'CLIENT_SOURCE_TOKEN' }],
        },
      ],
    },
  ],
});

const providerCache = new Map<string, ProviderDefinitionCacheEntry>([
  ['test-provider', { packageName: '@makaio/provider-test', definition: providerDefinition }],
]);

describe('resolveProviderDefinitions normalized auth', () => {
  it('derives the scrub union from provider and executable client source hints', async () => {
    const auth = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'api-key' },
          deliveries: [{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }],
        },
      ],
      scrubEnvVars: ['AUTH_MODE_CONTROL'],
    });

    const providers = await resolveProviderDefinitions(
      MakaioBus,
      [{ definitionId: 'test-provider', auth }],
      'test-adapter',
      { clientDefinitions: [clientDefinition], providerDefinitionCache: providerCache },
    );

    expect(providers[0]?.auth?.scrubEnvVars).toEqual([
      'AUTH_MODE_CONTROL',
      'PROVIDER_SOURCE_TOKEN',
      'CLIENT_SOURCE_TOKEN',
    ]);
  });

  it('rejects a contribution whose delivery family contradicts the resolved method', async () => {
    const auth = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'api-key' },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: [],
    });

    await expect(
      resolveProviderDefinitions(MakaioBus, [{ definitionId: 'test-provider', auth }], 'test-adapter', {
        clientDefinitions: [clientDefinition],
        providerDefinitionCache: providerCache,
      }),
    ).rejects.toThrow(/Explicit authentication requires/);
  });
});
