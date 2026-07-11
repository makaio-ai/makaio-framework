import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannelEndpoint, MakaioBus, type ChannelEndpoint } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import {
  AuthCredentialRefSchema,
  ClientSubjects,
  CredentialSubjects,
  defineAdapterProviderAuth,
} from '@makaio/contracts';
import { resolveClientBinary } from '@makaio/subsystem-client';
import {
  applySuppliedAdapterAuthRuntime,
  prepareAdapterAuthRuntime,
  type BoundAdapterRuntimeConfig,
} from '../adapter-auth-runtime.js';
import {
  AdapterAuthError,
  bindProviderAuth,
  type BoundProviderAuthContext,
  type ResolvedAdapterAuth,
} from '../resolve-adapter-auth.js';

vi.mock('@makaio/subsystem-client', () => ({
  resolveClientBinary: vi.fn(),
}));

const resolveClientBinaryMock = vi.mocked(resolveClientBinary);
const cleanups: Array<() => void> = [];
type SessionConfigCreateRequest = (typeof ClientSubjects.sessionConfig.create)['$meta']['payload']['request'];
type SessionConfigDestroyRequest = (typeof ClientSubjects.sessionConfig.destroy)['$meta']['payload']['request'];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
  vi.resetAllMocks();
});

/**
 * Register the encrypted credential channel used by the real resolver.
 * @param values - Plaintext values keyed by credential ref
 */
function setupCredentialChannel(values: Readonly<Record<string, string | null>>): void {
  const token = 'adapter-auth-runtime-token';
  cleanups.push(
    MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
      ctx.setResult({ token });
    }),
  );
  const endpoint: ChannelEndpoint = createChannelEndpoint(
    MakaioBus.getContext(),
    'credentials',
    (channel) => {
      channel.on(CredentialSubjects.resolve, (ctx) => {
        ctx.setResult({ value: values[ctx.payload.ref] ?? null });
      });
    },
    { token },
  );
  cleanups.push(() => endpoint.close());
}

/**
 * Create a fully explicit multi-field binding for runtime tests.
 * @param options - Optional field-requiredness overrides for the fixture.
 * @returns Bound explicit auth fixture.
 */
function explicitBinding(options: { tenantRequired?: boolean } = {}): BoundProviderAuthContext {
  const method = { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'oauth' } as const;
  return bindProviderAuth({
    auth: {
      mode: 'explicit',
      method,
      definition: {
        id: 'oauth',
        mode: 'explicit',
        label: 'OAuth',
        fields: [
          { id: 'token', label: 'Token', required: true, secret: true, sourceHints: [] },
          { id: 'tenant', label: 'Tenant', required: options.tenantRequired ?? true, secret: false, sourceHints: [] },
        ],
      },
      credentialRefs: {
        token: AuthCredentialRefSchema.parse('env:SELECTED_TOKEN_SOURCE'),
        tenant: AuthCredentialRefSchema.parse('file:/tenant-id'),
      },
    },
    adapterProviderAuth: defineAdapterProviderAuth({
      bindings: [
        {
          method,
          deliveries: [
            {
              kind: 'process-env',
              fields: { token: 'CLAUDE_CODE_OAUTH_TOKEN', tenant: 'CLAUDE_TENANT' },
            },
          ],
        },
      ],
      scrubEnvVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_TENANT'],
    }),
    compatibleProviderAuths: [
      defineAdapterProviderAuth({
        bindings: [
          {
            method: { owner: 'provider', providerDefinitionId: 'openai', methodId: 'api-key' },
            deliveries: [{ kind: 'process-env', fields: { apiKey: 'OPENAI_API_KEY' } }],
          },
        ],
        scrubEnvVars: ['CODEX_ACCESS_TOKEN'],
      }),
    ],
  });
}

/** Create a client-owned inferred binding. */
function inferredBinding(): BoundProviderAuthContext {
  const method = { owner: 'client', clientId: 'codex', methodId: 'native' } as const;
  return bindProviderAuth({
    auth: {
      mode: 'inferred',
      method,
      definition: { id: 'native', mode: 'inferred', label: 'Native Codex' },
    },
    adapterProviderAuth: defineAdapterProviderAuth({
      bindings: [{ method, deliveries: [{ kind: 'native-client', clientId: 'codex' }] }],
      scrubEnvVars: [
        'SELECTED_TOKEN_SOURCE',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_TENANT',
        'CODEX_ACCESS_TOKEN',
        'OPENAI_API_KEY',
      ],
    }),
  });
}

/** Create an explicit no-auth provider binding. */
function noAuthBinding(): BoundProviderAuthContext {
  const method = { owner: 'provider', providerDefinitionId: 'local', methodId: 'none' } as const;
  return bindProviderAuth({
    auth: {
      mode: 'none',
      method,
      definition: { id: 'none', mode: 'none', label: 'No authentication' },
    },
    adapterProviderAuth: defineAdapterProviderAuth({
      bindings: [{ method, deliveries: [{ kind: 'none' }] }],
      scrubEnvVars: [
        'SELECTED_TOKEN_SOURCE',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_TENANT',
        'OPENAI_API_KEY',
        'CODEX_ACCESS_TOKEN',
      ],
    }),
  });
}

/**
 * Build the minimal runtime config shared by auth modes.
 * @param boundProviderAuth - Bound normalized auth selection under test
 * @returns Minimal refs-only adapter runtime config
 */
function runtimeConfig(boundProviderAuth: BoundProviderAuthContext): BoundAdapterRuntimeConfig {
  const { bus } = createMockScopedBus();
  return {
    bus,
    globalBus: MakaioBus,
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    adapterSessionId: 'adapter-session-1',
    sessionId: 'session-1',
    clientId: 'codex',
    clientProfileName: 'work',
    model: 'test-model',
    cwd: '/work/project',
    env: {
      PATH: '/base/bin',
      SELECTED_TOKEN_SOURCE: 'ambient-source',
      ANTHROPIC_API_KEY: 'ambient-anthropic',
      OPENAI_API_KEY: 'ambient-openai',
      CODEX_ACCESS_TOKEN: 'ambient-codex',
    },
    boundProviderAuth,
  };
}

describe('prepareAdapterAuthRuntime', () => {
  it('creates independent immutable environment views when no auth binding exists', async () => {
    const config = runtimeConfig(noAuthBinding());
    delete config.boundProviderAuth;
    config.env = { PATH: '/base/bin', SESSION_SETTING: 'enabled' };

    const prepared = await prepareAdapterAuthRuntime(config);

    expect(prepared.config.env).toEqual({ PATH: '/base/bin', SESSION_SETTING: 'enabled' });
    expect(prepared.config.contextEnv).toEqual({ PATH: '/base/bin', SESSION_SETTING: 'enabled' });
    expect(prepared.config.env).not.toBe(prepared.config.contextEnv);
    expect(Object.isFrozen(prepared.config.env)).toBe(true);
    expect(Object.isFrozen(prepared.config.contextEnv)).toBe(true);
  });

  it('resolves refs once, scrubs every source after binary and lease merge, and owns an empty lease', async () => {
    setupCredentialChannel({
      'env:SELECTED_TOKEN_SOURCE': 'selected-token',
      'file:/tenant-id': 'tenant-42',
    });
    resolveClientBinaryMock.mockResolvedValue({
      binaryPath: '/managed/codex',
      env: { PATH: '/managed/bin', OPENAI_API_KEY: 'binary-openai' },
      configDir: null,
      source: 'managed',
      version: '1.0.0',
    });
    const createPayloads: SessionConfigCreateRequest[] = [];
    const destroyPayloads: SessionConfigDestroyRequest[] = [];
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        createPayloads.push(ctx.payload);
        ctx.setResult({
          sessionDir: '/tmp/session-config',
          env: { CODEX_HOME: '/tmp/session-config', ANTHROPIC_API_KEY: 'lease-anthropic' },
          authMaterialized: false,
        });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        destroyPayloads.push(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );

    const prepared = await prepareAdapterAuthRuntime(runtimeConfig(explicitBinding()));

    expect(prepared.config.env).toEqual({
      PATH: '/managed/bin',
      CODEX_HOME: '/tmp/session-config',
      CLAUDE_CODE_OAUTH_TOKEN: 'selected-token',
      CLAUDE_TENANT: 'tenant-42',
    });
    expect(prepared.config.contextEnv).toEqual({ PATH: '/managed/bin' });
    expect(Object.isFrozen(prepared.config.contextEnv)).toBe(true);
    expect(prepared.config.adapterAuth).toMatchObject({ configInheritance: 'empty' });
    expect(createPayloads).toHaveLength(1);
    expect(createPayloads[0]).toMatchObject({
      clientId: 'codex',
      ownerSessionId: 'session-1',
      profileName: 'work',
      projectDir: '/work/project',
      configInheritance: 'empty',
    });
    expect(createPayloads[0]).not.toMatchObject({ leaseId: 'session-1' });

    await prepared.lease?.release();
    await prepared.lease?.release();
    expect(destroyPayloads).toEqual([{ clientId: 'codex', leaseId: createPayloads[0]?.leaseId }]);
  });

  it('uses auth-only inheritance and rejects missing inferred materialization after releasing the lease', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const destroyPayloads: SessionConfigDestroyRequest[] = [];
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        expect(ctx.payload.configInheritance).toBe('auth-only');
        ctx.setResult({ sessionDir: '/tmp/native-config', env: {}, authMaterialized: false });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        destroyPayloads.push(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );

    await expect(prepareAdapterAuthRuntime(runtimeConfig(inferredBinding()))).rejects.toMatchObject({
      reason: 'native-auth-unavailable',
    } satisfies Partial<AdapterAuthError>);
    expect(destroyPayloads).toHaveLength(1);
  });

  it('materializes inferred auth without resolving any credential channel', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const tokenRequests = vi.fn();
    cleanups.push(
      MakaioBus.on(CredentialSubjects.getChannelToken, () => {
        tokenRequests();
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({
          sessionDir: '/tmp/native-config',
          env: { CODEX_HOME: '/tmp/native-config', OPENAI_API_KEY: 'must-be-scrubbed' },
          authMaterialized: true,
        });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const prepared = await prepareAdapterAuthRuntime(runtimeConfig(inferredBinding()));

    expect(tokenRequests).not.toHaveBeenCalled();
    expect(prepared.config.env).toEqual({ PATH: '/base/bin', CODEX_HOME: '/tmp/native-config' });
    expect(prepared.config.contextEnv).toEqual({ PATH: '/base/bin' });
    expect(prepared.config.adapterAuth).toMatchObject({
      processEnv: {},
      connectorDeliveries: [],
      configInheritance: 'auth-only',
    });
    await prepared.lease?.release();
  });

  it('creates an empty lease for explicit no-auth and forwards no ambient credential', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const tokenRequests = vi.fn();
    const inheritance: string[] = [];
    cleanups.push(
      MakaioBus.on(CredentialSubjects.getChannelToken, () => {
        tokenRequests();
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        inheritance.push(ctx.payload.configInheritance ?? 'full');
        ctx.setResult({
          sessionDir: '/tmp/no-auth-config',
          env: { CODEX_ACCESS_TOKEN: 'lease-token', CODEX_HOME: '/tmp/no-auth-config' },
          authMaterialized: false,
        });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const prepared = await prepareAdapterAuthRuntime(runtimeConfig(noAuthBinding()));

    expect(tokenRequests).not.toHaveBeenCalled();
    expect(inheritance).toEqual(['empty']);
    expect(prepared.config.env).toEqual({ PATH: '/base/bin', CODEX_HOME: '/tmp/no-auth-config' });
    expect(prepared.config.contextEnv).toEqual({ PATH: '/base/bin' });
    expect(prepared.config.adapterAuth).toEqual({
      processEnv: {},
      connectorDeliveries: [],
      configInheritance: 'empty',
    });
    await prepared.lease?.release();
  });

  it('reports unavailable explicit refs as a typed missing-credential failure before leasing', async () => {
    setupCredentialChannel({
      'env:SELECTED_TOKEN_SOURCE': null,
      'file:/tenant-id': 'tenant-42',
    });
    const createLease = vi.fn();
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, () => {
        createLease();
      }),
    );

    await expect(prepareAdapterAuthRuntime(runtimeConfig(explicitBinding()))).rejects.toMatchObject({
      reason: 'credential-missing',
    } satisfies Partial<AdapterAuthError>);
    expect(createLease).not.toHaveBeenCalled();
  });

  it('omits unavailable optional explicit refs while delivering every resolved required field', async () => {
    setupCredentialChannel({
      'env:SELECTED_TOKEN_SOURCE': 'selected-token',
      'file:/tenant-id': null,
    });
    resolveClientBinaryMock.mockResolvedValue(undefined);
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({ sessionDir: '/tmp/session-config', env: {}, authMaterialized: false });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const prepared = await prepareAdapterAuthRuntime(runtimeConfig(explicitBinding({ tenantRequired: false })));

    expect(prepared.config.adapterAuth?.processEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'selected-token' });
    expect(prepared.config.env).toEqual({ PATH: '/base/bin', CLAUDE_CODE_OAUTH_TOKEN: 'selected-token' });
    await prepared.lease?.release();
  });
});

describe('applySuppliedAdapterAuthRuntime', () => {
  it('uses no host-only service and scrubs every supplied non-auth source before selected injection', async () => {
    const tokenRequests = vi.fn();
    const leaseRequests = vi.fn();
    cleanups.push(
      MakaioBus.on(CredentialSubjects.getChannelToken, () => {
        tokenRequests();
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.create, () => {
        leaseRequests();
      }),
    );
    const selectorValidatedAuth: ResolvedAdapterAuth = {
      processEnv: { CODEX_ACCESS_TOKEN: 'selected-token' },
      connectorDeliveries: [
        {
          target: 'codex.account-login.api-key',
          values: { apiKey: 'selected-api-key', persist: false, opposingToken: null },
        },
      ],
      configInheritance: 'empty',
    };
    const config = runtimeConfig(noAuthBinding());
    config.env = {
      PATH: '/base/bin',
      CODEX_ACCESS_TOKEN: 'base-token',
      OPENAI_API_KEY: 'base-key',
    };

    const resolved = await applySuppliedAdapterAuthRuntime(config, {
      selectorValidatedAuth,
      scrubEnvVars: ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY'],
      sessionEnv: { CODEX_ACCESS_TOKEN: 'session-token', SESSION_ONLY: 'session' },
      binaryEnv: { OPENAI_API_KEY: 'binary-key', PATH: '/managed/bin' },
      leaseEnv: { CODEX_ACCESS_TOKEN: 'lease-token', CODEX_HOME: '/isolated/codex' },
    });

    expect(resolved.env).toEqual({
      PATH: '/managed/bin',
      SESSION_ONLY: 'session',
      CODEX_HOME: '/isolated/codex',
      CODEX_ACCESS_TOKEN: 'selected-token',
    });
    expect(resolved.contextEnv).toEqual({
      PATH: '/managed/bin',
      SESSION_ONLY: 'session',
    });
    expect(JSON.stringify(resolved.contextEnv)).not.toContain('selected-api-key');
    expect(Object.isFrozen(resolved.contextEnv)).toBe(true);
    expect(resolved.adapterAuth?.connectorDeliveries).toEqual(selectorValidatedAuth.connectorDeliveries);
    expect(Object.isFrozen(resolved.adapterAuth?.connectorDeliveries)).toBe(true);
    expect(Object.isFrozen(resolved.adapterAuth?.connectorDeliveries[0]?.values)).toBe(true);
    expect('boundProviderAuth' in resolved).toBe(false);
    expect(tokenRequests).not.toHaveBeenCalled();
    expect(leaseRequests).not.toHaveBeenCalled();
    expect(resolveClientBinaryMock).not.toHaveBeenCalled();
  });
});
