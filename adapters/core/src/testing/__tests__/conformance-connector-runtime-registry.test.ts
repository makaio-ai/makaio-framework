import { describe, expect, it, vi } from 'vitest';
import { createMockScopedBus } from '@makaio/test-utils';
import type { PreparedAdapterAuthRuntime } from '../../config/adapter-auth-runtime.js';
import { asAgentConnector, MockConnector } from '../../agent/__tests__/helpers/mock-agent.js';
import { ConformanceConnectorRuntimeRegistry } from '../conformance-connector-runtime-registry.js';

/** Build the minimal resolved runtime returned by the injected auth preparer. */
function preparedRuntime(): PreparedAdapterAuthRuntime {
  const { bus } = createMockScopedBus();
  return {
    config: {
      bus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      model: 'test-model',
      cwd: '/work/project',
      contextEnv: {},
    },
  };
}

describe('ConformanceConnectorRuntimeRegistry', () => {
  it('releases the lease exactly once when connector close and suite cleanup overlap', async () => {
    const release = vi.fn(async () => undefined);
    const close = vi.fn(async () => ({ evidence: 'released' }) as const);
    const prepared = preparedRuntime();
    const registry = new ConformanceConnectorRuntimeRegistry();

    const connector = await registry.create({
      config: prepared.config,
      prepareAuthRuntime: async () => ({
        ...prepared,
        lease: { clientId: 'claude-code', leaseId: 'lease-1', release },
      }),
      connectorFactory: () => {
        const mock = new MockConnector('test-model', '/work/project');
        mock.close = close;
        return asAgentConnector(mock);
      },
    });

    await Promise.all([connector.close(), connector.close(), registry.closeAll()]);

    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves connector and lease failures through the managed close path', async () => {
    const closeError = new Error('connector close failed');
    const releaseError = new Error('lease release failed');
    const prepared = preparedRuntime();
    const registry = new ConformanceConnectorRuntimeRegistry();
    await registry.create({
      config: prepared.config,
      prepareAuthRuntime: async () => ({
        ...prepared,
        lease: {
          clientId: 'claude-code',
          leaseId: 'lease-1',
          release: async () => {
            throw releaseError;
          },
        },
      }),
      connectorFactory: () => {
        const mock = new MockConnector('test-model', '/work/project');
        mock.close = async () => {
          throw closeError;
        };
        return asAgentConnector(mock);
      },
    });

    // The managed close reports instead of rejecting, so `closeAll` is the surface
    // that still raises: both failures have to survive the conversion, or a
    // conformance suite would finish green while holding a connector and a lease.
    let captured: unknown;
    try {
      await registry.closeAll();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AggregateError);
    expect((captured as AggregateError).errors).toEqual([closeError, releaseError]);
    // Idempotent: the connector was closed once, and a second sweep has nothing
    // left to fail on.
    await expect(registry.closeAll()).resolves.toBeUndefined();
  });
});
