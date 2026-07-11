import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannelEndpoint, MakaioBus, type ChannelEndpoint } from '@makaio/bus-core';
import {
  AuthCredentialRefSchema,
  CredentialSubjects,
  type ProviderAuthMethodDefinition,
  type ResolvedProviderAuth,
} from '@makaio/contracts';
import { AdapterSubsystemSubjects, type ProviderRuntimeSnapshot } from '@makaio/services-core/adapter-subsystem';
import { ProviderEndpointAuthError, resolveProviderEndpoint } from '../resolve-provider-endpoint.js';
import { resolveProviderResolution } from '../resolve-provider-resolution.js';

const API_KEY_METHOD = {
  id: 'api-key',
  mode: 'explicit',
  label: 'API key',
  fields: [{ id: 'apiKey', label: 'API key', required: true, secret: true, sourceHints: [] }],
} satisfies ProviderAuthMethodDefinition;
const EXPLICIT_AUTH: ResolvedProviderAuth = {
  mode: 'explicit',
  method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'api-key' },
  definition: API_KEY_METHOD,
  credentialRefs: { apiKey: AuthCredentialRefSchema.parse('env:SELECTED_API_KEY') },
};
const TOKEN_AUTH: ResolvedProviderAuth = {
  mode: 'explicit',
  method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'token' },
  definition: {
    id: 'token',
    mode: 'explicit',
    label: 'Token',
    fields: [{ id: 'token', label: 'Token', required: true, secret: true, sourceHints: [] }],
  },
  credentialRefs: { token: AuthCredentialRefSchema.parse('env:SELECTED_TOKEN') },
};
const MULTI_FIELD_AUTH: ResolvedProviderAuth = {
  mode: 'explicit',
  method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'multi-field' },
  definition: {
    id: 'multi-field',
    mode: 'explicit',
    label: 'Multi-field API key',
    fields: [
      { id: 'apiKey', label: 'API key', required: true, secret: true, sourceHints: [] },
      { id: 'tenant', label: 'Tenant', required: true, secret: false, sourceHints: [] },
    ],
  },
  credentialRefs: {
    apiKey: AuthCredentialRefSchema.parse('env:SELECTED_API_KEY'),
    tenant: AuthCredentialRefSchema.parse('env:SELECTED_TENANT'),
  },
};
const NONE_AUTH: ResolvedProviderAuth = {
  mode: 'none',
  method: { owner: 'provider', providerDefinitionId: 'provider-1', methodId: 'public' },
  definition: { id: 'public', mode: 'none', label: 'Public endpoint' },
};
const INFERRED_AUTH: ResolvedProviderAuth = {
  mode: 'inferred',
  method: { owner: 'client', clientId: 'native-client', methodId: 'native' },
  definition: { id: 'native', mode: 'inferred', label: 'Native client' },
};
const API_KEY_REQUIREMENT = { kind: 'api-key', credentialFieldId: 'apiKey' } as const;

/**
 * Build an atomic provider snapshot for one normalized auth mode.
 * @param auth - Resolved auth selection carried by the snapshot
 * @returns Atomic provider snapshot with a matching safe auth summary
 */
function providerSnapshot(auth: ResolvedProviderAuth): ProviderRuntimeSnapshot {
  const summary =
    auth.mode === 'explicit'
      ? { mode: 'explicit' as const, method: auth.method, hasCredentials: true as const }
      : auth.mode === 'inferred'
        ? { mode: 'inferred' as const, method: auth.method, hasCredentials: false as const }
        : { mode: 'none' as const, method: auth.method, hasCredentials: false as const };
  const providerAuthMethods: ProviderAuthMethodDefinition[] =
    auth.mode !== 'inferred' && auth.method.owner === 'provider' ? [auth.definition] : [];

  return {
    config: {
      id: 'config-1',
      definitionId: 'provider-1',
      name: 'Provider Config',
      endpointOverrides: { openai: 'https://override.example/v1' },
      modelFilterMode: 'show-all',
      isDefault: true,
      enabled: true,
      auth: summary,
    },
    context: {
      state: 'resolved',
      providerConfigId: 'config-1',
      definitionId: 'provider-1',
      endpointOverrides: { openai: 'https://override.example/v1' },
      auth,
    },
    definition: {
      id: 'provider-1',
      packageName: '@makaio/provider-test',
      name: 'Provider',
      endpoints: { openai: 'https://default.example/v1' },
      availableModels: [],
      defaultModelFilterMode: 'show-all',
      authMethods: providerAuthMethods,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/**
 * Register the atomic provider snapshot read used by the real endpoint helpers.
 * @param auth - Resolved auth selection returned by the snapshot handler
 * @returns Handler cleanup callback
 */
function setupSnapshot(auth: ResolvedProviderAuth): () => void {
  return MakaioBus.on(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, ({ payload, setResult }) => {
    expect(payload.providerConfigId).toBe('config-1');
    setResult({ snapshot: providerSnapshot(auth) });
  });
}

/**
 * Register the real encrypted credential channel for an explicit API key.
 * @param value - Plaintext fixture value, or null when unavailable
 * @returns Cleanup callbacks for the bus handler and channel endpoint
 */
function setupCredentialChannel(value: string | null): Array<() => void> {
  const token = 'provider-endpoint-test-token';
  const offToken = MakaioBus.on(CredentialSubjects.getChannelToken, ({ setResult }) => {
    setResult({ token });
  });
  const endpoint: ChannelEndpoint = createChannelEndpoint(
    MakaioBus.getContext(),
    'credentials',
    (channel) => {
      channel.on(CredentialSubjects.resolve, ({ payload, setResult }) => {
        expect(payload.ref).toBe('env:SELECTED_API_KEY');
        setResult({ value });
      });
    },
    { token },
  );
  return [offToken, () => endpoint.close()];
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('provider endpoint resolution', () => {
  it.each([
    ['explicit', EXPLICIT_AUTH],
    ['inferred', INFERRED_AUTH],
    ['none', NONE_AUTH],
  ] as const)('resolves static and override endpoint metadata for %s auth without materializing secrets', async (_mode, auth) => {
    const cleanup = setupSnapshot(auth);

    await expect(resolveProviderResolution(MakaioBus, 'config-1', 'openai')).resolves.toMatchObject({
      baseUrl: 'https://override.example/v1',
      auth: { mode: auth.mode },
    });
    cleanup();
  });

  it('resolves the selected explicit API-key ref exactly once for an authenticated direct fetch', async () => {
    const cleanup = setupSnapshot(EXPLICIT_AUTH);
    const credentialCleanups = setupCredentialChannel('selected-api-key');

    await expect(resolveProviderEndpoint(MakaioBus, 'config-1', 'openai', API_KEY_REQUIREMENT)).resolves.toEqual({
      baseUrl: 'https://override.example/v1',
      apiKey: 'selected-api-key',
    });
    credentialCleanups.reverse().forEach((dispose) => dispose());
    cleanup();
  });

  it.each([
    ['inferred', INFERRED_AUTH],
    ['none', NONE_AUTH],
  ] as const)('rejects %s auth for an API-key fetch without opening the credential channel', async (_mode, auth) => {
    const cleanup = setupSnapshot(auth);
    const tokenRequest = vi.fn();
    const offToken = MakaioBus.on(CredentialSubjects.getChannelToken, () => {
      tokenRequest();
    });

    await expect(resolveProviderEndpoint(MakaioBus, 'config-1', 'openai', API_KEY_REQUIREMENT)).rejects.toMatchObject({
      code: 'fetch-auth-unsupported',
    } satisfies Partial<ProviderEndpointAuthError>);
    expect(tokenRequest).not.toHaveBeenCalled();
    offToken();
    cleanup();
  });

  it('reports an unavailable explicit API key as a typed credential-free failure', async () => {
    const cleanup = setupSnapshot(EXPLICIT_AUTH);
    const credentialCleanups = setupCredentialChannel(null);

    const error = await resolveProviderEndpoint(MakaioBus, 'config-1', 'openai', API_KEY_REQUIREMENT).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderEndpointAuthError);
    expect(error).toMatchObject({ code: 'fetch-auth-missing' });
    expect(String(error)).not.toContain('SELECTED_API_KEY');
    credentialCleanups.reverse().forEach((dispose) => dispose());
    cleanup();
  });

  it('rejects a non-API-key explicit method before opening the credential channel', async () => {
    const cleanup = setupSnapshot(TOKEN_AUTH);
    const tokenRequest = vi.fn();
    const offToken = MakaioBus.on(CredentialSubjects.getChannelToken, () => {
      tokenRequest();
    });

    await expect(resolveProviderEndpoint(MakaioBus, 'config-1', 'openai', API_KEY_REQUIREMENT)).rejects.toMatchObject({
      code: 'fetch-auth-unsupported',
    } satisfies Partial<ProviderEndpointAuthError>);
    expect(tokenRequest).not.toHaveBeenCalled();
    offToken();
    cleanup();
  });

  it('resolves the consumer-selected API key without rejecting or resolving other method fields', async () => {
    const cleanup = setupSnapshot(MULTI_FIELD_AUTH);
    const credentialCleanups = setupCredentialChannel('selected-api-key');

    await expect(resolveProviderEndpoint(MakaioBus, 'config-1', 'openai', API_KEY_REQUIREMENT)).resolves.toEqual({
      baseUrl: 'https://override.example/v1',
      apiKey: 'selected-api-key',
    });
    credentialCleanups.reverse().forEach((dispose) => dispose());
    cleanup();
  });
});
