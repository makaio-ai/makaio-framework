// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 520 }] */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStartError } from '../handlers/session-start-error.js';
import {
  ADAPTER_ID,
  createReservedRehydrateContext,
  MACHINE_ID,
  FIRST,
  MOVED_KEY,
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
    // The stores hand out the row object itself and the transition mutates it in
    // place, so an `idle` agent's own `status` field reads `starting` the moment
    // the claim lands. A rollback that re-read it there would restore `dead` —
    // and would do so only against the backend that aliases, which is the worst
    // kind of correct-by-accident.
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

  it.each([
    {
      // `updateRuntime` is a hard request whose response is checked, so a
      // refusal is a post-dispatch failure rather than a warning.
      label: 'the runtime write is refused',
      inject: () =>
        bus.on(
          AgentStorageSubjects.updateRuntime,
          (ctx) => {
            ctx.setResult({ success: false });
          },
          FIRST,
        ),
    },
    {
      label: 'the runtime write throws',
      inject: () =>
        bus.on(
          AgentStorageSubjects.updateRuntime,
          () => {
            throw new Error('runtime write transport failed');
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
      label: 'the commit throws',
      inject: () =>
        bus.on(
          AgentStorageSubjects.updateStatus,
          (ctx) => {
            if (ctx.payload.status === 'idle') throw new Error('commit transport failed');
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

  it('keeps a healthy connector when a peer stomped the row to dead (case 98a)', async () => {
    const agent = await ctx.seedAgent('session-peer-dead', 'agent-peer-dead');
    ctx.registerAdapter(async (agentId) => {
      // A peer applying the in-flight consumer rule claims this recovery while
      // the connector is coming back. It says nothing about ownership.
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'dead', expectedStatus: ['starting'] });
      return { success: true };
    });

    const outcome = await recoverNatively(agent);

    expect(outcome.kind).toBe('recovered');
    // `dead` is in the commit's expectation precisely so the owner restores it.
    expect(await ctx.readStatus(agent.agentId)).toBe('idle');
    expect(stopped).toEqual([]);
    expect((await ctx.listClaims()).some((claim) => claim.status === 'held')).toBe(true);
  });

  it('accepts a peer that wrote idle first as a silent no-op (case 98b)', async () => {
    const agent = await ctx.seedAgent('session-peer-idle', 'agent-peer-idle');
    ctx.registerAdapter(async (agentId) => {
      // What an *unreserved* attempt joining the same agent writes.
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
      return { success: true };
    });

    const outcome = await recoverNatively(agent);

    expect(outcome.kind).toBe('recovered');
    expect(await ctx.readStatus(agent.agentId)).toBe('idle');
    expect(stopped).toEqual([]);
    expect((await ctx.listClaims()).some((claim) => claim.status === 'held')).toBe(true);
  });

  it('detects a removal that landed after the settlement and answers lost (cases 72, 98c)', async () => {
    const agent = await ctx.seedAgent('session-removed', 'agent-removed');
    // The real removal, on the real production path, in the one interval this
    // case is about: the keyed settlement has committed, so every earlier
    // checkpoint is behind it and the commit's own re-read is the only one left.
    // `registerAgentRemovedHandler` disposes the row and releases the agent's
    // claims — which is precisely the act that strips a live connector of its
    // ownership anchor (I23b).
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

    expect(stopped).toEqual([agent.agentId]);
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
    const statusWrites: string[] = [];
    ctx.track(
      bus.on(
        AgentStorageSubjects.updateStatus,
        (ctx) => {
          statusWrites.push(`${ctx.payload.agentId}:${ctx.payload.status}`);
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
    expect(statusWrites.filter((write) => write === `${agent.agentId}:dead`)).toHaveLength(1);
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
      role: 'member',
      resumeProviderSessionId: agent.adapterSessionId as string,
    });
    expect(reserved.outcome).toBe('occupied');
  });

  it('releases the generation an observer-first settlement reported (case 113a)', async () => {
    const agent = await ctx.seedAgent('session-observer-first', 'agent-observer-first');
    // The connector lands on a key the reservation did not name, and the
    // movement observer settles *that* key before the caller does. The
    // generation this creates is therefore one the attempt never reserved and
    // cannot name from anything it holds: only the settle response reports it,
    // which is why the attempt records it before it does anything else with the
    // result. Settling the reserved key instead would reuse the attempt's own
    // generation and the case would pass without ever exercising the rule.
    ctx.registerAdapter(async (agentId) => {
      await bus.request(SessionSubjects.ownership.settleMovement, {
        sessionId: agent.sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: agent.adapterName,
        movement: { confirmed: true, providerSessionId: MOVED_KEY },
      });
      return { success: true, adapterSessionId: MOVED_KEY };
    });
    // The commit then fails, which is the failure that has to give the
    // observer's generation back.
    const statusWrites: string[] = [];
    ctx.track(
      bus.on(
        AgentStorageSubjects.updateStatus,
        (ctx) => {
          if (ctx.payload.status === 'idle') throw new Error('commit transport failed');
          statusWrites.push(ctx.payload.status);
          return ctx.next();
        },
        FIRST,
      ),
    );

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    const claims = await ctx.listClaims();
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);
    // One teardown, not two: the connector is stopped once and the row reaches
    // its terminal state through exactly one write.
    expect(stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    expect(statusWrites.filter((status) => status === 'dead')).toHaveLength(1);
  });

  it('leaves an observer-first generation held when the settle response is lost (case 113b)', async () => {
    const agent = await ctx.seedAgent('session-observer-lost', 'agent-observer-lost');
    let observed: AdapterSessionClaimRecord | undefined;
    ctx.registerAdapter(async (agentId) => {
      await bus.request(SessionSubjects.ownership.settleMovement, {
        sessionId: agent.sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: agent.adapterName,
        movement: { confirmed: true, providerSessionId: MOVED_KEY },
      });
      observed = (await ctx.listClaims())[0];
      return { success: true, adapterSessionId: MOVED_KEY };
    });
    // The caller's own settle — the second one storage sees — commits and its
    // answer never arrives. The effective generation is only knowable *from*
    // that answer, so the attempt never learns the observer's token and its
    // releasable set stays exactly what it seeded: its reservation and its own
    // settlement candidate.
    let settles = 0;
    ctx.track(
      bus.on(
        SessionOwnershipStorageSubjects.settleMovement,
        async (ctx) => {
          settles += 1;
          await ctx.next();
          if (settles === 2) throw new Error('settlement response was lost after it committed');
        },
        FIRST,
      ),
    );

    await expect(recoverNatively(agent)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    // OQ-I's residual, pinned rather than glossed: the observer's generation
    // survives as `held`, and this case exists so a later change that closes the
    // window has a test to flip instead of a surprise to discover. What it also
    // pins is that nothing *falsely* touched it — the token is the one the
    // observer allocated, so no cleanup released it and no retry re-minted it.
    const claims = await ctx.listClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimToken).toBe(observed?.claimToken);
    expect(claims[0]?.status).toBe('held');
    // The row and the connector are still unwound, because the attempt itself
    // did fail: only the generation it could not name is left standing.
    expect(stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
  });
});
