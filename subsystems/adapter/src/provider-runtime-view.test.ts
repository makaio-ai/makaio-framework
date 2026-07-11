import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { ClientAuthMethodDefinition, ProviderAuthMethodDefinition } from '@makaio/contracts/auth';
import {
  CredentialRefSchema,
  PROVIDER_CONFIG_SCHEMA_VERSION,
  ProviderConfigFileSchema,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import {
  ClientStorageSubjects,
  ProviderStorageSubjects,
  type ClientRecord,
  type ProviderRecord,
} from '@makaio/services-core/settings/storage';
import { ProviderConfigAuthValidationError } from './provider-config-auth-validation.js';
import { buildProviderRuntimeContextFromRaw, ProviderRuntimeContextError } from './provider-runtime-view.js';

const API_KEY_METHOD = {
  id: 'api-key',
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
} satisfies ProviderAuthMethodDefinition;

const SECOND_PROVIDER_METHOD = {
  id: 'service-account',
  mode: 'explicit',
  label: 'Service account',
  fields: [
    {
      id: 'token',
      label: 'Token',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_SERVICE_TOKEN' }],
    },
  ],
} satisfies ProviderAuthMethodDefinition;

const CLIENT_NATIVE_METHOD = {
  id: 'native',
  mode: 'inferred',
  label: 'Native sign-in',
} satisfies ClientAuthMethodDefinition;

const CLIENT_TOKEN_METHOD = {
  id: 'oauth-token',
  mode: 'explicit',
  label: 'OAuth token',
  fields: [
    {
      id: 'oauthToken',
      label: 'OAuth token',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'CLAUDE_CODE_OAUTH_TOKEN' }],
    },
  ],
} satisfies ClientAuthMethodDefinition;

let cleanupFns: Array<() => void>;

/**
 * Build a complete provider storage record for runtime-context tests.
 * @param overrides - Provider-record fields overridden by the fixture.
 */
function providerRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'anthropic',
    packageName: '@makaio/provider-anthropic',
    name: 'Anthropic',
    endpoints: { anthropic: 'https://api.anthropic.test' },
    availableModels: [],
    authMethods: [API_KEY_METHOD, SECOND_PROVIDER_METHOD],
    defaultModelFilterMode: 'show-all',
    capabilities: { structuredOutput: true },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * Build a complete client storage record for runtime-context tests.
 * @param overrides - Client-record fields overridden by the fixture.
 */
function clientRecord(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: 'claude-code',
    packageName: '@makaio/client-claude-code',
    name: 'Claude Code',
    nativeTools: [],
    defaultApprovalPolicy: 'always-ask',
    authMethods: [CLIENT_NATIVE_METHOD, CLIENT_TOKEN_METHOD],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * Register definition storage reads used by the real runtime builder.
 * @param provider - Provider record returned by storage.
 * @param client - Optional client record returned by storage.
 */
function registerDefinitions(provider: ProviderRecord | null, client: ClientRecord | null = null): void {
  cleanupFns.push(
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({ provider });
    }),
    MakaioBus.on(ClientStorageSubjects.get, (ctx) => {
      ctx.setResult({ client });
    }),
  );
}

/**
 * Build a schema-validated provider config.
 * @param auth - Normalized authentication selection.
 * @param enabled - Whether the provider config is enabled.
 */
function providerConfig(auth: ProviderConfigFile['auth'], enabled = true): ProviderConfigFile {
  return ProviderConfigFileSchema.parse({
    $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
    definitionId: 'anthropic',
    name: 'Anthropic Work',
    auth,
    endpointOverrides: { anthropic: 'https://override.anthropic.test' },
    isDefault: enabled,
    enabled,
  });
}

beforeEach(() => {
  cleanupFns = [];
  MakaioBus.__resetHandlers?.();
});

afterEach(() => {
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  MakaioBus.__resetHandlers?.();
});

describe('buildProviderRuntimeContextFromRaw', () => {
  it('builds a refs-only explicit context from the exact provider method', async () => {
    registerDefinitions(providerRecord());
    const raw = providerConfig({
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
      credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
    });

    await expect(buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-work', raw)).resolves.toEqual({
      context: {
        state: 'resolved',
        providerConfigId: 'anthropic-work',
        definitionId: 'anthropic',
        endpointOverrides: { anthropic: 'https://override.anthropic.test' },
        auth: {
          mode: 'explicit',
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          definition: API_KEY_METHOD,
          credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
        },
        capabilities: { structuredOutput: true },
      },
      definition: providerRecord(),
    });
  });

  it('resolves client-owned native auth without embedding adapter-specific scrub metadata', async () => {
    registerDefinitions(providerRecord(), clientRecord());
    const raw = providerConfig({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      account: { managerId: 'claude-accounts', accountId: 'work' },
    });

    const { context } = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-native', raw);

    expect(context.auth).toEqual({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
      definition: CLIENT_NATIVE_METHOD,
      account: { managerId: 'claude-accounts', accountId: 'work' },
    });
    expect(context).not.toHaveProperty('credentialRefs');
    expect(context).not.toHaveProperty('credentialEnvVars');
    expect(context).not.toHaveProperty('isSentinel');
  });

  it('rejects an exact-method mode mismatch with a typed validation error', async () => {
    registerDefinitions(providerRecord());
    const raw = providerConfig({
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
    });

    const error = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-work', raw).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderConfigAuthValidationError);
    expect((error as ProviderConfigAuthValidationError).code).toBe('auth-mode-mismatch');
  });

  it('rejects missing required and unexpected explicit refs before adapter startup', async () => {
    registerDefinitions(providerRecord());
    const raw = providerConfig({
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
      credentialRefs: { unexpected: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
    });

    const error = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-work', raw).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderConfigAuthValidationError);
    expect((error as ProviderConfigAuthValidationError).code).toBe('auth-credential-fields-mismatch');
  });

  it('rejects a dangling client method owner with a typed validation error', async () => {
    registerDefinitions(providerRecord(), null);
    const raw = providerConfig({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'removed-client', methodId: 'native' },
    });

    const error = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-native', raw).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderConfigAuthValidationError);
    expect((error as ProviderConfigAuthValidationError).code).toBe('client-definition-not-found');
  });

  it('rejects disabled configs before reading definition storage', async () => {
    let providerReads = 0;
    cleanupFns.push(
      MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
        providerReads += 1;
        ctx.setResult({ provider: providerRecord() });
      }),
    );
    const raw = providerConfig(
      {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
      },
      false,
    );

    const error = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-disabled', raw).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderRuntimeContextError);
    expect((error as ProviderRuntimeContextError).code).toBe('provider-config-disabled');
    expect(providerReads).toBe(0);
  });

  it('rejects disabled provider definitions with a typed validation error', async () => {
    registerDefinitions(providerRecord({ enabled: false }));
    const raw = providerConfig({
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
      credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
    });

    const error = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-work', raw).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderConfigAuthValidationError);
    expect((error as ProviderConfigAuthValidationError).code).toBe('provider-definition-disabled');
  });

  it('rejects disabled client definitions with a typed validation error', async () => {
    registerDefinitions(providerRecord(), clientRecord({ enabled: false }));
    const raw = providerConfig({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
    });

    const error = await buildProviderRuntimeContextFromRaw(MakaioBus, 'anthropic-native', raw).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(ProviderConfigAuthValidationError);
    expect((error as ProviderConfigAuthValidationError).code).toBe('client-definition-disabled');
  });
});
