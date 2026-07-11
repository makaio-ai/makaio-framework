import { describe, expect, it, vi } from 'vitest';
import {
  AuthCredentialRefSchema,
  ResolvedProviderAuthSchema,
  defineAdapterProviderAuth,
  type AdapterAuthDelivery,
  type AdapterProviderAuth,
  type ResolvedProviderAuth,
} from '@makaio/contracts';
import { bindProviderAuth, resolveBoundProviderAuth } from '../resolve-adapter-auth.js';

type ResolvedExplicitAuth = Extract<ResolvedProviderAuth, { mode: 'explicit' }>;

/**
 * Build a two-field explicit auth selection for resolver tests.
 * @param options - Optional fixture controls.
 * @returns Parsed explicit provider authentication.
 */
function createExplicitAuth(
  options: { includeOptionalRef?: boolean; requiredRef?: string } = {},
): ResolvedExplicitAuth {
  const credentialRefs: Record<string, string> = {
    apiKey: options.requiredRef ?? 'env:SELECTED_API_KEY',
  };
  if (options.includeOptionalRef ?? true) {
    credentialRefs['tenantId'] = 'file:/run/secrets/tenant-id';
  }

  const auth = ResolvedProviderAuthSchema.parse({
    mode: 'explicit',
    method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'multi-field' },
    definition: {
      id: 'multi-field',
      mode: 'explicit',
      label: 'Multi-field auth',
      fields: [
        {
          id: 'apiKey',
          label: 'API key',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'DECLARED_SOURCE' }],
        },
        {
          id: 'tenantId',
          label: 'Tenant ID',
          required: false,
          secret: false,
          sourceHints: [{ kind: 'environment', variable: 'TENANT_SOURCE' }],
        },
      ],
    },
    credentialRefs,
  });
  if (auth.mode !== 'explicit') {
    throw new Error('Expected explicit auth fixture.');
  }
  return auth;
}

/**
 * Build selected adapter auth around the supplied deliveries.
 * @param deliveries - Deliveries bound to the fixture's explicit method.
 * @returns Validated adapter/provider authentication declaration.
 */
function createSelectedDeclaration(
  deliveries: readonly [AdapterAuthDelivery, ...AdapterAuthDelivery[]],
): AdapterProviderAuth {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'multi-field' },
        deliveries,
      },
    ],
    scrubEnvVars: ['MANUAL_AUTH_MODE', 'DECLARED_SOURCE', 'CLIENT_SOURCE'],
  });
}

/** Build an unrelated compatible declaration that contributes scrub inputs. */
function createCompatibleDeclaration(): AdapterProviderAuth {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'client', clientId: 'test-client', methodId: 'access-token' },
        deliveries: [{ kind: 'process-env', fields: { accessToken: 'COMPETING_ACCESS_TOKEN' } }],
      },
    ],
    scrubEnvVars: ['COMPETING_CONTROL'],
  });
}

describe('normalized adapter auth resolver', () => {
  it('compiles adapter-wide scrub inputs and resolves remapped multi-field deliveries once', async () => {
    const auth = createExplicitAuth();
    const selectedDeclaration = createSelectedDeclaration([
      {
        kind: 'process-env',
        fields: { apiKey: 'RUNTIME_API_KEY', tenantId: 'RUNTIME_TENANT' },
      },
      {
        kind: 'connector',
        target: 'test-sdk.constructor',
        fields: { apiKey: 'token', tenantId: 'organization' },
        constants: { authToken: null, retries: 2, enabled: true },
      },
    ]);

    const bound = bindProviderAuth({
      auth,
      adapterProviderAuth: selectedDeclaration,
      compatibleProviderAuths: [createCompatibleDeclaration()],
    });

    expect(bound.scrubEnvVars).toEqual([
      'MANUAL_AUTH_MODE',
      'DECLARED_SOURCE',
      'CLIENT_SOURCE',
      'RUNTIME_API_KEY',
      'RUNTIME_TENANT',
      'COMPETING_CONTROL',
      'COMPETING_ACCESS_TOKEN',
      'SELECTED_API_KEY',
    ]);

    const resolveRefs = vi.fn().mockResolvedValue({ apiKey: 'secret-key', tenantId: 'tenant-42' });
    const resolved = await resolveBoundProviderAuth(bound, resolveRefs);

    expect(resolveRefs).toHaveBeenCalledOnce();
    expect(resolveRefs).toHaveBeenCalledWith(auth.credentialRefs);
    expect(resolved).toEqual({
      processEnv: { RUNTIME_API_KEY: 'secret-key', RUNTIME_TENANT: 'tenant-42' },
      connectorDeliveries: [
        {
          target: 'test-sdk.constructor',
          values: {
            authToken: null,
            retries: 2,
            enabled: true,
            token: 'secret-key',
            organization: 'tenant-42',
          },
        },
      ],
      configInheritance: 'empty',
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.auth)).toBe(true);
    if (bound.auth.mode !== 'explicit') {
      throw new Error('Expected the bound auth fixture to remain explicit.');
    }
    expect(Object.isFrozen(bound.auth.credentialRefs)).toBe(true);
    expect(Object.isFrozen(bound.binding)).toBe(true);
    expect(Object.isFrozen(bound.scrubEnvVars)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.processEnv)).toBe(true);
    expect(Object.isFrozen(resolved.connectorDeliveries)).toBe(true);
    expect(Object.isFrozen(resolved.connectorDeliveries[0])).toBe(true);
    expect(Object.isFrozen(resolved.connectorDeliveries[0].values)).toBe(true);
  });

  it('creates own connector data properties without prototype mutation', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth(),
      adapterProviderAuth: createSelectedDeclaration([
        {
          kind: 'connector',
          target: 'test-sdk.constructor',
          fields: { apiKey: '__proto__' },
        },
      ]),
    });

    const resolved = await resolveBoundProviderAuth(bound, async () => ({ apiKey: 'secret-key' }));
    const values = resolved.connectorDeliveries[0].values;

    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.hasOwn(values, '__proto__')).toBe(true);
    expect(values['__proto__']).toBe('secret-key');
  });

  it('clones refs-only inputs before freezing the bound snapshot', () => {
    const auth = createExplicitAuth();
    const declaration = createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]);
    const bound = bindProviderAuth({ auth, adapterProviderAuth: declaration });

    auth.credentialRefs['apiKey'] = AuthCredentialRefSchema.parse('env:MUTATED_SOURCE');
    declaration.scrubEnvVars.push('MUTATED_CONTROL');

    expect(bound.auth.mode).toBe('explicit');
    if (bound.auth.mode === 'explicit') {
      expect(bound.auth.credentialRefs['apiKey']).toBe('env:SELECTED_API_KEY');
    }
    expect(bound.scrubEnvVars).not.toContain('MUTATED_CONTROL');
  });

  it('omits an absent optional field from every selected delivery', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth({ includeOptionalRef: false }),
      adapterProviderAuth: createSelectedDeclaration([
        {
          kind: 'process-env',
          fields: { apiKey: 'RUNTIME_API_KEY', tenantId: 'RUNTIME_TENANT' },
        },
      ]),
    });

    const resolved = await resolveBoundProviderAuth(bound, async () => ({ apiKey: 'secret-key' }));

    expect(resolved.processEnv).toEqual({ RUNTIME_API_KEY: 'secret-key' });
  });

  it('rejects a missing required ref before connector-local resolution', () => {
    const auth = createExplicitAuth();
    delete auth.credentialRefs['apiKey'];

    expect(() =>
      bindProviderAuth({
        auth,
        adapterProviderAuth: createSelectedDeclaration([
          { kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } },
        ]),
      }),
    ).toThrow('Resolved provider authentication is invalid.');
  });

  it('rejects required fields that the trusted resolver cannot materialize', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth(),
      adapterProviderAuth: createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]),
    });

    await expect(resolveBoundProviderAuth(bound, async () => ({ tenantId: 'tenant-42' }))).rejects.toThrow(
      'Required authentication field "apiKey" could not be resolved.',
    );
  });

  it('rejects an explicit binding that does not deliver every required field', () => {
    const declaration = createSelectedDeclaration([{ kind: 'process-env', fields: { tenantId: 'RUNTIME_TENANT' } }]);

    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: declaration })).toThrow(
      'Required authentication field "apiKey" has no adapter delivery.',
    );
  });

  it('rejects duplicate exact bindings before generic declaration validation', () => {
    const declaration = createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]);
    declaration.bindings.push(declaration.bindings[0]);

    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: declaration })).toThrow(
      'Multiple adapter authentication bindings match the selected method.',
    );
  });

  it('validates a malformed declaration before reporting an exact-binding miss', () => {
    const declaration = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'other-provider', methodId: 'multi-field' },
          deliveries: [{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }],
        },
      ],
      scrubEnvVars: [],
    });
    declaration.scrubEnvVars.push('DUPLICATE_AUTH', 'DUPLICATE_AUTH');

    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: declaration })).toThrow(
      'Selected adapter authentication declaration is invalid.',
    );
  });

  it('rejects duplicate resolved auth field IDs deterministically', () => {
    const auth = createExplicitAuth();
    auth.definition.fields.push({ ...auth.definition.fields[0] });

    expect(() =>
      bindProviderAuth({
        auth,
        adapterProviderAuth: createSelectedDeclaration([
          { kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } },
        ]),
      }),
    ).toThrow('Resolved provider authentication is invalid.');
  });

  it('rejects method mismatches and unknown delivery field IDs', () => {
    const mismatch = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'other-provider', methodId: 'multi-field' },
          deliveries: [{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }],
        },
      ],
      scrubEnvVars: [],
    });
    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: mismatch })).toThrow(
      'No adapter authentication binding matches the selected method.',
    );

    const ownerMismatch = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'client', clientId: 'test-provider', methodId: 'multi-field' },
          deliveries: [{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }],
        },
      ],
      scrubEnvVars: [],
    });
    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: ownerMismatch })).toThrow(
      'No adapter authentication binding matches the selected method.',
    );

    const unknownField = createSelectedDeclaration([{ kind: 'process-env', fields: { missing: 'RUNTIME_API_KEY' } }]);
    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: unknownField })).toThrow(
      'Adapter authentication delivery references unknown field "missing".',
    );
  });

  it('rejects duplicate process and connector delivery targets', () => {
    const duplicateProcessTarget = createSelectedDeclaration([
      {
        kind: 'process-env',
        fields: { apiKey: 'SHARED_TARGET', tenantId: 'SHARED_TARGET' },
      },
    ]);
    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: duplicateProcessTarget })).toThrow(
      'Adapter authentication has duplicate process environment target "SHARED_TARGET".',
    );

    const duplicateConnectorTarget = createSelectedDeclaration([
      { kind: 'connector', target: 'shared.operation', fields: { apiKey: 'token' } },
      { kind: 'connector', target: 'shared.operation', fields: { tenantId: 'tenant' } },
    ]);
    expect(() =>
      bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: duplicateConnectorTarget }),
    ).toThrow('Adapter authentication has duplicate connector operation target "shared.operation".');
  });

  it('rejects connector field/constant collisions instead of silently overwriting null suppression', () => {
    const declaration = createSelectedDeclaration([
      {
        kind: 'connector',
        target: 'test-sdk.constructor',
        fields: { apiKey: 'authToken' },
        constants: { authToken: null },
      },
    ]);

    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: declaration })).toThrow(
      'Adapter authentication has duplicate connector operation "test-sdk.constructor" value target "authToken".',
    );
  });

  it('requires each auth mode to use its matching delivery family', () => {
    const explicitWithNone = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'test-provider', methodId: 'multi-field' },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: [],
    });
    expect(() => bindProviderAuth({ auth: createExplicitAuth(), adapterProviderAuth: explicitWithNone })).toThrow(
      'Explicit authentication requires process-environment or connector deliveries.',
    );

    const inferredAuth = ResolvedProviderAuthSchema.parse({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native' },
    });
    const inferredWithNone = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: [],
    });
    expect(() => bindProviderAuth({ auth: inferredAuth, adapterProviderAuth: inferredWithNone })).toThrow(
      'Inferred authentication requires exactly one native-client delivery.',
    );

    const noAuth = ResolvedProviderAuthSchema.parse({
      mode: 'none',
      method: { owner: 'client', clientId: 'test-client', methodId: 'none' },
      definition: { id: 'none', mode: 'none', label: 'No authentication' },
    });
    const noAuthWithNative = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'client', clientId: 'test-client', methodId: 'none' },
          deliveries: [{ kind: 'native-client', clientId: 'test-client' }],
        },
      ],
      scrubEnvVars: [],
    });
    expect(() => bindProviderAuth({ auth: noAuth, adapterProviderAuth: noAuthWithNative })).toThrow(
      'No-authentication methods require exactly one none delivery.',
    );
  });

  it('uses auth-only inheritance for inferred auth without resolving credentials', async () => {
    const auth = ResolvedProviderAuthSchema.parse({
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native' },
    });
    const declaration = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
          deliveries: [{ kind: 'native-client', clientId: 'test-client' }],
        },
      ],
      scrubEnvVars: ['AMBIENT_TOKEN', 'AUTH_CONTROL'],
    });
    const resolveRefs = vi.fn();

    const bound = bindProviderAuth({ auth, adapterProviderAuth: declaration });
    const resolved = await resolveBoundProviderAuth(bound, resolveRefs);

    expect(bound.scrubEnvVars).toEqual(['AMBIENT_TOKEN', 'AUTH_CONTROL']);
    expect(resolveRefs).not.toHaveBeenCalled();
    expect(resolved).toEqual({ processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' });
  });

  it('uses empty inheritance for explicit no-auth without resolving credentials', async () => {
    const auth = ResolvedProviderAuthSchema.parse({
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: 'local', methodId: 'none' },
      definition: { id: 'none', mode: 'none', label: 'No authentication' },
    });
    const declaration = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'local', methodId: 'none' },
          deliveries: [{ kind: 'none' }],
        },
      ],
      scrubEnvVars: [],
    });
    const resolveRefs = vi.fn();

    const resolved = await resolveBoundProviderAuth(
      bindProviderAuth({ auth, adapterProviderAuth: declaration }),
      resolveRefs,
    );

    expect(resolveRefs).not.toHaveBeenCalled();
    expect(resolved).toEqual({ processEnv: {}, connectorDeliveries: [], configInheritance: 'empty' });
  });

  it('does not retain resolver failures that may contain credential refs', async () => {
    const credentialRef = 'stored:providerConfig:config-secret:apiKey';
    const bound = bindProviderAuth({
      auth: createExplicitAuth({ requiredRef: credentialRef }),
      adapterProviderAuth: createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]),
    });

    let captured: Error | undefined;
    try {
      await resolveBoundProviderAuth(bound, async () => {
        throw new Error(`Could not resolve ${credentialRef}`);
      });
    } catch (error) {
      if (error instanceof Error) {
        captured = error;
      }
    }

    expect(captured?.message).toBe('Failed to resolve adapter authentication credentials.');
    expect(captured?.message).not.toContain(credentialRef);
    expect(captured?.cause).toBeUndefined();
  });

  it('rejects resolver fields without selected refs without leaking their keys', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth({ includeOptionalRef: false }),
      adapterProviderAuth: createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]),
    });
    const leakedRef = 'stored:providerConfig:config-secret:tenantId';

    let captured: Error | undefined;
    try {
      await resolveBoundProviderAuth(bound, async () => ({ apiKey: 'secret-key', [leakedRef]: 'secret-value' }));
    } catch (error) {
      if (error instanceof Error) {
        captured = error;
      }
    }

    expect(captured?.message).toBe('Credential resolver returned values outside the selected authentication fields.');
    expect(captured?.message).not.toContain(leakedRef);
  });

  it('rejects a value for a declared optional field when no ref selected it', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth({ includeOptionalRef: false }),
      adapterProviderAuth: createSelectedDeclaration([
        { kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY', tenantId: 'RUNTIME_TENANT' } },
      ]),
    });

    await expect(
      resolveBoundProviderAuth(bound, async () => ({ apiKey: 'secret-key', tenantId: 'unselected-value' })),
    ).rejects.toThrow('Credential resolver returned values outside the selected authentication fields.');
  });

  it('normalizes getter failures from resolver output without retaining their message', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth(),
      adapterProviderAuth: createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]),
    });
    const leakedRef = 'stored:providerConfig:config-secret:apiKey';
    const returnedValues: Record<string, string> = {};
    Object.defineProperty(returnedValues, 'apiKey', {
      enumerable: true,
      get: () => {
        throw new Error(`Getter failed for ${leakedRef}`);
      },
    });

    let captured: Error | undefined;
    try {
      await resolveBoundProviderAuth(bound, async () => returnedValues);
    } catch (error) {
      if (error instanceof Error) {
        captured = error;
      }
    }

    expect(captured?.message).toBe('Credential resolver returned invalid authentication values.');
    expect(captured?.message).not.toContain(leakedRef);
  });

  it('does not accept inherited object properties as resolved credential values', async () => {
    const bound = bindProviderAuth({
      auth: createExplicitAuth(),
      adapterProviderAuth: createSelectedDeclaration([{ kind: 'process-env', fields: { apiKey: 'RUNTIME_API_KEY' } }]),
    });
    const inheritedValues: Record<string, string> = Object.create({ apiKey: 'prototype-secret' });

    await expect(resolveBoundProviderAuth(bound, async () => inheritedValues)).rejects.toThrow(
      'Required authentication field "apiKey" could not be resolved.',
    );
  });
});
