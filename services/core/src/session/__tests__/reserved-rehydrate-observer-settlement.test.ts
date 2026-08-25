/**
 * Observer-first settlement cases for the reserved-rehydrate path.
 *
 * Both cases run through the same real memory backends, authority, and recovery
 * consumer as the main suite. They vary only in whether the consumer learns the
 * generation that the movement observer created before its own settlement fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionOwnershipStorageSubjects, SessionSubjects, type AdapterSessionClaimRecord } from '@makaio/contracts';
import {
  FIRST,
  ADAPTER_ID,
  MACHINE_ID,
  MOVED_KEY,
  createReservedRehydrateContext,
  type ReservedRehydrateContext,
} from './reserved-rehydrate-fixture.js';

describe('reserved rehydrate observer-first settlement', () => {
  let ctx: ReservedRehydrateContext;

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
  });

  afterEach(() => ctx.destroy());

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
      await ctx.bus.request(SessionSubjects.ownership.settleMovement, {
        sessionId: agent.sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: agent.adapterName,
        machineId: MACHINE_ID,
        ownerInstanceId: ctx.ownerInstanceId,
        movement: { confirmed: true, providerSessionId: MOVED_KEY },
      });
      return { success: true, adapterSessionId: MOVED_KEY };
    });
    // The commit then fails, which is the failure that has to give the
    // observer's generation back.
    const finalizations: string[] = [];
    ctx.track(
      ctx.bus.on(
        SessionOwnershipStorageSubjects.finalizeRecovery,
        (context) => {
          if (context.payload.action.kind === 'succeeded') throw new Error('commit transport failed');
          finalizations.push(context.payload.action.kind);
          return context.next();
        },
        FIRST,
      ),
    );

    await expect(
      ctx.recover(agent, { kind: 'native-resume', resumeAdapterSessionId: agent.adapterSessionId as string }),
    ).rejects.toMatchObject({ code: 'settlement-unresolved' });

    const claims = await ctx.listClaims();
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);
    // One teardown, not two: the connector is stopped once and the row reaches
    // its terminal state through exactly one write.
    expect(ctx.stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    expect(finalizations.filter((action) => action === 'failed')).toHaveLength(1);
  });

  it('leaves an observer-first generation held when the settle response is lost (case 113b)', async () => {
    const agent = await ctx.seedAgent('session-observer-lost', 'agent-observer-lost');
    let observed: AdapterSessionClaimRecord | undefined;
    ctx.registerAdapter(async (agentId) => {
      await ctx.bus.request(SessionSubjects.ownership.settleMovement, {
        sessionId: agent.sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: agent.adapterName,
        machineId: MACHINE_ID,
        ownerInstanceId: ctx.ownerInstanceId,
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
      ctx.bus.on(
        SessionOwnershipStorageSubjects.settleMovement,
        async (context) => {
          settles += 1;
          await context.next();
          if (settles === 2) throw new Error('settlement response was lost after it committed');
        },
        FIRST,
      ),
    );

    await expect(
      ctx.recover(agent, { kind: 'native-resume', resumeAdapterSessionId: agent.adapterSessionId as string }),
    ).rejects.toMatchObject({ code: 'settlement-unresolved' });

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
    expect(ctx.stopped).toEqual([agent.agentId]);
    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
  });
});
