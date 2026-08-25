import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type TeardownEvidence,
} from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

const MACHINE_ID = 'ownership-consumer-machine';
const ADAPTER_ID = 'ownership-consumer-adapter';
const ADAPTER_NAME = 'test-adapter';

describe('MakaioSessionService ownership consumers', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let cleanups: Array<() => void>;

  beforeEach(async () => {
    bus = createBusInstance();
    cleanups = registerMemorySessionBackends(bus);
    service = new MakaioSessionService(bus, { machineId: MACHINE_ID });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
  });

  /**
   * Persist one session, agent and identified ownership generation.
   * @param sessionId - Session to create.
   * @param agentId - Agent to create.
   * @param ownerInstanceId - Runtime process that owns the generation.
   * @returns Provider-session key held by the claim.
   */
  async function seedOwnedAgent(sessionId: string, agentId: string, ownerInstanceId: string): Promise<string> {
    await bus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        runtimeOwner: { machineId: MACHINE_ID, instanceId: ownerInstanceId },
        role: 'lead',
      }),
    });
    const providerSessionId = `provider-${agentId}`;
    const claimed = await bus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      providerSessionId,
      sessionId,
      agentId,
      claimToken: `token-${agentId}`,
      ownerInstance: { instanceId: ownerInstanceId },
    });
    expect(claimed.outcome).toBe('claimed');
    return providerSessionId;
  }

  /**
   * Seed a live-owner row whose connector has no provider-session claim.
   * @param sessionId - Session to create.
   * @param agentId - Claimless agent to create.
   * @param ownerInstanceId - Runtime process hosting the connector.
   */
  async function seedClaimlessOwnedAgent(sessionId: string, agentId: string, ownerInstanceId: string): Promise<void> {
    await seedOwnedAgent(sessionId, agentId, ownerInstanceId);
    await bus.request(SessionSubjects.ownership.release, { agentId, disposition: 'released' });
  }

  /**
   * Seed the post-dispatch state of an idle keyless start before its first movement.
   * @param sessionId - Session to create.
   * @param agentId - Claimless agent to create.
   * @param ownerInstanceId - Runtime process hosting the connector.
   */
  async function seedKeylessOwnedAgent(sessionId: string, agentId: string, ownerInstanceId: string): Promise<void> {
    await bus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        runtimeOwner: { machineId: MACHINE_ID, instanceId: ownerInstanceId },
        role: 'lead',
      }),
    });
  }

  /**
   * Register one targeted adapter stop answer.
   * @param evidence - Evidence returned for the exact owner.
   * @returns Captured stop requests.
   */
  function answerStops(
    evidence: TeardownEvidence,
  ): Array<{ adapterId: string; agentId: string; ownerInstanceId?: string }> {
    const requests: Array<{ adapterId: string; agentId: string; ownerInstanceId?: string }> = [];
    cleanups.push(
      bus.on(AdapterSubjects.stopAgent, (ctx) => {
        requests.push(ctx.payload);
        ctx.setResult({ success: true, evidence });
      }),
    );
    return requests;
  }

  it('releases removal claims only after the exact owner reports observed teardown', async () => {
    const ownerInstanceId = 'owner-removal-observed';
    await seedOwnedAgent('session-removal-observed', 'agent-removal-observed', ownerInstanceId);
    const stops = answerStops('released');

    await bus.emit(SessionSubjects.agent.removed, {
      sessionId: 'session-removal-observed',
      agentId: 'agent-removal-observed',
    });

    expect(stops).toEqual([{ adapterId: ADAPTER_ID, agentId: 'agent-removal-observed', ownerInstanceId }]);
    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, {
      agentId: 'agent-removal-observed',
    });
    expect(ownership?.claims).toEqual([]);
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-removal-observed' });
    expect(agent?.status).toBe('disposed');
  });

  it('retains removal claims when the exact owner reports weak teardown', async () => {
    await seedOwnedAgent('session-removal-weak', 'agent-removal-weak', 'owner-removal-weak');
    answerStops('detached');

    await bus.emit(SessionSubjects.agent.removed, {
      sessionId: 'session-removal-weak',
      agentId: 'agent-removal-weak',
    });

    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, {
      agentId: 'agent-removal-weak',
    });
    expect(ownership?.claims).toEqual([
      expect.objectContaining({ ownerInstanceId: 'owner-removal-weak', status: 'abandoned' }),
    ]);
  });

  it('routes claimless removal to the runtime owner recorded on the agent', async () => {
    const ownerInstanceId = 'owner-removal-claimless';
    await seedClaimlessOwnedAgent('session-removal-claimless', 'agent-removal-claimless', ownerInstanceId);
    const stops = answerStops('detached');

    await bus.emit(SessionSubjects.agent.removed, {
      sessionId: 'session-removal-claimless',
      agentId: 'agent-removal-claimless',
    });

    expect(stops).toEqual([{ adapterId: ADAPTER_ID, agentId: 'agent-removal-claimless', ownerInstanceId }]);
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-removal-claimless' });
    expect(agent?.status).toBe('disposed');
  });

  it('routes keyless removal before the runtime owner has a storage row', async () => {
    const ownerInstanceId = 'owner-removal-keyless';
    await seedKeylessOwnedAgent('session-removal-keyless', 'agent-removal-keyless', ownerInstanceId);
    const runtime = await bus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
      instanceId: ownerInstanceId,
      machineId: MACHINE_ID,
    });
    expect(runtime.instance).toBeNull();
    const stops = answerStops('detached');

    await bus.emit(SessionSubjects.agent.removed, {
      sessionId: 'session-removal-keyless',
      agentId: 'agent-removal-keyless',
    });

    expect(stops).toEqual([{ adapterId: ADAPTER_ID, agentId: 'agent-removal-keyless', ownerInstanceId }]);
  });

  it('releases a retired owner generation without dispatching a stop', async () => {
    const ownerInstanceId = 'owner-removal-retired';
    await seedOwnedAgent('session-removal-retired', 'agent-removal-retired', ownerInstanceId);
    await bus.request(SessionOwnershipStorageSubjects.retireInstance, { instanceId: ownerInstanceId });
    const stops = answerStops('unknown');

    await bus.emit(SessionSubjects.agent.removed, {
      sessionId: 'session-removal-retired',
      agentId: 'agent-removal-retired',
    });

    expect(stops).toEqual([]);
    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, {
      agentId: 'agent-removal-retired',
    });
    expect(ownership?.claims).toEqual([]);
  });

  it('purges only after sealing agents and observing every exact owner', async () => {
    const sessionId = 'session-purge-observed';
    const childSessionId = 'session-purge-child';
    const ownerInstanceId = 'owner-purge-observed';
    await seedOwnedAgent(sessionId, 'agent-purge-observed', ownerInstanceId);
    await bus.request(SessionSubjects.create, { sessionId: childSessionId, parentSessionId: sessionId });
    await bus.request(SessionSubjects.close, { sessionId });
    await bus.request(SessionSubjects.archive, { sessionId });
    const stops = answerStops('closed');

    const result = await bus.request(SessionSubjects.purge, { sessionId });

    expect(result).toEqual({ success: true, eventsDeleted: 0 });
    expect(stops).toEqual([{ adapterId: ADAPTER_ID, agentId: 'agent-purge-observed', ownerInstanceId }]);
    expect((await bus.request(SessionSubjects.get, { sessionId })).session).toBeNull();
    expect((await bus.request(SessionSubjects.get, { sessionId: childSessionId })).session?.parentSessionId).toBe(
      undefined,
    );
  });

  it('retains the archived graph and blocking claim when purge teardown is unobserved', async () => {
    const sessionId = 'session-purge-weak';
    const childSessionId = 'session-purge-weak-child';
    await seedOwnedAgent(sessionId, 'agent-purge-weak', 'owner-purge-weak');
    await bus.request(SessionSubjects.create, { sessionId: childSessionId, parentSessionId: sessionId });
    await bus.request(SessionSubjects.close, { sessionId });
    await bus.request(SessionSubjects.archive, { sessionId });
    answerStops('unknown');

    const result = await bus.request(SessionSubjects.purge, { sessionId });

    expect(result).toEqual({
      success: false,
      error: 'Cannot purge session while an owner runtime may still hold an agent connector.',
    });
    expect((await bus.request(SessionSubjects.get, { sessionId })).session?.status).toBe('archived');
    expect((await bus.request(SessionSubjects.get, { sessionId: childSessionId })).session?.parentSessionId).toBe(
      sessionId,
    );
    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId: 'agent-purge-weak' });
    expect(ownership?.claims).toEqual([expect.objectContaining({ status: 'abandoned' })]);
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-purge-weak' });
    expect(agent?.status).toBe('disposed');
  });

  it('retains an archived claimless agent when its exact owner reports weak teardown', async () => {
    const sessionId = 'session-purge-claimless';
    const ownerInstanceId = 'owner-purge-claimless';
    await seedClaimlessOwnedAgent(sessionId, 'agent-purge-claimless', ownerInstanceId);
    await bus.request(SessionSubjects.close, { sessionId });
    await bus.request(SessionSubjects.archive, { sessionId });
    const stops = answerStops('unknown');

    const result = await bus.request(SessionSubjects.purge, { sessionId });

    expect(result.success).toBe(false);
    expect(stops).toEqual([{ adapterId: ADAPTER_ID, agentId: 'agent-purge-claimless', ownerInstanceId }]);
    expect((await bus.request(SessionSubjects.get, { sessionId })).session?.status).toBe('archived');
  });
});
