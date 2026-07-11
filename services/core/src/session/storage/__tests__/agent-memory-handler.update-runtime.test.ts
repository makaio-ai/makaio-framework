import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { registerMemoryAgentStorage } from '../agent-memory-handler.js';

describe('registerMemoryAgentStorage.updateRuntime', () => {
  const bus = createBusInstance();
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = registerMemoryAgentStorage(bus);
  });

  afterEach(() => cleanup());

  it('uses null to clear providerConfigId while omission leaves it unchanged', async () => {
    await bus.request(AgentStorageSubjects.set, {
      agentId: 'agent-1',
      agent: {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
        providerConfigId: 'provider-1',
        role: 'lead',
        status: 'idle',
        createdAt: 1,
        lastActivityAt: 1,
      },
    });

    await bus.request(AgentStorageSubjects.updateRuntime, { agentId: 'agent-1', model: 'model-2' });
    expect((await bus.request(AgentStorageSubjects.get, { agentId: 'agent-1' })).agent?.providerConfigId).toBe(
      'provider-1',
    );

    await bus.request(AgentStorageSubjects.updateRuntime, { agentId: 'agent-1', providerConfigId: null });
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-1' });
    expect(agent?.providerConfigId).toBeUndefined();
    expect(agent?.model).toBe('model-2');
  });
});
