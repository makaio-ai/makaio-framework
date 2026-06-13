import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMemoryAgentStorage } from '../storage/agent-memory-handler.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { MakaioSessionService } from '../session-service.js';
import { createTestAgent } from './shared.js';

describe('MakaioSessionService - restartAgents', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let agentStorageCleanup: () => void;
  let sessionStorageCleanup: () => void;

  beforeEach(async () => {
    bus = createBusInstance();
    agentStorageCleanup = registerMemoryAgentStorage(bus);
    sessionStorageCleanup = registerMemorySessionStorage(bus);
    service = new MakaioSessionService(bus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    sessionStorageCleanup();
    agentStorageCleanup();
  });

  it('rehydrates each persisted session agent through adapter.rehydrateAgent', async () => {
    const sessionId = 'session-restart-success';
    await bus.request(SessionSubjects.create, { sessionId });
    await persistAgent('agent-one', sessionId, {
      adapterId: 'stale-adapter-one',
      adapterName: 'test-adapter',
      cwd: '/workspace/one',
      model: 'model-one',
    });
    await persistAgent('agent-two', sessionId, {
      adapterId: 'stale-adapter-two',
      adapterName: 'test-adapter',
      cwd: '/workspace/two',
      model: 'model-two',
    });

    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });

    const rehydrateRequests: Array<{
      adapterId: string;
      agentId: string;
      cwd?: string;
      model?: string;
      adapterSessionId?: string;
    }> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });

    expect(result).toEqual({
      sessionId,
      results: [
        { agentId: 'agent-one', adapterId: 'current-test-adapter', success: true },
        { agentId: 'agent-two', adapterId: 'current-test-adapter', success: true },
      ],
    });
    expect(rehydrateRequests).toEqual([
      {
        adapterId: 'current-test-adapter',
        agentId: 'agent-one',
        cwd: '/workspace/one',
        model: 'model-one',
        adapterSessionId: 'native-agent-one',
      },
      {
        adapterId: 'current-test-adapter',
        agentId: 'agent-two',
        cwd: '/workspace/two',
        model: 'model-two',
        adapterSessionId: 'native-agent-two',
      },
    ]);

    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-one' });
    expect(agent?.adapterId).toBe('current-test-adapter');
  });

  it('leaves rehydrate-side storage mutations intact', async () => {
    const sessionId = 'session-restart-storage-owner';
    await bus.request(SessionSubjects.create, { sessionId });
    await persistAgent('agent-storage-owner', sessionId, {
      adapterId: 'stale-adapter',
      adapterName: 'test-adapter',
      status: 'dead',
    });

    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });
    bus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      await bus.request(AgentStorageSubjects.updateStatus, {
        agentId: ctx.payload.agentId,
        status: 'idle',
      });
      ctx.setResult({});
    });
    let setCallsDuringRestart = 0;
    bus.on(AgentStorageSubjects.set, (ctx) => {
      setCallsDuringRestart += 1;
      ctx.setResult({ success: true });
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-storage-owner' });

    expect(result.results).toEqual([
      { agentId: 'agent-storage-owner', adapterId: 'current-test-adapter', success: true },
    ]);
    expect(agent?.adapterId).toBe('current-test-adapter');
    expect(agent?.status).toBe('idle');
    expect(setCallsDuringRestart).toBe(0);
  });

  it('reports per-agent failures without aborting remaining rehydrates', async () => {
    const sessionId = 'session-restart-failure';
    await bus.request(SessionSubjects.create, { sessionId });
    await persistAgent('agent-fails', sessionId, { adapterId: 'adapter-fails', adapterName: 'test-adapter' });
    await persistAgent('agent-ok', sessionId, { adapterId: 'adapter-ok', adapterName: 'test-adapter' });

    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      if (ctx.payload.agentId === 'agent-fails') {
        throw new Error('adapter refused rehydrate');
      }
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });

    expect(result).toEqual({
      sessionId,
      results: [
        {
          agentId: 'agent-fails',
          adapterId: 'adapter-fails',
          success: false,
          error: 'adapter refused rehydrate',
        },
        { agentId: 'agent-ok', adapterId: 'adapter-ok', success: true },
      ],
    });
  });

  async function persistAgent(
    agentId: string,
    sessionId: string,
    overrides: {
      adapterId: string;
      adapterName: string;
      cwd?: string;
      model?: string;
      status?: MakaioSessionAgent['status'];
    },
  ): Promise<void> {
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        role: agentId.endsWith('one') || agentId.endsWith('ok') ? 'lead' : 'member',
        ...overrides,
        adapterSessionId: `native-${agentId}`,
      }),
    });
  }
});
