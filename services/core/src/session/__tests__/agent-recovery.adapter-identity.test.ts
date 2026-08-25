import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { buildDeterministicAdapterId, registerAdapterRuntimeIdentityHandlers } from '../../adapter-runtime/identity.js';
import { MakaioSessionService } from '../session-service.js';
import { registerSessionOwnershipAuthority } from '../ownership/authority.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { callerOwnedSuccessFields, registerCallerSettlementAckHandler } from '../testing/caller-owned-adapter-stub.js';
import { verifyAndRecoverAgents } from '../utils/agent-recovery.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

/** Machine the authority is composed with, and therefore claims under. */
const MACHINE_ID = 'recovery-identity-machine';
/** Session both agents live in. */
const SESSION_ID = 'session-multi-adapter';
/** Foreign runtime hosting an explicitly configured, non-derived adapter id. */
const FOREIGN_MACHINE_ID = 'recovery-identity-foreign-machine';
/** The persisted adapter instance must be routable without deterministic derivation. */
const OPAQUE_FOREIGN_ADAPTER_ID = 'adapter-instance-from-foreign-host';
/** Runtime incarnation used only for owner-specific routing. */
const OPAQUE_FOREIGN_OWNER_INSTANCE_ID = 'owner-instance-from-foreign-host';

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
      registerCallerSettlementAckHandler(bus),
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
   * @param overrides - Optional persisted-agent fields to override.
   * @returns The stored agent record
   */
  async function seedDeadAgent(
    agentId: string,
    adapterName: string,
    overrides: Partial<MakaioSessionAgent> = {},
  ): Promise<MakaioSessionAgent> {
    const agent = createTestAgent(agentId, {
      sessionId: SESSION_ID,
      adapterName,
      adapterId: `stale-${adapterName}`,
      status: 'dead',
      runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
      ...overrides,
    });
    await bus.request(AgentStorageSubjects.set, { agentId, agent });
    return agent;
  }

  it('resolves an adapter instance per dead agent, so a batch may span adapters', async () => {
    // One recovery config, two adapters: a batch-wide adapter ID would
    // rehydrate one of these agents into the other adapter's instance.
    const agents = [
      await seedDeadAgent('dead-claude', 'claude-code', { adapterId: 'live-claude-code' }),
      await seedDeadAgent('dead-codex', 'codex', { adapterId: 'live-codex' }),
    ];
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: `live-${ctx.payload.adapterName}` });
      }),
      bus.on(AdapterRuntimeSubjects.resolveLiveIdentity, (ctx) => {
        ctx.setResult({ ...ctx.payload, ownerInstanceId: service.requireOwnershipInstanceId() });
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
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
    );

    const { usable, recoveredAgentIds, deferredAgentIds } = await verifyAndRecoverAgents(bus, agents, {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
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

  it('uses the durable owner’s exact adapter instance for recovery', async () => {
    // One identity for the whole recovery. The instance ID is derived from
    // `(machineId, adapterName)` and the reservation is filed under `machineId`,
    // so resolving the instance for this runtime's own machine while reserving
    // for the caller's would build a key no other actor computes.
    const agent = await seedDeadAgent('dead-scoped', 'claude-code', { adapterId: 'live-claude-code' });
    const lookups: Array<{ adapterName: string; machineId?: string }> = [];
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        lookups.push({ adapterName: ctx.payload.adapterName, machineId: ctx.payload.machineId });
        ctx.setResult({ adapterId: `live-${ctx.payload.adapterName}` });
      }),
      bus.on(AdapterRuntimeSubjects.resolveLiveIdentity, (ctx) => {
        ctx.setResult({ ...ctx.payload, ownerInstanceId: service.requireOwnershipInstanceId() });
      }),
    );
    const rehydrateTargets: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.adapterId);
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
    );

    const { usable, deferredAgentIds } = await verifyAndRecoverAgents(bus, [agent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
    });

    expect(lookups).toEqual([]);
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
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
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
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
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

  it('defers without dispatch when the caller cannot name the connector machine', async () => {
    // A keyless reservation may designate under an internal sentinel, but a
    // recovery creates a connector and must persist its exact runtime owner.
    // Without a machine there is no target pair to dispatch or persist.
    const agent = await seedDeadAgent('dead-unresolvable', 'claude-code');
    const rehydrateTargets: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.adapterId);
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
    );

    const result = await verifyAndRecoverAgents(bus, [agent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN });

    expect(result.deferredAgentIds).toEqual(new Set(['dead-unresolvable']));
    expect(rehydrateTargets).toEqual([]);
  });

  it('re-proves an opaque adapter separately from its owner incarnation after one stale native-resume plan', async () => {
    const agentId = 'dead-opaque-owner-replan';
    const originalProviderSessionId = 'provider-opaque-owner-original';
    const movedProviderSessionId = 'provider-opaque-owner-moved';
    const derivedForeignAdapterId = buildDeterministicAdapterId(FOREIGN_MACHINE_ID, 'claude-code');
    const opaqueOwnerAgent = await seedDeadAgent(agentId, 'claude-code', {
      adapterId: OPAQUE_FOREIGN_ADAPTER_ID,
      adapterSessionId: originalProviderSessionId,
      // The liveness probe, rather than a stale status marker, determines this
      // connector is gone. This preserves the row's normal idle recovery state
      // across the forced stale-plan retry.
      status: 'idle',
      runtimeOwner: { machineId: FOREIGN_MACHINE_ID, instanceId: OPAQUE_FOREIGN_OWNER_INSTANCE_ID },
    });
    const foreignAuthority = registerSessionOwnershipAuthority({
      bus,
      machineId: FOREIGN_MACHINE_ID,
      topology: 'shared-machine',
      instanceId: OPAQUE_FOREIGN_OWNER_INSTANCE_ID,
    });
    cleanups.push(...foreignAuthority.cleanups);

    const { registry, cleanup } = registerAdapterRuntimeIdentityHandlers(bus, { currentMachineId: MACHINE_ID });
    cleanups.push(cleanup);
    registry.rememberLiveIdentity({
      adapterId: OPAQUE_FOREIGN_ADAPTER_ID,
      adapterName: 'claude-code',
      machineId: FOREIGN_MACHINE_ID,
      ownerInstanceId: OPAQUE_FOREIGN_OWNER_INSTANCE_ID,
    });

    const liveProofs: Array<{ adapterId: string; adapterName: string; machineId: string }> = [];
    const derivedResolutions: Array<{ adapterName: string; machineId?: string }> = [];
    cleanups.push(
      bus.on(
        AdapterRuntimeSubjects.resolveLiveIdentity,
        async (ctx) => {
          liveProofs.push(ctx.payload);
          await ctx.next();
        },
        { priority: 100 },
      ),
      bus.on(
        AdapterRuntimeSubjects.resolveId,
        async (ctx) => {
          derivedResolutions.push(ctx.payload);
          await ctx.next();
        },
        { priority: 100 },
      ),
    );

    let stalePlanInjected = false;
    cleanups.push(
      bus.on(
        SessionSubjects.ownership.reserveStart,
        async (ctx) => {
          if (!stalePlanInjected && ctx.payload.recoveryGuard !== undefined) {
            stalePlanInjected = true;
            const moved = await bus.request(SessionOwnershipStorageSubjects.settleMovement, {
              machineId: FOREIGN_MACHINE_ID,
              adapterId: OPAQUE_FOREIGN_ADAPTER_ID,
              adapterName: 'claude-code',
              ownerInstance: { instanceId: 'opaque-owner-currency-mover' },
              sessionId: SESSION_ID,
              agentId,
              expectedRevision: 0,
              movement: {
                kind: 'confirmed',
                providerSessionId: movedProviderSessionId,
                claimToken: crypto.randomUUID(),
              },
            });
            if (moved.outcome !== 'settled' || moved.claim === null) {
              throw new Error(`failed to move the opaque-owner recovery currency: ${moved.outcome}`);
            }
            await bus.request(SessionOwnershipStorageSubjects.release, {
              agentId,
              claimToken: moved.claim.claimToken,
              disposition: 'released',
            });
          }
          await ctx.next();
        },
        { priority: 1000 },
      ),
    );
    const dispatched: Array<{ adapterId: string; resumeAdapterSessionId?: string }> = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        dispatched.push({
          adapterId: ctx.payload.adapterId,
          resumeAdapterSessionId: ctx.payload.resumeAdapterSessionId,
        });
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
    );

    const result = await verifyAndRecoverAgents(bus, [opaqueOwnerAgent], {
      plan: { kind: 'native-resume', resumeAdapterSessionId: originalProviderSessionId },
      machineId: FOREIGN_MACHINE_ID,
    });

    const expectedProof = {
      adapterId: OPAQUE_FOREIGN_ADAPTER_ID,
      adapterName: 'claude-code',
      machineId: FOREIGN_MACHINE_ID,
    };
    expect(stalePlanInjected).toBe(true);
    expect(liveProofs).toEqual([expectedProof, expectedProof]);
    expect(derivedResolutions).toEqual([]);
    expect(derivedForeignAdapterId).not.toBe(OPAQUE_FOREIGN_ADAPTER_ID);
    expect(OPAQUE_FOREIGN_OWNER_INSTANCE_ID).not.toBe(OPAQUE_FOREIGN_ADAPTER_ID);
    expect(dispatched).toEqual([
      { adapterId: OPAQUE_FOREIGN_ADAPTER_ID, resumeAdapterSessionId: movedProviderSessionId },
    ]);
    expect(result.recoveredAgentIds).toEqual(new Set([agentId]));
    expect(result.deferredAgentIds).toEqual(new Set());
  });
});
