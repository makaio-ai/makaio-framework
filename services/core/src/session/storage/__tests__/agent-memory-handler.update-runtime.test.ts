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

  it('detaches mutable runtime input and returned agent rows from storage', async () => {
    await bus.request(AgentStorageSubjects.set, {
      agentId: 'agent-1',
      agent: {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
        role: 'lead',
        status: 'idle',
        createdAt: 1,
        lastActivityAt: 1,
      },
    });

    const allowedDirectories = ['/workspace'];
    await bus.request(AgentStorageSubjects.updateRuntime, { agentId: 'agent-1', allowedDirectories });
    allowedDirectories.push('/caller-mutation');

    const firstRead = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-1' });
    expect(firstRead.agent?.allowedDirectories).toEqual(['/workspace']);

    firstRead.agent?.allowedDirectories?.push('/returned-row-mutation');
    const secondRead = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-1' });
    expect(secondRead.agent?.allowedDirectories).toEqual(['/workspace']);
  });

  it('persists the exact runtime owner as one detached pair', async () => {
    await bus.request(AgentStorageSubjects.set, {
      agentId: 'agent-owner',
      agent: {
        agentId: 'agent-owner',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
        role: 'lead',
        status: 'idle',
        createdAt: 1,
        lastActivityAt: 1,
      },
    });
    const runtimeOwner = { machineId: 'machine-1', instanceId: 'instance-1' };
    await bus.request(AgentStorageSubjects.updateRuntime, { agentId: 'agent-owner', runtimeOwner });
    runtimeOwner.instanceId = 'caller-mutation';

    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-owner' });
    expect(agent?.runtimeOwner).toEqual({ machineId: 'machine-1', instanceId: 'instance-1' });
  });

  it('preserves an existing recovery attempt fence, including a stored absence', async () => {
    const agent = {
      agentId: 'agent-recovery-fence',
      adapterId: 'adapter-1',
      adapterName: 'test-adapter',
      sessionId: 'session-1',
      role: 'lead' as const,
      status: 'idle' as const,
      createdAt: 1,
      lastActivityAt: 1,
    };
    await bus.request(AgentStorageSubjects.set, { agentId: agent.agentId, agent });
    await bus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent: { ...agent, recoveryAttemptId: 'stale-attempt' },
    });

    expect(
      (await bus.request(AgentStorageSubjects.get, { agentId: agent.agentId })).agent?.recoveryAttemptId,
    ).toBeUndefined();

    await bus.request(AgentStorageSubjects.set, {
      agentId: 'agent-inserted-recovery-fence',
      agent: { ...agent, agentId: 'agent-inserted-recovery-fence', recoveryAttemptId: 'new-attempt' },
    });
    expect(
      (await bus.request(AgentStorageSubjects.get, { agentId: 'agent-inserted-recovery-fence' })).agent
        ?.recoveryAttemptId,
    ).toBe('new-attempt');
  });
});
