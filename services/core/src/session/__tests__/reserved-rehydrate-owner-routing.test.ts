import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { runExclusiveStart } from '../ownership/index.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import {
  ADAPTER_ID,
  createReservedRehydrateContext,
  FIRST,
  MACHINE_ID,
  type ReservedRehydrateContext,
} from './reserved-rehydrate-fixture.js';

describe('reserved rehydrate owner routing', () => {
  let ctx: ReservedRehydrateContext;

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
  });

  afterEach(() => ctx.destroy());

  it('rejects a response from an owner other than the authority reservation', async () => {
    const agent = await ctx.seedAgent('session-owner-mismatch', 'agent-owner-mismatch');
    ctx.registerAdapter(() => ({ success: true, ownerInstanceId: 'foreign-owner' }));

    await expect(
      ctx.recover(agent, { kind: 'native-resume', resumeAdapterSessionId: agent.adapterSessionId as string }),
    ).rejects.toMatchObject({ code: 'settlement-unresolved' });

    expect(ctx.dispatched).toHaveLength(1);
    expect(ctx.dispatched[0]?.ownerInstanceId).toEqual(expect.any(String));
    expect(ctx.dispatched[0]?.ownerInstanceId).not.toBe('foreign-owner');
    expect(ctx.stopped).toEqual([agent.agentId]);
  });

  it('replans on the configured target machine after a stale recovery plan', async () => {
    const agent = await ctx.seedAgent('session-replan-machine', 'agent-replan-machine');
    const movedProviderSessionId = 'provider-replan-machine';
    const resolvedMachines: Array<string | undefined> = [];
    let injectMovement = true;
    ctx.track(
      ctx.bus.on(
        AdapterRuntimeSubjects.resolveId,
        (context) => {
          resolvedMachines.push(context.payload.machineId);
          context.setResult({ adapterId: ADAPTER_ID });
        },
        FIRST,
      ),
    );
    ctx.track(
      ctx.bus.on(
        AdapterRuntimeSubjects.resolveLiveIdentity,
        (context) => {
          context.setResult({
            adapterId: ADAPTER_ID,
            adapterName: context.payload.adapterName,
            machineId: MACHINE_ID,
            ownerInstanceId: ctx.ownerInstanceId,
          });
        },
        FIRST,
      ),
    );
    ctx.track(
      ctx.bus.on(
        SessionSubjects.ownership.reserveStart,
        async (context) => {
          if (injectMovement && context.payload.recoveryGuard !== undefined) {
            injectMovement = false;
            const settled = await ctx.bus.request(SessionOwnershipStorageSubjects.settleMovement, {
              machineId: MACHINE_ID,
              adapterId: ADAPTER_ID,
              adapterName: agent.adapterName,
              ownerInstance: { instanceId: 'replan-machine-mover' },
              sessionId: agent.sessionId,
              agentId: agent.agentId,
              expectedRevision: context.payload.recoveryGuard.expectedRevision,
              movement: {
                kind: 'confirmed',
                providerSessionId: movedProviderSessionId,
                claimToken: crypto.randomUUID(),
              },
            });
            if (settled.outcome !== 'settled' || settled.claim === null) {
              throw new Error(`failed to move recovery currency: ${settled.outcome}`);
            }
            await ctx.bus.request(SessionOwnershipStorageSubjects.release, {
              agentId: agent.agentId,
              claimToken: settled.claim.claimToken,
              disposition: 'released',
            });
          }
          return context.next();
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    const outcome = await ctx.recover(agent, {
      kind: 'native-resume',
      resumeAdapterSessionId: agent.adapterSessionId as string,
    });

    expect(outcome.kind).toBe('recovered');
    expect(resolvedMachines).toEqual([MACHINE_ID, MACHINE_ID]);
    expect(ctx.dispatched).toEqual([
      expect.objectContaining({ adapterId: ADAPTER_ID, resumeAdapterSessionId: movedProviderSessionId }),
    ]);
  });

  it("replans its self-reentry from the joined attempt's row, binding, holder, and live owner", async () => {
    const agent = await ctx.seedAgent('session-joined-replan', 'agent-joined-replan');
    const replacementAdapterId = 'adapter-after-join';
    const replacementOwnerInstanceId = ctx.ownerInstanceId;
    const foreignOwnerInstanceId = 'foreign-holder-after-join';
    const foreign = await ctx.seedAgent('session-joined-foreign', 'agent-joined-foreign');
    const holder = await ctx.bus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: replacementAdapterId,
      adapterName: agent.adapterName,
      providerSessionId: agent.adapterSessionId as string,
      sessionId: foreign.sessionId,
      agentId: foreign.agentId,
      claimToken: crypto.randomUUID(),
      ownerInstance: { instanceId: foreignOwnerInstanceId },
    });
    if (holder.outcome !== 'claimed' || holder.claim === null) throw new Error('expected the replacement holder');

    let releaseJoinedAttempt: (() => void) | undefined;
    const joinedAttemptReleased = new Promise<void>((resolve) => {
      releaseJoinedAttempt = resolve;
    });
    let joinedAttemptChangedRow: (() => void) | undefined;
    const joinedAttemptReady = new Promise<void>((resolve) => {
      joinedAttemptChangedRow = resolve;
    });
    runExclusiveStart(agent.agentId, async () => {
      await ctx.bus.request(AgentStorageSubjects.updateRuntime, {
        agentId: agent.agentId,
        adapterId: replacementAdapterId,
        runtimeOwner: { machineId: MACHINE_ID, instanceId: 'persisted-owner-after-join' },
      });
      await ctx.bus.request(AgentStorageSubjects.updateStatus, { agentId: agent.agentId, status: 'starting' });
      await ctx.bus.request(AgentStorageSubjects.updateStatus, { agentId: agent.agentId, status: 'dead' });
      joinedAttemptChangedRow?.();
      await joinedAttemptReleased;
      return 'no-connector';
    });

    const resolvedAdapterIds: string[] = [];
    ctx.track(
      ctx.bus.on(
        AdapterRuntimeSubjects.resolveLiveIdentity,
        (context) => {
          resolvedAdapterIds.push(context.payload.adapterId);
          context.setResult({
            adapterId: context.payload.adapterId,
            adapterName: context.payload.adapterName,
            machineId: context.payload.machineId,
            ownerInstanceId: replacementOwnerInstanceId,
          });
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    const recovery = ctx.recover(agent, {
      kind: 'native-resume',
      resumeAdapterSessionId: agent.adapterSessionId as string,
    });
    await joinedAttemptReady;
    releaseJoinedAttempt?.();

    await expect(recovery).resolves.toEqual({ kind: 'deferred', reason: 'occupied' });
    expect(ctx.dispatched).toEqual([]);
    expect(resolvedAdapterIds).toEqual([replacementAdapterId]);
    // An occupied answer is possible only when the re-entry's guard names the
    // foreign generation now holding the replacement binding. A stale guard
    // would either reserve the old key or report a recovery conflict instead.
    expect(holder.claim.ownerInstanceId).toBe(foreignOwnerInstanceId);
  });
});
