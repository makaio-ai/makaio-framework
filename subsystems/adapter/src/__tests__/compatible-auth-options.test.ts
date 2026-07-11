import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { VersionRangeSchema, defineAdapterProviderAuth } from '@makaio/contracts';
import { ClientStorageSubjects } from '@makaio/services-core/settings/storage';
import { buildCompatibleAuthOptions } from '../compatible-auth-options.js';
import type { LoadedAdapter } from '../adapter-runtime-types.js';

const apiKeyMethod = {
  id: 'api-key',
  mode: 'explicit' as const,
  label: 'API key',
  fields: [
    {
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment' as const, variable: 'ANTHROPIC_API_KEY' }],
    },
  ],
};

const nativeMethod = {
  id: 'native',
  mode: 'inferred' as const,
  label: 'Native login',
};

/**
 * Build a loaded adapter with normalized auth bindings for option aggregation.
 * @param name - Adapter name.
 * @param includeProviderMethod - Whether the provider declaration contains the bound method.
 * @param providerMethod - Provider method declaration included in the fixture.
 * @returns Loaded adapter fixture.
 */
function createLoadedAdapter(
  name: string,
  includeProviderMethod = true,
  providerMethod: typeof apiKeyMethod = apiKeyMethod,
): LoadedAdapter {
  const auth = defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider' as const, providerDefinitionId: 'anthropic', methodId: 'api-key' },
        deliveries: [{ kind: 'process-env' as const, fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
      },
      {
        method: { owner: 'client' as const, clientId: 'claude-code', methodId: 'native' },
        deliveries: [{ kind: 'native-client' as const, clientId: 'claude-code' }],
      },
    ],
    scrubEnvVars: ['ANTHROPIC_API_KEY'],
  });

  return {
    name,
    displayName: name,
    packageName: `@makaio/adapter-${name}`,
    factory: async () => ({}),
    options: {},
    providerDefinitionIds: ['anthropic'],
    providerRefs: [{ definitionId: 'anthropic', auth }],
    providers: [
      {
        definition: {
          id: 'anthropic',
          name: 'Anthropic',
          authMethods: includeProviderMethod ? [providerMethod] : [],
        },
        providerPackageName: '@makaio/provider-anthropic',
        auth,
      },
    ],
    clients: [{ id: 'claude-code', version: VersionRangeSchema.parse('*') }],
    protocol: 'anthropic',
  };
}

/**
 * Register the authoritative Claude client definition used by the fixtures.
 * @returns Handler cleanup callback.
 */
function registerClaudeClientStorageHandler(): () => void {
  return MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
    ctx.setResult({
      client: {
        id: 'claude-code',
        packageName: '@makaio/client-claude-code',
        name: 'Claude Code',
        nativeTools: [],
        defaultApprovalPolicy: 'always-ask',
        authMethods: [nativeMethod],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
  });
}

describe('buildCompatibleAuthOptions', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('combines provider/client declarations with adapter bindings without exposing refs', async () => {
    const offClient = registerClaudeClientStorageHandler();

    try {
      const options = await buildCompatibleAuthOptions(
        MakaioBus,
        [createLoadedAdapter('claude-z'), createLoadedAdapter('claude-a')],
        'anthropic',
      );

      expect(options).toEqual([
        {
          definitionId: 'anthropic',
          method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
          mode: 'inferred',
          label: 'Native login',
          fields: [],
          compatibleAdapterNames: ['claude-a', 'claude-z'],
          portability: 'local-only',
        },
        {
          definitionId: 'anthropic',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          mode: 'explicit',
          label: 'API key',
          fields: [
            {
              id: 'apiKey',
              label: 'API key',
              required: true,
              secret: true,
              sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
            },
          ],
          compatibleAdapterNames: ['claude-a', 'claude-z'],
          portability: 'portable',
        },
      ]);
      expect(JSON.stringify(options)).not.toContain('credentialRefs');
    } finally {
      offClient();
    }
  });

  it('fails dangling binding definitions instead of deriving a method from provider identity', async () => {
    await expect(
      buildCompatibleAuthOptions(MakaioBus, [createLoadedAdapter('claude-code', false)], 'anthropic'),
    ).rejects.toThrow(/binds undeclared provider auth method/);
  });

  it('rejects structurally valid bindings that cannot deliver the declared method mode', async () => {
    const adapter = createLoadedAdapter('claude-code');
    const provider = adapter.providers[0];
    if (provider === undefined) throw new Error('Expected provider fixture.');
    const invalidAuth = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: [],
    });
    const invalidAdapter: LoadedAdapter = {
      ...adapter,
      providerRefs: [{ definitionId: 'anthropic', auth: invalidAuth }],
      providers: [{ ...provider, auth: invalidAuth }],
    };

    await expect(buildCompatibleAuthOptions(MakaioBus, [invalidAdapter], 'anthropic')).rejects.toThrow(
      /Explicit authentication requires/,
    );
  });

  it('rejects conflicting declarations for one owner-qualified method', async () => {
    const offClient = registerClaudeClientStorageHandler();
    try {
      await expect(
        buildCompatibleAuthOptions(
          MakaioBus,
          [
            createLoadedAdapter('claude-a'),
            createLoadedAdapter('claude-z', true, { ...apiKeyMethod, label: 'Conflicting API key' }),
          ],
          'anthropic',
        ),
      ).rejects.toThrow(/has conflicting definitions across compatible adapters/);
    } finally {
      offClient();
    }
  });
});
