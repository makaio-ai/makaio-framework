/**
 * Path B — the order its post-dispatch steps run in.
 *
 * The connector is live from the dispatch onward, and on a fresh rehydrate it is
 * live on a key the reservation never named. Everything here asserts the one
 * rule that follows: the settlement claims that key before anything that can
 * fail runs, so a failure has a real generation to give back rather than leaving
 * the key held by nobody.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import {
  createReservedRehydrateContext,
  FIRST,
  MOVED_KEY,
  type ReservedRehydrateContext,
} from './reserved-rehydrate-fixture.js';

describe('reserved rehydrate ordering', () => {
  let ctx: ReservedRehydrateContext;
  let bus: ReservedRehydrateContext['bus'];

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
    ({ bus } = ctx);
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

  it('claims the confirmed key before the runtime write that can fail on it', async () => {
    // The third seam under the same rule. The connector is live on the key it
    // confirmed, and the runtime write is a hard request whose refusal is a
    // failure — run in front of the settlement it was a window in which nothing
    // held that key, and its failure retired a reservation that never named it.
    const agent = await ctx.seedAgent('session-runtime-after-settle', 'agent-runtime-after-settle');
    let claimedAtRuntimeWrite: string[] = [];
    ctx.track(
      bus.on(
        AgentStorageSubjects.updateRuntime,
        async (context) => {
          claimedAtRuntimeWrite = (await ctx.listClaims())
            .filter((claim) => claim.status === 'held')
            .map((claim) => claim.providerSessionId);
          return context.next();
        },
        FIRST,
      ),
    );
    ctx.registerAdapter(() => ({ success: true, adapterSessionId: MOVED_KEY }));

    const outcome = await recoverNatively(agent);

    expect(outcome.kind).toBe('recovered');
    // The key the connector landed on was already held when the runtime write
    // ran, so a failure there would have had a real generation to give back.
    expect(claimedAtRuntimeWrite).toEqual([MOVED_KEY]);
  });
});
