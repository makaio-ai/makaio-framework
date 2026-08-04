import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  CredentialSubjects,
  defineAdapterProviderAuth,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import {
  AdapterSubsystemSubjects,
  type AdapterRuntimeSnapshotResolution,
} from '@makaio/services-core/adapter-subsystem';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  MockConnector,
  TestAdapter,
  createTestAdapter as createTestAdapterShared,
  type BaseAgentConnectorConfig,
  type ConfigFactoryInput,
  type TestBus,
} from './shared.js';

const MANAGED_PROVIDER_CONTEXT = {
  state: 'resolved',
  providerConfigId: 'managed-provider-config',
  definitionId: 'managed-provider',
  auth: {
    mode: 'inferred',
    method: { owner: 'client', clientId: 'managed-client', methodId: 'native' },
    definition: { id: 'native', mode: 'inferred', label: 'Managed native account' },
    account: { managerId: 'account-manager', accountId: 'managed-account' },
  },
} satisfies ResolvedProviderContext;

/** Connector that exposes cold-rehydrate readiness and cleanup ordering. */
class RehydrateLifecycleConnector extends MockConnector {
  public constructor(
    config: BaseAgentConnectorConfig<TestBus> & { adapterId: string },
    private readonly events: string[],
  ) {
    super(config);
  }

  /** Record the connector-ready boundary. */
  public override async initialize(): Promise<void> {
    this.events.push('initialize');
  }

  /** Record runtime cleanup before delegating to the shared connector. */
  public override async close(): Promise<void> {
    this.events.push('close');
    await super.close();
  }
}

/**
 * Build the adapter-qualified runtime snapshot used by managed rehydrate tests.
 * @param adapterName - Adapter selected by the persisted agent
 * @returns Resolved managed native-account runtime
 */
function createManagedRuntimeResolution(adapterName: string): AdapterRuntimeSnapshotResolution {
  return {
    status: 'resolved' as const,
    runtime: {
      snapshot: {
        config: {
          id: MANAGED_PROVIDER_CONTEXT.providerConfigId,
          definitionId: MANAGED_PROVIDER_CONTEXT.definitionId,
          name: 'Managed provider',
          modelFilterMode: 'show-all' as const,
          isDefault: true,
          enabled: true,
          auth: {
            mode: 'inferred' as const,
            method: MANAGED_PROVIDER_CONTEXT.auth.method,
            account: MANAGED_PROVIDER_CONTEXT.auth.account,
            hasCredentials: false as const,
          },
        },
        context: MANAGED_PROVIDER_CONTEXT,
        definition: {
          id: MANAGED_PROVIDER_CONTEXT.definitionId,
          packageName: '@makaio/provider-managed',
          name: 'Managed provider',
          availableModels: [],
          authMethods: [],
          defaultModelFilterMode: 'show-all' as const,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      adapterName,
      adapterClientId: 'managed-client',
      adapterProviderAuth: defineAdapterProviderAuth({
        bindings: [
          {
            method: MANAGED_PROVIDER_CONTEXT.auth.method,
            deliveries: [{ kind: 'native-client', clientId: 'managed-client' }],
          },
        ],
        scrubEnvVars: ['MANAGED_NATIVE_TOKEN'],
      }),
      compatibleProviderAuths: [],
      runtimePackages: {
        adapter: { packageName: '@makaio/adapter-managed' },
        provider: {
          packageName: '@makaio/provider-managed',
          definitionId: MANAGED_PROVIDER_CONTEXT.definitionId,
        },
        client: { packageName: '@makaio/client-managed', clientId: 'managed-client' },
      },
    },
  };
}

/**
 * Create a managed rehydrate adapter with observable auth and connector phases.
 * @param events - Ordered lifecycle event sink
 * @param connectors - Created connector sink
 * @returns Test adapter configured with observable lifecycle factories
 */
function createManagedRehydrateAdapter(events: string[], connectors: RehydrateLifecycleConnector[]): TestAdapter {
  return createTestAdapterShared('test-adapter-managed-rehydrate', {
    configFactory: async (input) => ({
      bus: input.bus,
      agentId: input.agentId,
      adapterId: input.adapterId,
      adapterName: input.adapterName,
      model: input.model ?? 'test-model',
      cwd: input.cwd ?? os.tmpdir(),
      ...(input.adapterSessionId !== undefined && { adapterSessionId: input.adapterSessionId }),
      ...(input.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: input.resumeAdapterSessionId }),
    }),
    connectorFactory: async (config) => {
      const connector = new RehydrateLifecycleConnector(config, events);
      connectors.push(connector);
      return connector;
    },
    prepareAuthRuntime: async (config) => {
      events.push('materialize');
      const { boundProviderAuth: _boundProviderAuth, ...runtimeConfig } = config;
      return { config: { ...runtimeConfig, contextEnv: Object.freeze({}) } };
    },
  }).adapter;
}

/**
 * Register persisted-agent and runtime-resolution handlers for a cold rehydrate.
 * @param adapter - Adapter whose persisted identity is returned
 * @param cleanups - Handler cleanup sink
 */
function registerManagedRehydrateInputs(adapter: TestAdapter, cleanups: Array<() => void>): void {
  cleanups.push(
    MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
      ctx.setResult({
        agent: {
          agentId: ctx.payload.agentId,
          adapterId: adapter.adapterId,
          adapterName: 'test-adapter-managed-rehydrate',
          sessionId: 'managed-session',
          adapterSessionId: 'managed-native-session',
          role: 'lead',
          status: 'dead',
          model: 'managed-model',
          cwd: os.tmpdir(),
          providerConfigId: MANAGED_PROVIDER_CONTEXT.providerConfigId,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        },
      });
    }),
    MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
      ctx.setResult({ success: true, transitioned: true });
    }),
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      ctx.setResult(createManagedRuntimeResolution(ctx.payload.adapterName));
    }),
  );
}

/**
 * Register managed activation transaction handlers for cold-rehydrate tests.
 * @param events - Ordered lifecycle event sink
 * @param cleanups - Handler cleanup sink
 * @param onCommit - Commit behavior keyed by one-based attempt number
 */
function registerManagedActivation(
  events: string[],
  cleanups: Array<() => void>,
  onCommit: (attempt: number) => 'commit-failed' | undefined = () => undefined,
): void {
  let transactionId = 0;
  let commitAttempt = 0;
  cleanups.push(
    MakaioBus.on(CredentialSubjects.activation.prepare, (ctx) => {
      events.push('prepare');
      transactionId += 1;
      ctx.setResult({ success: true, transactionId: `managed-activation-${transactionId}` });
    }),
    MakaioBus.on(CredentialSubjects.activation.commit, (ctx) => {
      events.push('commit');
      commitAttempt += 1;
      const code = onCommit(commitAttempt);
      ctx.setResult(code === undefined ? { success: true } : { success: false, code });
    }),
    MakaioBus.on(CredentialSubjects.activation.rollback, (ctx) => {
      events.push('rollback');
      ctx.setResult({ success: true });
    }),
  );
}

describe('AIAdapter.handleRehydrateAgent provider context', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('builds providerContext during rehydrate when providerConfigId is persisted', async () => {
    let capturedProviderContext: ConfigFactoryInput['providerContext'] | undefined;

    const { adapter } = createTestAdapterShared('test-adapter-rehydrate-provider-context', {
      configFactory: async (input) => {
        capturedProviderContext = input.providerContext;
        return {
          bus: input.bus,
          agentId: input.agentId,
          adapterId: input.adapterId,
          adapterName: input.adapterName,
          model: input.model ?? 'test-model',
          cwd: input.cwd ?? os.tmpdir(),
        } satisfies BaseAgentConnectorConfig<TestBus> & { adapterId: string };
      },
      connectorFactory: async (config) => new MockConnector(config),
    });

    await adapter.init();

    MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
      ctx.setResult({
        agent: {
          agentId: ctx.payload.agentId,
          adapterId: adapter.adapterId,
          adapterName: 'test-adapter-rehydrate-provider-context',
          sessionId: 'persisted-session',
          adapterSessionId: 'persisted-adapter-session',
          role: 'lead',
          status: 'dead' as const,
          model: 'persisted-model',
          cwd: os.tmpdir(),
          providerConfigId: 'provider-1',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        },
      });
    });

    MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
      ctx.setResult({ success: true, transitioned: true });
    });

    const apiKeyRef = buildStoredCredentialRef('provider-1', 'apiKey');

    const resolvedContext = {
      state: 'resolved' as const,
      providerConfigId: 'provider-1',
      definitionId: 'anthropic',
      endpointOverrides: { anthropic: 'https://api.example.test' },
      auth: {
        mode: 'explicit' as const,
        method: { owner: 'provider' as const, providerDefinitionId: 'anthropic', methodId: 'api-key' },
        definition: {
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
        },
        credentialRefs: { apiKey: apiKeyRef },
      },
    };

    const adapterProviderAuth = defineAdapterProviderAuth({
      bindings: [
        {
          method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
          deliveries: [
            {
              kind: 'connector',
              target: 'anthropic-sdk.constructor',
              fields: { apiKey: 'apiKey' },
            },
          ],
        },
      ],
      scrubEnvVars: ['ANTHROPIC_API_KEY'],
    });

    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      expect(ctx.payload).toEqual({
        adapterName: 'test-adapter-rehydrate-provider-context',
        providerConfigId: 'provider-1',
      });
      ctx.setResult({
        status: 'resolved',
        runtime: {
          snapshot: {
            config: {
              id: 'provider-1',
              definitionId: 'anthropic',
              name: 'Anthropic',
              modelFilterMode: 'show-all',
              isDefault: true,
              enabled: true,
              auth: {
                mode: 'explicit',
                method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
                hasCredentials: true,
              },
            },
            context: resolvedContext,
            definition: {
              id: 'anthropic',
              packageName: '@makaio/provider-anthropic',
              name: 'Anthropic',
              endpoints: { anthropic: 'https://api.anthropic.com' },
              availableModels: [],
              authMethods: [resolvedContext.auth.definition],
              defaultModelFilterMode: 'show-all',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          },
          adapterName: 'test-adapter-rehydrate-provider-context',
          providerProtocol: 'anthropic',
          adapterProviderAuth,
          compatibleProviderAuths: [],
          runtimePackages: {
            adapter: { packageName: '@makaio/adapter-test' },
            provider: { packageName: '@makaio/provider-anthropic', definitionId: 'anthropic' },
          },
        },
      });
    });

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'persisted-agent-provider-context',
      cwd: os.tmpdir(),
    });

    // The adapter-qualified snapshot returns credential refs, not plaintext —
    // resolution remains deferred to the connector layer.
    expect(capturedProviderContext).toEqual(resolvedContext);

    await adapter.closeAsync();
  });

  it('commits managed account activation after cold connector readiness and before registry publication', async () => {
    const events: string[] = [];
    const connectors: RehydrateLifecycleConnector[] = [];
    const cleanups: Array<() => void> = [];
    const adapter = createManagedRehydrateAdapter(events, connectors);
    await adapter.init();
    registerManagedRehydrateInputs(adapter, cleanups);
    registerManagedActivation(events, cleanups, () => {
      expect(adapter.getAgent('managed-rehydrate-agent')).toBeUndefined();
      return undefined;
    });

    try {
      await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'managed-rehydrate-agent',
        resumeAdapterSessionId: 'managed-native-session',
      });

      expect(events).toEqual(['prepare', 'materialize', 'initialize', 'commit']);
      expect(connectors).toHaveLength(1);
      expect(adapter.getAgent('managed-rehydrate-agent')).toBeDefined();
    } finally {
      for (const cleanup of cleanups) cleanup();
      await adapter.closeAsync();
    }
  });

  it('fails cold rehydrate before materialization when the selected account manager is missing', async () => {
    const events: string[] = [];
    const connectors: RehydrateLifecycleConnector[] = [];
    const cleanups: Array<() => void> = [];
    const adapter = createManagedRehydrateAdapter(events, connectors);
    await adapter.init();
    registerManagedRehydrateInputs(adapter, cleanups);

    try {
      await expect(
        MakaioBus.request(AdapterSubjects.rehydrateAgent, {
          adapterId: adapter.adapterId,
          agentId: 'missing-manager-rehydrate-agent',
          resumeAdapterSessionId: 'managed-native-session',
        }),
      ).rejects.toThrow('selected account manager is unavailable');
      expect(events).toEqual([]);
      expect(connectors).toEqual([]);
      expect(adapter.getAgent('missing-manager-rehydrate-agent')).toBeUndefined();
    } finally {
      for (const cleanup of cleanups) cleanup();
      await adapter.closeAsync();
    }
  });

  it('closes failed cold runtime and releases its resume claim when activation commit fails', async () => {
    const events: string[] = [];
    const connectors: RehydrateLifecycleConnector[] = [];
    const cleanups: Array<() => void> = [];
    const adapter = createManagedRehydrateAdapter(events, connectors);
    await adapter.init();
    registerManagedRehydrateInputs(adapter, cleanups);
    registerManagedActivation(events, cleanups, (attempt) => (attempt === 1 ? 'commit-failed' : undefined));

    try {
      await expect(
        MakaioBus.request(AdapterSubjects.rehydrateAgent, {
          adapterId: adapter.adapterId,
          agentId: 'failed-commit-rehydrate-agent',
          resumeAdapterSessionId: 'managed-native-session',
        }),
      ).rejects.toThrow('selected account could not be activated');
      expect(connectors[0]?.closeCalled).toBe(true);
      expect(adapter.getAgent('failed-commit-rehydrate-agent')).toBeUndefined();

      await expect(
        MakaioBus.request(AdapterSubjects.rehydrateAgent, {
          adapterId: adapter.adapterId,
          agentId: 'retry-commit-rehydrate-agent',
          resumeAdapterSessionId: 'managed-native-session',
        }),
      ).resolves.toBeDefined();
      expect(connectors).toHaveLength(2);
      expect(adapter.getAgent('retry-commit-rehydrate-agent')).toBeDefined();
      expect(events).toEqual([
        'prepare',
        'materialize',
        'initialize',
        'commit',
        'close',
        'prepare',
        'materialize',
        'initialize',
        'commit',
      ]);
    } finally {
      for (const cleanup of cleanups) cleanup();
      await adapter.closeAsync();
    }
  });
});
