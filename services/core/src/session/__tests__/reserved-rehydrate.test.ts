// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 520 }] */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionOwnershipStorageSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStartError } from '../handlers/session-start-error.js';
import {
  ADAPTER_ID,
  createReservedRehydrateContext,
  MACHINE_ID,
  FIRST,
  type ReservedRehydrateContext,
} from './reserved-rehydrate-fixture.js';

/**
 * Path B — the reserved rehydrate, driven through a real consumer.
 *
 * The composition every case runs against — the real backends, the real
 * authority and the adapter stand-in — lives in the fixture beside this file.
 * What follows is only what each case does and what it asserts.
 */
describe('reserved rehydrate', () => {
  let ctx: ReservedRehydrateContext;
  let bus: ReservedRehydrateContext['bus'];
  let dispatched: ReservedRehydrateContext['dispatched'];
  let stopped: ReservedRehydrateContext['stopped'];

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
    ({ bus, dispatched, stopped } = ctx);
  });

  afterEach(() => {
    ctx.destroy();
  });

  /**
   * Recover one agent natively, resuming its own provider session.
   * @param agent - Agent to recover.
   * @returns What the recovery answered.
   */
  function recoverNatively(agent: MakaioSessionAgent) {
    return ctx.recover(agent, { kind: 'native-resume', resumeAdapterSessionId: agent.adapterSessionId as string });
  }

  it('does not dispatch when close wins before the recovery reservation', async () => {
    const agent = await ctx.seedAgent(
      'session-close-before-rehydrate-reservation',
      'agent-close-before-rehydrate-reservation',
    );
    ctx.track(
      bus.on(
        SessionSubjects.ownership.reserveStart,
        async (context) => {
          await bus.request(SessionSubjects.close, { sessionId: agent.sessionId });
          await context.next();
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'session-not-active', sessionStatus: 'closed' });

    expect(dispatched).toEqual([]);
    expect(stopped).toEqual([]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    expect(await ctx.listClaims()).toEqual([]);
  });

  it('defers without dispatching anything when the key is occupied (case 70)', async () => {
    const agent = await ctx.seedAgent('session-occupied', 'agent-occupied');
    const foreign = await ctx.occupyKey(agent.adapterSessionId as string);
    ctx.registerAdapter();

    const outcome = await recoverNatively(agent);

    expect(outcome).toEqual({ kind: 'deferred', reason: 'occupied' });
    // `occupied` is terminal for this agent in this attempt: no second
    // connector, and no keyless retry that would have no gate at all.
    expect(dispatched).toEqual([]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    const claims = await ctx.listClaims();
    expect(claims).toEqual([foreign]);
  });

  it('puts a live agent back where the claim found it when the adapter refuses undispatched', async () => {
    // The warm-path claim denial: the adapter declines *before* it swaps
    // anything, so the connector this row describes is still the live one. The
    // shared cleanup's terminal `dead` belongs to an attempt that may have
    // reached the provider — writing it here poisons a healthy runtime, and the
    // next send either recovers it needlessly or opens a second one beside it.
    const agent = await ctx.seedAgent('session-warm-refused', 'agent-warm-refused', { status: 'active' });
    ctx.registerAdapter(() => ({
      success: false,
      message: 'already claimed by another in-flight rehydrate',
      dispatch: 'not-dispatched',
    }));

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'start-failed' });

    expect(await ctx.readStatus(agent.agentId)).toBe('active');
    // Still a clean give-back of the key: nothing reached the provider.
    expect((await ctx.listClaims()).some((claim) => claim.status === 'held')).toBe(false);
    expect(stopped).toEqual([]);
  });

  it('reads the prior status from the claim, not from the row the claim already moved', async () => {
    // The claim carries the status it replaced, and every exit reads it from
    // there. A rollback that re-derived it from the stored row would restore
    // `dead` — the claim moved the row to `starting`, and `dead` is that status's
    // rollback target — putting an unrecoverable status on an agent that was
    // `idle`. Both backends materialise their reads now, so this case pins the
    // design rather than one backend's aliasing.
    const agent = await ctx.seedAgent('session-aliased', 'agent-aliased', { status: 'idle' });
    await ctx.occupyKey(agent.adapterSessionId as string);
    ctx.registerAdapter();

    const outcome = await recoverNatively(agent);

    expect(outcome).toEqual({ kind: 'deferred', reason: 'occupied' });
    expect(await ctx.readStatus(agent.agentId)).toBe('idle');
  });

  it('puts a live agent back where the claim found it when the reservation refuses', async () => {
    // The liveness helper claims a row that still reads `idle` because the
    // *connector* is gone, and the restart handler claims live agents by design.
    // Writing `dead` on the way out would tell every later consumer that a
    // running agent is recoverable, and nothing would correct it — the per-turn
    // activity stamp only moves a row between `idle` and `active`.
    const agent = await ctx.seedAgent('session-live-refused', 'agent-live-refused', { status: 'idle' });
    await ctx.occupyKey(agent.adapterSessionId as string);
    ctx.registerAdapter();

    const outcome = await recoverNatively(agent);

    expect(outcome).toEqual({ kind: 'deferred', reason: 'occupied' });
    expect(dispatched).toEqual([]);
    expect(await ctx.readStatus(agent.agentId)).toBe('idle');
  });

  it('stops the replacement connector when the rehydrate throws after swapping it', async () => {
    const agent = await ctx.seedAgent('session-throwing-swap', 'agent-throwing-swap');
    // The warm path swaps the connector and *then* reads the refreshed identity
    // and writes its own runtime row. A throw from either leaves the replacement
    // live, and unlike a thrown `startAgent` there is no adapter-side rollback:
    // `swapConnector` has no predecessor to restore. Abandoning the generation
    // without stopping the connector is the orphan I23b forbids.
    ctx.registerAdapter(() => {
      throw new Error('runtime write failed after the connector was swapped');
    });

    await expect(recoverNatively(agent)).rejects.toThrow('after the connector was swapped');

    expect(stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    const claims = await ctx.listClaims();
    // Retired, not freed: a throw carries no disposition, so the provider may
    // still hold a live session behind the key.
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);
  });

  it('loses the recovery to a peer that claimed the row first (case 71)', async () => {
    const agent = await ctx.seedAgent('session-lost', 'agent-lost');
    // What a peer's claim looks like from here: the row is already `starting`,
    // which the compare-and-swap deliberately excludes from its expectation.
    await bus.request(AgentStorageSubjects.updateStatus, { agentId: agent.agentId, status: 'starting' });
    ctx.registerAdapter();

    await expect(recoverNatively(agent)).rejects.toThrow(SessionStartError);

    expect(dispatched).toEqual([]);
    expect(await ctx.listClaims()).toEqual([]);
    expect(await ctx.readStatus(agent.agentId)).toBe('starting');
  });

  it('releases the reservation token-scoped when the adapter refuses undispatched (cases 73, 99)', async () => {
    const agent = await ctx.seedAgent('session-refused', 'agent-refused');
    // A second, unrelated generation of the same agent: a fan-out release would
    // destroy it, a token-scoped one leaves it exactly as it is.
    const unrelated = await bus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: ADAPTER_ID,
      adapterName: 'test-adapter',
      providerSessionId: 'provider-unrelated',
      sessionId: 'session-refused',
      agentId: agent.agentId,
      claimToken: crypto.randomUUID(),
      ownerInstance: { instanceId: 'reserved-rehydrate-unrelated-owner' },
    });
    expect(unrelated.outcome).toBe('claimed');
    ctx.registerAdapter(() => ({ success: false, message: 'already claimed in flight', dispatch: 'not-dispatched' }));

    // A refusal leaves no connector, so this consumer reports it rather than
    // continuing with an agent that cannot answer.
    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'start-failed' });
    expect(dispatched).toHaveLength(1);
    // `released`, not `abandoned`: the adapter said nothing reached the
    // provider, so the key is given back cleanly.
    const claims = await ctx.listClaims();
    expect(claims.map((claim) => claim.providerSessionId)).toEqual(['provider-unrelated']);
    expect(claims[0]?.status).toBe('held');
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    expect(stopped).toEqual([]);
  });

  it('settles the currency on the key the connector confirmed, not the one requested (case 74)', async () => {
    const agent = await ctx.seedAgent('session-moved', 'agent-moved');
    const requested = agent.adapterSessionId as string;
    ctx.registerAdapter(() => ({ success: true, adapterSessionId: 'provider-moved-to' }));

    const outcome = await recoverNatively(agent);

    expect(outcome.kind).toBe('recovered');
    const claims = await ctx.listClaims();
    // One generation, on the confirmed key: settling on the requested one would
    // write back an identity the provider has already moved off.
    expect(claims).toHaveLength(1);
    expect(claims[0]?.providerSessionId).toBe('provider-moved-to');
    expect(claims.some((claim) => claim.providerSessionId === requested)).toBe(false);
    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId: agent.agentId });
    expect(ownership?.currency.currentAdapterSessionId).toBe('provider-moved-to');
  });

  it('does not let a stale whole-record write resurrect the attempt fence after finalization', async () => {
    const agent = await ctx.seedAgent('session-finalized-fence', 'agent-finalized-fence');
    ctx.registerAdapter();

    await recoverNatively(agent);
    const finalized = await bus.request(AgentStorageSubjects.get, { agentId: agent.agentId });
    expect(finalized.agent?.recoveryAttemptId).toBeUndefined();
    if (finalized.agent === null) throw new Error('expected finalized agent');

    await bus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent: { ...finalized.agent, recoveryAttemptId: 'stale-recovery-attempt' },
    });

    expect(
      (await bus.request(AgentStorageSubjects.get, { agentId: agent.agentId })).agent?.recoveryAttemptId,
    ).toBeUndefined();
  });

  it.each([
    {
      // `updateRuntime` is a hard request whose response is checked, so a
      // refusal is a post-dispatch failure rather than a warning.
      label: 'the recovery acknowledgement is refused',
      inject: () =>
        bus.on(
          SessionOwnershipStorageSubjects.finalizeRecovery,
          (ctx) => {
            if (ctx.payload.action.kind === 'succeeded') ctx.setResult({ applied: false });
            else return ctx.next();
          },
          FIRST,
        ),
    },
    {
      label: 'the recovery acknowledgement throws',
      inject: () =>
        bus.on(
          SessionOwnershipStorageSubjects.finalizeRecovery,
          (ctx) => {
            if (ctx.payload.action.kind === 'succeeded') throw new Error('recovery acknowledgement transport failed');
            return ctx.next();
          },
          FIRST,
        ),
    },
    {
      label: 'the settlement throws',
      inject: () =>
        bus.on(
          SessionOwnershipStorageSubjects.settleMovement,
          () => {
            throw new Error('settlement transport failed');
          },
          FIRST,
        ),
    },
    {
      label: 'the recovery commit throws',
      inject: () =>
        bus.on(
          SessionOwnershipStorageSubjects.finalizeRecovery,
          (ctx) => {
            if (ctx.payload.action.kind === 'succeeded') throw new Error('commit transport failed');
            return ctx.next();
          },
          FIRST,
        ),
    },
  ])('stops the connector and reports settlement-unresolved when $label (case 97)', async ({ inject }) => {
    const agent = await ctx.seedAgent('session-post-dispatch', 'agent-post-dispatch');
    // Registered before the memory backend so it answers first.
    ctx.track(inject());
    ctx.registerAdapter();

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    expect(stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    const claims = await ctx.listClaims();
    // Retired, not freed: nothing here proved the provider session is closed.
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);
  });

  it('does not let a status-only peer overwrite a guarded recovery attempt (case 98a)', async () => {
    const agent = await ctx.seedAgent('session-peer-dead', 'agent-peer-dead');
    ctx.registerAdapter(async (agentId) => {
      // A peer applying the in-flight consumer rule claims this recovery while
      // the connector is coming back. It says nothing about ownership.
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'dead', expectedStatus: ['starting'] });
      return { success: true };
    });

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    expect(stopped).toEqual([agent.agentId]);
  });

  it('refuses Ack when a peer wrote idle before this generation could commit (case 98b)', async () => {
    const agent = await ctx.seedAgent('session-peer-idle', 'agent-peer-idle');
    ctx.registerAdapter(async (agentId) => {
      // What an *unreserved* attempt joining the same agent writes.
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
      return { success: true };
    });

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    // The adapter cannot attribute an existing `idle` write to this token, so it
    // refuses instead of converting an ambiguous row into settlement evidence.
    // The only idle write was the peer's. This attempt does not overwrite a
    // status slot it cannot attribute to itself.
    expect(await ctx.readStatus(agent.agentId)).toBe('idle');
    expect(stopped).toEqual([agent.agentId]);
    expect((await ctx.listClaims()).every((claim) => claim.status === 'abandoned')).toBe(true);
  });

  it('detects a removal that landed after the settlement and answers lost (cases 72, 98c)', async () => {
    const agent = await ctx.seedAgent('session-removed', 'agent-removed');
    // Real removal after keyed settlement: it disposes the row and releases the
    // claims, stripping the live connector of its ownership anchor (I23b).
    ctx.track(
      bus.on(
        SessionOwnershipStorageSubjects.settleMovement,
        async (ctx) => {
          await ctx.next();
          await bus.emit(SessionSubjects.agent.removed, { sessionId: agent.sessionId, agentId: agent.agentId });
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();
    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'agent-unavailable' });
    // One connector teardown, then one idempotent exact-owner confirmation.
    expect(stopped).toEqual([agent.agentId, agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('disposed');
    expect((await ctx.listClaims()).some((claim) => claim.status === 'held')).toBe(false);
  });

  it('answers lost when the row is gone by the time the commit runs (case 98c, deleted)', async () => {
    const agent = await ctx.seedAgent('session-deleted', 'agent-deleted');
    // Deleted *after* the settlement, for the same reason the arm above disposes
    // there: every earlier round trip touches the row and would fail first, so
    // the commit is the only checkpoint that can observe this. A gone row makes
    // the compare-and-swap answer `success: false`, which needs no second read
    // to classify.
    ctx.track(
      bus.on(
        SessionOwnershipStorageSubjects.settleMovement,
        async (ctx) => {
          await ctx.next();
          await bus.request(AgentStorageSubjects.delete, { agentId: agent.agentId });
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'agent-unavailable' });

    expect(stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBeUndefined();
  });

  it('cleans a modeled settlement refusal exactly once and keeps its own code (case 103)', async () => {
    const agent = await ctx.seedAgent('session-refused-settle', 'agent-refused-settle');
    // The connector lands on a key a foreign generation already holds, so the
    // settlement is refused on ownership grounds rather than failing.
    await ctx.occupyKey('provider-taken');
    const finalizations: string[] = [];
    ctx.track(
      bus.on(
        SessionOwnershipStorageSubjects.finalizeRecovery,
        (ctx) => {
          finalizations.push(`${ctx.payload.agentId}:${ctx.payload.action.kind}`);
          return ctx.next();
        },
        FIRST,
      ),
    );
    ctx.registerAdapter(() => ({ success: true, adapterSessionId: 'provider-taken' }));

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'ownership-refused' });

    // One teardown, not two: the outcome table cleans and throws for itself, so
    // it runs outside every guard.
    expect(stopped).toEqual([agent.agentId]);
    expect(finalizations.filter((action) => action === `${agent.agentId}:failed`)).toHaveLength(1);
    expect((await ctx.listClaims()).some((claim) => claim.agentId === agent.agentId && claim.status === 'held')).toBe(
      false,
    );
  });

  it('releases its own settlement candidate when the settle response is lost (case 112)', async () => {
    const agent = await ctx.seedAgent('session-lost-response', 'agent-lost-response');
    // The transaction commits and the answer never arrives — a dropped packet,
    // a timeout, a crash between commit and return. The attempt holds the
    // reservation token and the candidate it minted, and nothing else.
    ctx.track(
      bus.on(
        SessionOwnershipStorageSubjects.settleMovement,
        async (ctx) => {
          await ctx.next();
          throw new Error('settlement response was lost after it committed');
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    const claims = await ctx.listClaims();
    // The successor the settlement created is named and given back, rather than
    // blocking its key indefinitely behind a live-looking agent row.
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);

    // The key stays blocked, and that is the point of `abandoned` rather than a
    // defect: the settlement's extent is unknown, so a provider session that
    // may still be live must not be handed to a second connector (I15). What
    // the release buys is that the generation is *named* — reconcile sees an
    // abandoned row instead of a `held` one no process can account for.
    const reserved = await bus.request(SessionSubjects.ownership.reserveStart, {
      sessionId: agent.sessionId,
      agentId: agent.agentId,
      adapterId: ADAPTER_ID,
      adapterName: agent.adapterName,
      machineId: MACHINE_ID,
      ownerInstanceId: ctx.ownerInstanceId,
      role: 'member',
      resumeProviderSessionId: agent.adapterSessionId as string,
      claimToken: crypto.randomUUID(),
    });
    expect(reserved.outcome).toBe('occupied');
  });

  it('retires the exact recovery and stops its connector when close wins after dispatch', async () => {
    const agent = await ctx.seedAgent('session-close-during-rehydrate', 'agent-close-during-rehydrate');
    ctx.track(
      bus.on(
        SessionOwnershipStorageSubjects.settleMovement,
        async (context) => {
          await context.next();
          await bus.request(SessionSubjects.close, { sessionId: agent.sessionId });
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'session-not-active', sessionStatus: 'closed' });

    expect(dispatched).toHaveLength(1);
    expect(stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    const claims = await ctx.listClaims();
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.agentId !== agent.agentId || claim.status === 'abandoned')).toBe(true);
  });
});
