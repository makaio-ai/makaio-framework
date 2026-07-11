import { describe, expect, it } from 'vitest';
import { ClientDefinitionSchema } from '../../client/definition.js';
import { CredentialRefSchema } from '../../config/credential-ref.js';
import { PROVIDER_CONFIG_SCHEMA_VERSION, ProviderConfigFileSchema } from '../../config/provider-config-file.js';
import { ProviderDefinitionSchema } from '../../provider/definition.js';
import {
  AdapterAuthBindingSchema,
  AdapterProviderAuthSchema,
  AuthFieldIdSchema,
  AuthCredentialRefSchema,
  AuthCredentialSourceHintSchema,
  ClientAuthMethodsSchema,
  ConnectorAdapterAuthDeliverySchema,
  ExplicitAuthMethodDefinitionSchema,
  NativeClientAdapterAuthDeliverySchema,
  ProcessEnvAdapterAuthDeliverySchema,
  ProviderAuthMethodRefSchema,
  ProviderConfigAuthSchema,
  ResolvedProviderAuthSchema,
  assertAdapterAuthBindingMatchesMethod,
} from '../index.js';

const apiKeyField = {
  id: 'apiKey',
  label: 'API key',
  required: true,
  secret: true,
  sourceHints: [{ kind: 'environment', variable: 'TEST_API_KEY' }],
} as const;

const apiKeyMethod = {
  id: 'api-key',
  mode: 'explicit',
  label: 'API key',
  fields: [apiKeyField],
} as const;

const multiFieldApiKeyMethod = {
  ...apiKeyMethod,
  fields: [
    apiKeyField,
    {
      id: 'organizationId',
      label: 'Organization ID',
      required: false,
      secret: false,
      sourceHints: [],
    },
  ],
} as const;

const nativeMethod = {
  id: 'native',
  mode: 'inferred',
  label: 'Native account',
} as const;

const noAuthMethod = {
  id: 'none',
  mode: 'none',
  label: 'No authentication',
} as const;

describe('auth method definitions', () => {
  it('validates portable environment variable source hints strictly', () => {
    expect(AuthCredentialSourceHintSchema.parse({ kind: 'environment', variable: '_VALID_ENV_2' })).toEqual({
      kind: 'environment',
      variable: '_VALID_ENV_2',
    });

    expect(AuthCredentialSourceHintSchema.safeParse({ kind: 'environment', variable: 'INVALID-NAME' }).success).toBe(
      false,
    );
    expect(
      AuthCredentialSourceHintSchema.safeParse({
        kind: 'environment',
        variable: 'VALID_ENV',
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('requires at least one required field on every explicit method', () => {
    expect(ExplicitAuthMethodDefinitionSchema.safeParse({ ...apiKeyMethod, fields: [] }).success).toBe(false);
    expect(
      ExplicitAuthMethodDefinitionSchema.safeParse({
        ...apiKeyMethod,
        fields: [{ ...apiKeyField, required: false }],
      }).success,
    ).toBe(false);
    expect(ExplicitAuthMethodDefinitionSchema.safeParse(apiKeyMethod).success).toBe(true);
  });

  it('rejects duplicate credential field IDs', () => {
    expect(
      ExplicitAuthMethodDefinitionSchema.safeParse({
        ...apiKeyMethod,
        fields: [apiKeyField, { ...apiKeyField, label: 'Duplicate key' }],
      }).success,
    ).toBe(false);
  });

  it('rejects non-portable and prototype-sensitive credential field IDs', () => {
    for (const fieldId of ['contains.dot', '__proto__', 'constructor', 'prototype']) {
      expect(AuthFieldIdSchema.safeParse(fieldId).success).toBe(false);
      expect(
        ExplicitAuthMethodDefinitionSchema.safeParse({
          ...apiKeyMethod,
          fields: [{ ...apiKeyField, id: fieldId }],
        }).success,
      ).toBe(false);
    }
  });

  it('rejects duplicate method IDs for both provider and client owners', () => {
    expect(
      ProviderDefinitionSchema.safeParse({
        id: 'test-provider',
        name: 'Test Provider',
        authMethods: [apiKeyMethod, { ...noAuthMethod, id: apiKeyMethod.id }],
      }).success,
    ).toBe(false);
    expect(ClientAuthMethodsSchema.safeParse([nativeMethod, { ...noAuthMethod, id: nativeMethod.id }]).success).toBe(
      false,
    );
  });

  it('keeps provider modes provider-safe and permits all client modes', () => {
    expect(
      ProviderDefinitionSchema.safeParse({
        id: 'test-provider',
        name: 'Test Provider',
        authMethods: [nativeMethod],
      }).success,
    ).toBe(false);
    expect(ClientAuthMethodsSchema.safeParse([apiKeyMethod, nativeMethod, noAuthMethod]).success).toBe(true);
  });
});

describe('definition integration', () => {
  it('requires provider and client definitions to declare their auth method catalogs', () => {
    expect(ProviderDefinitionSchema.safeParse({ id: 'test-provider', name: 'Test Provider' }).success).toBe(false);
    expect(
      ClientDefinitionSchema.safeParse({
        id: 'test-client',
        name: 'Test Client',
        version: '1.0.0',
        defaultApprovalPolicy: 'always-ask',
      }).success,
    ).toBe(false);
    expect(
      ProviderDefinitionSchema.safeParse({ id: 'test-provider', name: 'Test Provider', authMethods: [] }).success,
    ).toBe(true);
    expect(
      ClientDefinitionSchema.safeParse({
        id: 'test-client',
        name: 'Test Client',
        version: '1.0.0',
        defaultApprovalPolicy: 'always-ask',
        authMethods: [],
      }).success,
    ).toBe(true);
  });

  it('rejects removed provider and client auth heuristics instead of stripping them', () => {
    expect(
      ProviderDefinitionSchema.safeParse({
        id: 'test-provider',
        name: 'Test Provider',
        authMethods: [apiKeyMethod],
        credentialEnvVars: { apiKey: 'TEST_API_KEY' },
      }).success,
    ).toBe(false);
    expect(
      ClientDefinitionSchema.safeParse({
        id: 'test-client',
        name: 'Test Client',
        version: '1.0.0',
        defaultApprovalPolicy: 'always-ask',
        authMethods: [nativeMethod],
        defaultProviderId: 'test-provider',
      }).success,
    ).toBe(false);
  });

  it('requires defaultAuth to reference an inferred method owned by the same client', () => {
    const baseDefinition = {
      id: 'test-client',
      name: 'Test Client',
      version: '1.0.0',
      defaultApprovalPolicy: 'always-ask',
      authMethods: [nativeMethod, apiKeyMethod],
    } as const;

    expect(
      ClientDefinitionSchema.safeParse({
        ...baseDefinition,
        defaultAuth: { providerDefinitionId: 'test-provider', methodId: nativeMethod.id },
      }).success,
    ).toBe(true);
    expect(
      ClientDefinitionSchema.safeParse({
        ...baseDefinition,
        defaultAuth: { providerDefinitionId: 'test-provider', methodId: apiKeyMethod.id },
      }).success,
    ).toBe(false);
    expect(
      ClientDefinitionSchema.safeParse({
        ...baseDefinition,
        defaultAuth: { providerDefinitionId: 'test-provider', methodId: 'missing' },
      }).success,
    ).toBe(false);
  });
});

describe('auth method refs and selections', () => {
  it('accepts resolvable credential sources but rejects legacy account-manager refs', () => {
    const resolvableRefs = [
      'env:TEST_API_KEY',
      'file:/tmp/test-api-key',
      'keychain:test-service:test-account',
      'stored:providerConfig:test:apiKey',
    ];

    for (const ref of resolvableRefs) {
      expect(CredentialRefSchema.safeParse(ref).success).toBe(true);
      expect(AuthCredentialRefSchema.safeParse(ref).success).toBe(true);
    }

    const legacyAccountRef = 'account-manager:["test-client","work"]';
    expect(CredentialRefSchema.safeParse(legacyAccountRef).success).toBe(false);
    expect(AuthCredentialRefSchema.safeParse(legacyAccountRef).success).toBe(false);
  });

  it('requires provider refs to carry their provider definition identity', () => {
    expect(ProviderAuthMethodRefSchema.safeParse({ owner: 'provider', methodId: apiKeyMethod.id }).success).toBe(false);
    expect(
      ProviderAuthMethodRefSchema.safeParse({
        owner: 'provider',
        providerDefinitionId: 'test-provider',
        methodId: apiKeyMethod.id,
      }).success,
    ).toBe(true);
  });

  it('accepts explicit, inferred-account, and no-auth persisted selections', () => {
    expect(
      ProviderConfigAuthSchema.safeParse({
        mode: 'explicit',
        method: {
          owner: 'provider',
          providerDefinitionId: 'test-provider',
          methodId: apiKeyMethod.id,
        },
        credentialRefs: { apiKey: 'env:TEST_API_KEY' },
      }).success,
    ).toBe(true);
    expect(
      ProviderConfigAuthSchema.safeParse({
        mode: 'inferred',
        method: { owner: 'client', clientId: 'test-client', methodId: nativeMethod.id },
        account: { managerId: 'test-accounts', accountId: 'work' },
      }).success,
    ).toBe(true);
    expect(
      ProviderConfigAuthSchema.safeParse({
        mode: 'none',
        method: {
          owner: 'provider',
          providerDefinitionId: 'test-provider',
          methodId: noAuthMethod.id,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects provider-owned inferred selections and undeclared selection fields', () => {
    expect(
      ProviderConfigAuthSchema.safeParse({
        mode: 'explicit',
        method: {
          owner: 'provider',
          providerDefinitionId: 'test-provider',
          methodId: apiKeyMethod.id,
        },
        credentialRefs: {},
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigAuthSchema.safeParse({
        mode: 'inferred',
        method: {
          owner: 'provider',
          providerDefinitionId: 'test-provider',
          methodId: nativeMethod.id,
        },
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigAuthSchema.safeParse({
        mode: 'none',
        method: {
          owner: 'provider',
          providerDefinitionId: 'test-provider',
          methodId: noAuthMethod.id,
        },
        credentialRefs: {},
      }).success,
    ).toBe(false);
  });
});

describe('resolved auth', () => {
  it('keeps credentials ref-only and requires method and field coherence', () => {
    const resolved = {
      mode: 'explicit',
      method: {
        owner: 'provider',
        providerDefinitionId: 'test-provider',
        methodId: apiKeyMethod.id,
      },
      definition: multiFieldApiKeyMethod,
      credentialRefs: { apiKey: 'stored:providerConfig:test:apiKey' },
    } as const;

    expect(ResolvedProviderAuthSchema.safeParse(resolved).success).toBe(true);
    expect(
      ResolvedProviderAuthSchema.safeParse({
        ...resolved,
        definition: { ...apiKeyMethod, id: 'different-method' },
      }).success,
    ).toBe(false);
    expect(
      ResolvedProviderAuthSchema.safeParse({
        ...resolved,
        credentialRefs: {},
      }).success,
    ).toBe(false);
    expect(
      ResolvedProviderAuthSchema.safeParse({
        ...resolved,
        credentialRefs: {
          apiKey: 'stored:providerConfig:test:apiKey',
          unknownField: 'env:TEST_API_KEY',
        },
      }).success,
    ).toBe(false);
    expect(
      ResolvedProviderAuthSchema.safeParse({
        ...resolved,
        credentialRefs: {
          apiKey: 'stored:providerConfig:test:apiKey',
          organizationId: 'env:TEST_ORGANIZATION_ID',
        },
      }).success,
    ).toBe(true);
    expect(
      ResolvedProviderAuthSchema.safeParse({
        ...resolved,
        credentialRefs: { apiKey: 'account-manager:["test-client","work"]' },
      }).success,
    ).toBe(false);
    expect(ResolvedProviderAuthSchema.safeParse({ ...resolved, sourceEnvVars: ['TEST_API_KEY'] }).success).toBe(false);
  });
});

describe('ProviderConfigFileSchema normalized auth', () => {
  it('accepts required auth plus optional lifecycle management metadata', () => {
    expect(
      ProviderConfigFileSchema.parse({
        $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
        definitionId: 'test-provider',
        auth: {
          mode: 'inferred',
          method: { owner: 'client', clientId: 'test-client', methodId: nativeMethod.id },
        },
        managedBy: { kind: 'client', clientId: 'test-client' },
      }),
    ).toMatchObject({
      definitionId: 'test-provider',
      managedBy: { kind: 'client', clientId: 'test-client' },
    });
  });

  it('requires auth and validates provider-owned refs against the containing definition', () => {
    expect(
      ProviderConfigFileSchema.safeParse({
        $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
        definitionId: 'test-provider',
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigFileSchema.safeParse({
        $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
        definitionId: 'test-provider',
        auth: {
          mode: 'none',
          method: { owner: 'provider', providerDefinitionId: 'other-provider', methodId: noAuthMethod.id },
        },
      }).success,
    ).toBe(false);
  });

  it('keeps lifecycle ownership independent from the selected auth method', () => {
    const explicitManagedConfig = {
      $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
      definitionId: 'test-provider',
      managedBy: { kind: 'client', clientId: 'test-client' },
      auth: {
        mode: 'explicit',
        method: {
          owner: 'provider',
          providerDefinitionId: 'test-provider',
          methodId: apiKeyMethod.id,
        },
        credentialRefs: { apiKey: 'env:TEST_API_KEY' },
      },
    } as const;

    expect(ProviderConfigFileSchema.safeParse(explicitManagedConfig).success).toBe(true);
  });

  it('rejects the retired v1 shape instead of reinterpreting it', () => {
    const v1 = {
      $schema: 'makaio/provider-config/v1',
      definitionId: 'test-provider',
      credentials: { apiKey: 'env:TEST_API_KEY' },
      isSentinel: false,
    };
    const v2 = {
      $schema: PROVIDER_CONFIG_SCHEMA_VERSION,
      definitionId: 'test-provider',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: noAuthMethod.id },
      },
    } as const;

    expect(ProviderConfigFileSchema.safeParse(v1).success).toBe(false);
    expect(ProviderConfigFileSchema.safeParse(v2).success).toBe(true);
  });
});

describe('adapter auth binding schemas', () => {
  const providerMethodRef = {
    owner: 'provider',
    providerDefinitionId: 'test-provider',
    methodId: apiKeyMethod.id,
  } as const;

  const processDelivery = { kind: 'process-env', fields: { apiKey: 'TEST_API_KEY' } } as const;

  it('parses all delivery variants and JSON connector constants', () => {
    const auth = AdapterProviderAuthSchema.parse({
      bindings: [
        {
          method: providerMethodRef,
          deliveries: [
            processDelivery,
            {
              kind: 'connector',
              target: 'test.constructor',
              fields: { apiKey: 'apiKey' },
              constants: { authToken: null, enabled: true, retries: 0, audience: 'test' },
            },
          ],
        },
        {
          method: { owner: 'client', clientId: 'test-client', methodId: nativeMethod.id },
          deliveries: [{ kind: 'native-client', clientId: 'test-client' }],
        },
        {
          method: {
            owner: 'provider',
            providerDefinitionId: 'test-provider',
            methodId: noAuthMethod.id,
          },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: ['TEST_API_KEY'],
    });

    expect(auth.bindings[0]?.deliveries[1]).toMatchObject({
      kind: 'connector',
      target: 'test.constructor',
      constants: { authToken: null },
    });
    expect(auth.bindings.map(({ deliveries }) => deliveries[0].kind)).toEqual(['process-env', 'native-client', 'none']);
  });

  it('requires strict, non-empty process, connector, and native-client fields', () => {
    expect(ProcessEnvAdapterAuthDeliverySchema.safeParse({ kind: 'process-env', fields: {} }).success).toBe(false);
    expect(
      ProcessEnvAdapterAuthDeliverySchema.safeParse({
        kind: 'process-env',
        fields: { apiKey: 'INVALID-NAME' },
      }).success,
    ).toBe(false);
    expect(
      ProcessEnvAdapterAuthDeliverySchema.safeParse({
        kind: 'process-env',
        fields: { apiKey: 'TEST_API_KEY' },
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      ConnectorAdapterAuthDeliverySchema.safeParse({ kind: 'connector', target: ' ', fields: { apiKey: 'apiKey' } })
        .success,
    ).toBe(false);
    expect(
      ConnectorAdapterAuthDeliverySchema.safeParse({ kind: 'connector', target: 'test.constructor', fields: {} })
        .success,
    ).toBe(false);
    expect(NativeClientAdapterAuthDeliverySchema.safeParse({ kind: 'native-client', clientId: ' ' }).success).toBe(
      false,
    );
  });

  it('rejects non-JSON connector constants', () => {
    expect(
      ConnectorAdapterAuthDeliverySchema.safeParse({
        kind: 'connector',
        target: 'test.constructor',
        fields: { apiKey: 'apiKey' },
        constants: { invalid: Number.NaN },
      }).success,
    ).toBe(false);
    expect(
      ConnectorAdapterAuthDeliverySchema.safeParse({
        kind: 'connector',
        target: 'test.constructor',
        fields: { apiKey: 'apiKey' },
        constants: { invalid: BigInt(1) },
      }).success,
    ).toBe(false);
  });

  it('requires non-empty deliveries and keeps none exclusive', () => {
    expect(AdapterAuthBindingSchema.safeParse({ method: providerMethodRef, deliveries: [] }).success).toBe(false);
    expect(
      AdapterAuthBindingSchema.safeParse({
        method: providerMethodRef,
        deliveries: [{ kind: 'none' }, processDelivery],
      }).success,
    ).toBe(false);
  });

  it('requires native delivery to target the client that owns the method', () => {
    expect(
      AdapterAuthBindingSchema.safeParse({
        method: { owner: 'client', clientId: 'test-client', methodId: nativeMethod.id },
        deliveries: [{ kind: 'native-client', clientId: 'other-client' }],
      }).success,
    ).toBe(false);
    expect(
      AdapterAuthBindingSchema.safeParse({
        method: providerMethodRef,
        deliveries: [{ kind: 'native-client', clientId: 'test-client' }],
      }).success,
    ).toBe(false);
  });

  it('requires unique method bindings and valid unique scrub variables', () => {
    const binding = { method: providerMethodRef, deliveries: [processDelivery] } as const;

    expect(
      AdapterProviderAuthSchema.safeParse({
        bindings: [binding, binding],
        scrubEnvVars: ['TEST_API_KEY'],
      }).success,
    ).toBe(false);
    expect(AdapterProviderAuthSchema.safeParse({ bindings: [binding], scrubEnvVars: ['INVALID-NAME'] }).success).toBe(
      false,
    );
    expect(
      AdapterProviderAuthSchema.safeParse({
        bindings: [binding],
        scrubEnvVars: ['TEST_API_KEY', 'TEST_API_KEY'],
      }).success,
    ).toBe(false);
    expect(AdapterProviderAuthSchema.safeParse({ bindings: [], scrubEnvVars: [] }).success).toBe(false);
  });

  it('shares one semantic binding validator across discovery and runtime consumers', () => {
    expect(() =>
      assertAdapterAuthBindingMatchesMethod(
        AdapterAuthBindingSchema.parse({ method: providerMethodRef, deliveries: [processDelivery] }),
        apiKeyMethod,
      ),
    ).not.toThrow();

    expect(() =>
      assertAdapterAuthBindingMatchesMethod(
        AdapterAuthBindingSchema.parse({
          method: providerMethodRef,
          deliveries: [{ kind: 'none' }],
        }),
        apiKeyMethod,
      ),
    ).toThrow(/Explicit authentication requires/);

    expect(() =>
      assertAdapterAuthBindingMatchesMethod(
        AdapterAuthBindingSchema.parse({
          method: providerMethodRef,
          deliveries: [
            { kind: 'process-env', fields: { apiKey: 'SHARED_TARGET' } },
            { kind: 'process-env', fields: { apiKey: 'SHARED_TARGET' } },
          ],
        }),
        apiKeyMethod,
      ),
    ).toThrow(/duplicate process environment target/);
  });
});
