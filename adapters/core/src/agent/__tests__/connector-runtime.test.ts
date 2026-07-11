import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { ClientSubjects, defineAdapterProviderAuth } from '@makaio/contracts';
import { resolveClientBinary } from '@makaio/subsystem-client';
import { bindProviderAuth } from '../../config/resolve-adapter-auth.js';
import type { BoundAdapterRuntimeConfig } from '../../config/adapter-auth-runtime.js';
import { closeConnectorRuntime, createConnectorRuntime } from '../connector-runtime.js';
import { AgentConnectorLifecycleManager } from '../agent-connector-lifecycle-manager.js';
import { asAgentConnector, MockConnector } from './helpers/mock-agent.js';

vi.mock('@makaio/subsystem-client', () => ({
  resolveClientBinary: vi.fn(),
}));

const resolveClientBinaryMock = vi.mocked(resolveClientBinary);
const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
  vi.resetAllMocks();
});

/** Build a no-auth client-backed config that still requires an empty lease. */
function noAuthRuntimeConfig(): BoundAdapterRuntimeConfig {
  const { bus } = createMockScopedBus();
  const method = { owner: 'provider', providerDefinitionId: 'local', methodId: 'none' } as const;
  return {
    bus,
    globalBus: MakaioBus,
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    sessionId: 'session-1',
    clientId: 'codex',
    model: 'test-model',
    cwd: '/work/project',
    env: {},
    boundProviderAuth: bindProviderAuth({
      auth: {
        mode: 'none',
        method,
        definition: { id: 'none', mode: 'none', label: 'No authentication' },
      },
      adapterProviderAuth: defineAdapterProviderAuth({
        bindings: [{ method, deliveries: [{ kind: 'none' }] }],
        scrubEnvVars: [],
      }),
    }),
  };
}

describe('connector runtime lifecycle', () => {
  it('releases a prepared lease when the connector factory fails', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const createdLeaseIds: string[] = [];
    const destroyedLeaseIds: string[] = [];
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        createdLeaseIds.push(ctx.payload.leaseId);
        ctx.setResult({ sessionDir: '/tmp/runtime-config', env: {}, authMaterialized: false });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        destroyedLeaseIds.push(ctx.payload.leaseId);
        ctx.setResult({ success: true });
      }),
    );

    await expect(
      createConnectorRuntime({
        config: noAuthRuntimeConfig(),
        connectorFactory: () => {
          throw new Error('connector factory failed');
        },
      }),
    ).rejects.toThrow('connector factory failed');

    expect(createdLeaseIds).toHaveLength(1);
    expect(destroyedLeaseIds).toEqual(createdLeaseIds);
  });

  it('always attempts lease release and aggregates it with a connector close failure', async () => {
    const closeError = new Error('connector close failed');
    const releaseError = new Error('lease release failed');
    const release = vi.fn(async () => {
      throw releaseError;
    });
    const close = vi.fn(async () => {
      throw closeError;
    });

    let captured: unknown;
    try {
      await closeConnectorRuntime({
        connector: { close } as never,
        lease: { clientId: 'codex', leaseId: 'lease-1', release },
      });
    } catch (error) {
      captured = error;
    }

    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(captured).toBeInstanceOf(AggregateError);
    expect((captured as AggregateError).errors).toEqual([closeError, releaseError]);
  });

  it('initializes the replacement before publishing it and releasing the previous runtime', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const events: string[] = [];
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        events.push('new-lease-created');
        ctx.setResult({ sessionDir: '/tmp/replacement-config', env: {}, authMaterialized: false });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        events.push('new-lease-released');
        ctx.setResult({ success: true });
      }),
    );

    const oldConnector = new MockConnector('old-model', '/work/project');
    oldConnector.close = vi.fn(async () => {
      events.push('old-connector-closed');
    });
    const oldLeaseRelease = vi.fn(async () => {
      events.push('old-lease-released');
    });
    let currentRuntime = {
      connector: asAgentConnector(oldConnector),
      lease: { clientId: 'codex', leaseId: 'old-lease', release: oldLeaseRelease },
    };

    const manager = new AgentConnectorLifecycleManager({
      agentId: 'agent-1',
      buildConfigInput: () => ({}) as never,
      configFactory: async () => noAuthRuntimeConfig(),
      connectorFactory: async () => {
        events.push('new-connector-created');
        const connector = new MockConnector('new-model', '/work/project');
        connector.initialize = vi.fn(async () => {
          events.push('new-connector-initialized');
        });
        return asAgentConnector(connector);
      },
      createOnMessageSent: () => () => undefined,
      wireEvents: () => undefined,
      emitIdle: async () => undefined,
      getConnectorRuntime: () => currentRuntime,
      setConnectorRuntime: (runtime) => {
        events.push('new-runtime-published');
        currentRuntime = runtime as typeof currentRuntime;
      },
      getRuntimeSystemPrompt: () => undefined,
      setLastKnownAdapterSessionId: () => undefined,
      reportCleanupFailure: () => undefined,
    });

    await manager.swapConnector({ model: 'new-model' });

    expect(events.slice(0, 7)).toEqual([
      'new-lease-created',
      'new-connector-created',
      'new-connector-initialized',
      'new-runtime-published',
      'old-connector-closed',
      'old-lease-released',
    ]);
    expect(currentRuntime.connector.model).toBe('new-model');
    await closeConnectorRuntime(currentRuntime);
    expect(events.at(-1)).toBe('new-lease-released');
  });

  it('keeps the ready replacement primary when old connector and lease cleanup fail', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    cleanups.push(
      MakaioBus.on(ClientSubjects.sessionConfig.create, (ctx) => {
        ctx.setResult({ sessionDir: '/tmp/replacement-config', env: {}, authMaterialized: false });
      }),
      MakaioBus.on(ClientSubjects.sessionConfig.destroy, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const oldConnector = new MockConnector('old-model', '/work/project');
    oldConnector.close = vi.fn(async () => {
      throw new Error('old connector cleanup failed');
    });
    const oldLeaseRelease = vi.fn(async () => {
      throw new Error('old lease cleanup failed');
    });
    let currentRuntime = {
      connector: asAgentConnector(oldConnector),
      lease: { clientId: 'codex', leaseId: 'old-lease', release: oldLeaseRelease },
    };
    const reportCleanupFailure = vi.fn();

    const manager = new AgentConnectorLifecycleManager({
      agentId: 'agent-1',
      buildConfigInput: () => ({}) as never,
      configFactory: async () => noAuthRuntimeConfig(),
      connectorFactory: async () => asAgentConnector(new MockConnector('new-model', '/work/project')),
      createOnMessageSent: () => () => undefined,
      wireEvents: () => undefined,
      emitIdle: async () => undefined,
      getConnectorRuntime: () => currentRuntime,
      setConnectorRuntime: (runtime) => {
        currentRuntime = runtime as typeof currentRuntime;
      },
      getRuntimeSystemPrompt: () => undefined,
      setLastKnownAdapterSessionId: () => undefined,
      reportCleanupFailure,
    });

    await expect(manager.swapConnector({ model: 'new-model' })).resolves.toBeUndefined();
    expect(currentRuntime.connector.model).toBe('new-model');
    expect(oldConnector.close).toHaveBeenCalledOnce();
    expect(oldLeaseRelease).toHaveBeenCalledOnce();
    expect(reportCleanupFailure).toHaveBeenCalledWith({
      code: 'previous-connector-cleanup-failed',
      stage: 'swap-old-runtime',
      agentId: 'agent-1',
    });
    await closeConnectorRuntime(currentRuntime);
  });
});
