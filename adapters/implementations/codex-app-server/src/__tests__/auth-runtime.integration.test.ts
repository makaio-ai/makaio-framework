import { afterEach, describe, expect, it } from 'vitest';
import { createChannelEndpoint, MakaioBus, type ChannelEndpoint } from '@makaio/bus-core';
import { ConformanceConnectorRuntimeRegistry } from '@makaio/ai-adapters-core';
import { prepareAdapterAuthRuntime, type BoundAdapterRuntimeConfig } from '@makaio/ai-adapters-core/config';
import { AuthCredentialRefSchema, ClientSubjects, CredentialSubjects, type ProviderContext } from '@makaio/contracts';
import { CodexAppServerConfig } from '../config.js';
import { CodexAppServerConnector } from '../connector.js';
import type { CodexAppServerConfig as CodexConnectorConfig } from '../connector/types.js';
import { CodexAppServerNamespace, type CodexAppServerBus } from '../namespaces/index.js';
import { providerAuthById } from '../provider.js';
import { MockJsonRpcClient } from './shared.js';

const cleanups: Array<() => void> = [];
type CodexBoundRuntimeConfig = BoundAdapterRuntimeConfig<CodexAppServerBus, CodexConnectorConfig>;

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
});

/**
 * Register the real encrypted credential channel around selected test refs.
 * @param values - Plaintext fixture values keyed by credential ref
 */
function setupCredentialChannel(values: Readonly<Record<string, string | null>>): void {
  const token = 'codex-auth-runtime-test-token';
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

interface LeaseHarness {
  readonly createPayloads: Array<{ leaseId: string; configInheritance?: string }>;
  readonly destroyPayloads: Array<{ leaseId: string }>;
}

/**
 * Register temp-backed lease responses containing deliberately opposing auth variables.
 * @param authMaterialized - Whether the lease reports native auth materialization
 * @returns Captured create and destroy payload collections
 */
function setupLease(authMaterialized: boolean): LeaseHarness {
  const createPayloads: LeaseHarness['createPayloads'] = [];
  const destroyPayloads: LeaseHarness['destroyPayloads'] = [];
  cleanups.push(
    MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
      createPayloads.push(ctx.payload);
      ctx.setResult({
        sessionDir: '/tmp/codex-auth-runtime',
        env: {
          CODEX_HOME: '/tmp/codex-auth-runtime',
          OPENAI_API_KEY: 'lease-openai-key',
          CODEX_API_KEY: 'lease-codex-key',
          CODEX_ACCESS_TOKEN: 'lease-access-token',
        },
        authMaterialized,
      });
    }),
    MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
      destroyPayloads.push(ctx.payload);
      ctx.setResult({ success: true });
    }),
  );
  return { createPayloads, destroyPayloads };
}

/**
 * Build the refs-only provider context for one legal Codex auth mode.
 * @param mode - Codex auth mode represented by the context
 * @returns Resolved refs-only provider context
 */
function providerContext(mode: 'native' | 'access-token' | 'api-key'): ProviderContext {
  const base = {
    state: 'resolved' as const,
    providerConfigId: `codex-${mode}`,
    definitionId: 'openai-codex',
  };
  if (mode === 'native') {
    return {
      ...base,
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: 'codex', methodId: 'native' },
        definition: { id: 'native', mode: 'inferred', label: 'Native account' },
      },
    };
  }

  const fieldId = mode === 'access-token' ? 'accessToken' : 'apiKey';
  const sourceVariable = mode === 'access-token' ? 'CODEX_ACCESS_TOKEN' : 'OPENAI_API_KEY';
  return {
    ...base,
    auth: {
      mode: 'explicit',
      method:
        mode === 'access-token'
          ? { owner: 'client', clientId: 'codex', methodId: 'access-token' }
          : { owner: 'provider', providerDefinitionId: 'openai-codex', methodId: 'api-key' },
      definition: {
        id: mode,
        mode: 'explicit',
        label: mode,
        fields: [
          {
            id: fieldId,
            label: fieldId,
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: sourceVariable }],
          },
        ],
      },
      credentialRefs: { [fieldId]: AuthCredentialRefSchema.parse(`env:${sourceVariable}`) },
    },
  };
}

/**
 * Build the exact bound config emitted by the production Codex config factory.
 * @param mode - Codex auth mode represented by the runtime config
 * @returns Bound Codex runtime config
 */
async function runtimeConfig(mode: 'native' | 'access-token' | 'api-key'): Promise<CodexBoundRuntimeConfig> {
  const bus = await CodexAppServerNamespace.scopedBus();
  return CodexAppServerConfig.getConfig({
    bus,
    globalBus: MakaioBus,
    adapterId: 'adapter-test',
    adapterName: 'codex-app-server',
    agentId: 'agent-test',
    sessionId: 'session-test',
    model: 'test-model',
    cwd: '/tmp',
    env: {
      PATH: '/base/bin',
      OPENAI_API_KEY: 'ambient-openai-key',
      CODEX_API_KEY: 'ambient-codex-key',
      CODEX_ACCESS_TOKEN: 'ambient-access-token',
    },
    providerContext: providerContext(mode),
    adapterProviderAuth: providerAuthById['openai-codex'],
    providerContextRequired: true,
    clientId: 'codex',
  });
}

describe('Codex central auth runtime integration', () => {
  it('materializes native auth-only state and scrubs every competing process input', async () => {
    const leases = setupLease(true);
    const prepared = await prepareAdapterAuthRuntime(await runtimeConfig('native'));

    expect(leases.createPayloads[0]?.configInheritance).toBe('auth-only');
    expect(prepared.config.env).toEqual({ PATH: '/base/bin', CODEX_HOME: '/tmp/codex-auth-runtime' });
    expect(prepared.config.adapterAuth).toEqual({
      processEnv: {},
      connectorDeliveries: [],
      configInheritance: 'auth-only',
    });

    await prepared.lease?.release();
    expect(leases.destroyPayloads).toHaveLength(1);
  });

  it('injects only the selected access token into an empty config lease', async () => {
    setupCredentialChannel({ 'env:CODEX_ACCESS_TOKEN': 'selected-access-token' });
    const leases = setupLease(false);
    const prepared = await prepareAdapterAuthRuntime(await runtimeConfig('access-token'));

    expect(leases.createPayloads[0]?.configInheritance).toBe('empty');
    expect(prepared.config.env).toEqual({
      PATH: '/base/bin',
      CODEX_HOME: '/tmp/codex-auth-runtime',
      CODEX_ACCESS_TOKEN: 'selected-access-token',
    });
    expect(prepared.config.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(prepared.config.env).not.toHaveProperty('CODEX_API_KEY');
    expect(prepared.config.adapterAuth?.connectorDeliveries).toEqual([]);

    await prepared.lease?.release();
  });

  it('keeps OPENAI_API_KEY as a source and delivers it only through account/login/start', async () => {
    setupCredentialChannel({ 'env:OPENAI_API_KEY': 'selected-api-key' });
    const leases = setupLease(false);
    const prepared = await prepareAdapterAuthRuntime(await runtimeConfig('api-key'));

    expect(leases.createPayloads[0]?.configInheritance).toBe('empty');
    expect(prepared.config.env).toEqual({ PATH: '/base/bin', CODEX_HOME: '/tmp/codex-auth-runtime' });
    expect(prepared.config.adapterAuth).toEqual({
      processEnv: {},
      connectorDeliveries: [
        {
          target: 'codex.account-login.api-key',
          values: { apiKey: 'selected-api-key', type: 'apiKey' },
        },
      ],
      configInheritance: 'empty',
    });

    await prepared.lease?.release();
  });

  it('releases the Codex lease through the central connector runtime close path', async () => {
    const leases = setupLease(true);
    const runtimes = new ConformanceConnectorRuntimeRegistry<CodexAppServerBus, CodexAppServerConnector>();
    const connector = await runtimes.create({
      config: await runtimeConfig('native'),
      connectorFactory: (config) =>
        new CodexAppServerConnector({
          ...config,
          jsonRpcClient: new MockJsonRpcClient(),
        }),
    });

    await connector.close();
    await runtimes.closeAll();

    expect(leases.createPayloads).toHaveLength(1);
    expect(leases.destroyPayloads).toHaveLength(1);
  });
});
