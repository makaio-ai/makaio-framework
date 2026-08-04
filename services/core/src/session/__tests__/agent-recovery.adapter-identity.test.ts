import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { verifyAndRecoverAgents } from '../utils/agent-recovery.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

/** Machine the authority is composed with, and therefore claims under. */
const MACHINE_ID = 'recovery-identity-machine';
/** Session both agents live in. */
const SESSION_ID = 'session-multi-adapter';

/**
 * Adapter identity of a reserved recovery, on a host that composes the
 * authority the recovery now requires.
 *
 * Real memory backends and the real service throughout: the recovery reserves
 * before it dispatches, so a host without the authority would fail every case
 * here for a reason that has nothing to do with adapter identity.
 */
describe('verifyAndRecoverAgents adapter identity', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let cleanups: Array<() => void> = [];

  beforeEach(async () => {
    bus = createBusInstance();
    cleanups = [
      ...registerMemorySessionBackends(bus),
      bus.on(AdapterSubjects.getAgent, (ctx) => {
        ctx.setResult({ agent: null }); // every agent in these cases is dead
      }),
    ];
    service = new MakaioSessionService(bus, { machineId: MACHINE_ID });
    await service.init();
    await bus.request(SessionSubjects.create, { sessionId: SESSION_ID, machineId: MACHINE_ID });
  });

  afterEach(() => {
    service.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Persist a dead agent with a deliberately stale `adapterId`, so a resolution
   * that never happens is visible in the dispatch.
   * @param agentId - Agent identifier
   * @param adapterName - Adapter type this agent belongs to
   * @returns The stored agent record
   */
  async function seedDeadAgent(agentId: string, adapterName: string): Promise<MakaioSessionAgent> {
    const agent = createTestAgent(agentId, {
      sessionId: SESSION_ID,
      adapterName,
      adapterId: `stale-${adapterName}`,
      status: 'dead',
    });
    await bus.request(AgentStorageSubjects.set, { agentId, agent });
    return agent;
  }

  it('resolves an adapter instance per dead agent, so a batch may span adapters', async () => {
    // One recovery config, two adapters: a batch-wide adapter ID would
    // rehydrate one of these agents into the other adapter's instance.
    const agents = [await seedDeadAgent('dead-claude', 'claude-code'), await seedDeadAgent('dead-codex', 'codex')];
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: `live-${ctx.payload.adapterName}` });
      }),
    );

    const rehydrateTargets: Array<{ agentId: string; adapterId: string; callerOwnsAgentRow?: true }> = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push({
          agentId: ctx.payload.agentId,
          adapterId: ctx.payload.adapterId,
          ...(ctx.payload.callerOwnsAgentRow !== undefined && { callerOwnsAgentRow: ctx.payload.callerOwnsAgentRow }),
        });
        ctx.setResult({ success: true });
      }),
    );

    const { usable, recoveredAgentIds, deferredAgentIds } = await verifyAndRecoverAgents(bus, agents, {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });

    // Case 96: the recovery dispatches with `callerOwnsAgentRow`, which is what
    // suppresses the adapter's own status write for a row the service owns.
    expect(rehydrateTargets).toEqual([
      { agentId: 'dead-claude', adapterId: 'live-claude-code', callerOwnsAgentRow: true },
      { agentId: 'dead-codex', adapterId: 'live-codex', callerOwnsAgentRow: true },
    ]);
    // Each recovered record carries the instance it was actually rehydrated
    // into, so a later ownership act names the same one.
    expect(usable.map((agent) => agent.adapterId)).toEqual(['live-claude-code', 'live-codex']);
    expect(recoveredAgentIds).toEqual(new Set(['dead-claude', 'dead-codex']));
    expect(deferredAgentIds.size).toBe(0);
  });

  it('resolves the instance for the machine its ownership acts name', async () => {
    // One identity for the whole recovery. The instance ID is derived from
    // `(machineId, adapterName)` and the reservation is filed under `machineId`,
    // so resolving the instance for this runtime's own machine while reserving
    // for the caller's would build a key no other actor computes.
    const agent = await seedDeadAgent('dead-scoped', 'claude-code');
    const lookups: Array<{ adapterName: string; machineId?: string }> = [];
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        lookups.push({ adapterName: ctx.payload.adapterName, machineId: ctx.payload.machineId });
        ctx.setResult({ adapterId: `live-${ctx.payload.adapterName}` });
      }),
    );
    const rehydrateTargets: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.adapterId);
        ctx.setResult({ success: true });
      }),
    );

    const { usable, deferredAgentIds } = await verifyAndRecoverAgents(bus, [agent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
    });

    expect(lookups).toEqual([{ adapterName: 'claude-code', machineId: MACHINE_ID }]);
    expect(rehydrateTargets).toEqual(['live-claude-code']);
    expect(deferredAgentIds.size).toBe(0);
    // The send path's plan is fresh-with-history, so the reservation is keyless
    // and leaves no claim row to inspect — the instance the dispatch used is the
    // observable half, and it is the same one the lookup was scoped for.
    expect(usable.map((entry) => entry.adapterId)).toEqual(['live-claude-code']);
  });

  it('defers rather than recover an agent whose named machine has no instance', async () => {
    // The stored ID may not stand in here: an instance ID is a one-way hash of
    // `(machineId, adapterName)`, so the machine it belongs to cannot be
    // recovered from it, and reserving under the named machine while dispatching
    // at that instance is the mixed key. An agent this runtime cannot address in
    // the identity it must act under is one it may not drive.
    const agent = await seedDeadAgent('dead-unscopable', 'claude-code');
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.resolveId, () => {
        throw new Error('no adapter instance for this machine');
      }),
    );
    const rehydrateTargets: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.adapterId);
        ctx.setResult({ success: true });
      }),
    );

    const { usable, recoveredAgentIds, deferredAgentIds } = await verifyAndRecoverAgents(bus, [agent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
    });

    expect(deferredAgentIds).toEqual(new Set(['dead-unscopable']));
    expect(usable).toEqual([]);
    expect(recoveredAgentIds.size).toBe(0);
    // Nothing was addressed at all: no dispatch, and therefore no ownership act
    // in a namespace this runtime could not have derived.
    expect(rehydrateTargets).toEqual([]);
  });

  it('takes back a dead row for an agent whose connector answers', async () => {
    // The same contradiction the orchestrator's veto resolves, reached without
    // one: the arbitration marks a row `dead` to claim a recovery, a probe then
    // finds a live connector, and this pass — which probes every target — is
    // where the product send meets that row. Leaving it would report a live
    // agent as recoverable to every later consumer that does not probe, and
    // nothing else lifts it.
    const agent = await seedDeadAgent('dead-but-answering', 'claude-code');
    cleanups.push(
      bus.on(
        AdapterSubjects.getAgent,
        (ctx) => {
          ctx.setResult({ agent: { agentId: ctx.payload.agentId, sessionId: SESSION_ID } });
        },
        // Ahead of the suite's "every agent is dead" stand-in.
        { priority: 100 },
      ),
    );
    const rehydrateTargets: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.agentId);
        ctx.setResult({ success: true });
      }),
    );

    const { usable, recoveredAgentIds } = await verifyAndRecoverAgents(bus, [agent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });

    expect(usable.map((entry) => entry.agentId)).toEqual(['dead-but-answering']);
    expect(recoveredAgentIds.size).toBe(0);
    expect(rehydrateTargets).toEqual([]);
    const { agent: stored } = await bus.request(AgentStorageSubjects.get, { agentId: 'dead-but-answering' });
    expect(stored?.status).toBe('idle');
  });

  it('falls back to the stored adapter ID when the caller names no machine', async () => {
    // The unscoped form, and the asymmetry is the point: with no machine named,
    // every act of this recovery is unscoped too, so the stored instance cannot
    // mix two identities. Recovery must still be attempted — an unresolvable
    // adapter name is a routing question, not evidence that the agent is beyond
    // recovery.
    const agent = await seedDeadAgent('dead-unresolvable', 'claude-code');
    const rehydrateTargets: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.adapterId);
        ctx.setResult({ success: true });
      }),
    );

    await verifyAndRecoverAgents(bus, [agent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN });

    expect(rehydrateTargets).toEqual(['stale-claude-code']);
  });
});
