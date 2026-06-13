import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { createTestAdapter, MockConnector, type BaseAgentConnectorConfig, type TestBus } from './shared.js';

describe('AIAdapter.handleRehydrateAgent native resume context', () => {
  let adapter: ReturnType<typeof createTestAdapter>['adapter'];
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  it('passes persisted adapterSessionId as native resume context during cold rehydrate', async () => {
    const capturedConfigs: Array<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> = [];
    ({ adapter } = createTestAdapter('test-adapter-rehydrate-config', {
      configFactory: async (input) => ({
        bus: input.bus,
        agentId: input.agentId,
        adapterId: input.adapterId,
        adapterName: input.adapterName,
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
        ...(input.allowedDirectories !== undefined && { allowedDirectories: input.allowedDirectories }),
        ...(input.adapterSessionId !== undefined && { adapterSessionId: input.adapterSessionId }),
        ...(input.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: input.resumeAdapterSessionId }),
      }),
      connectorFactory: async (config) => {
        capturedConfigs.push(config);
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: 'test-adapter-rehydrate-config',
            sessionId: 'persisted-session',
            adapterSessionId: 'persisted-native-session',
            role: 'lead',
            status: 'idle',
            model: 'persisted-model',
            cwd: os.tmpdir(),
            allowedDirectories: ['/workspace'],
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: 'persisted-agent-resume',
    });

    expect(capturedConfigs).toContainEqual(
      expect.objectContaining({
        adapterSessionId: 'persisted-native-session',
        resumeAdapterSessionId: 'persisted-native-session',
        allowedDirectories: ['/workspace'],
      }),
    );
  });

  it('passes requested adapterSessionId as native resume context during warm rehydrate', async () => {
    const capturedConfigs: Array<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> = [];
    ({ adapter } = createTestAdapter('test-adapter-warm-rehydrate-config', {
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
        capturedConfigs.push(config);
        return new MockConnector(config);
      },
    }));
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const startResult = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: 'warm-session',
      adapterSessionId: 'live-native-session',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: { providerConfigId: 'provider-config', definitionId: 'provider', credentialRefs: {} },
    });
    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('Failed to start agent');

    await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
      adapterId: adapter.adapterId,
      agentId: startResult.agentId,
      adapterSessionId: 'persisted-native-session',
    });

    expect(capturedConfigs.at(-1)).toEqual(
      expect.objectContaining({
        adapterSessionId: 'persisted-native-session',
        resumeAdapterSessionId: 'persisted-native-session',
      }),
    );
  });
});
