/**
 * Path B — what a consumer that *joined* somebody else's rehydrate hands on.
 *
 * A joiner dispatched nothing and settled nothing, so everything it reports
 * comes from the row the attempt it joined left behind. The rule under test is
 * that the row it classified is the identity it hands on — whole, not one field
 * of it — because a rehydrate persists the instance it bound the agent to *and*
 * the cwd and model it was dispatched with, and its consumers act on all of
 * them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { runExclusiveStart } from '../ownership/in-flight-starts.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import {
  ADAPTER_ID,
  createReservedRehydrateContext,
  type ReservedRehydrateContext,
} from './reserved-rehydrate-fixture.js';
import { settleEventLoop } from './shared.js';

/** The instance the joined attempt binds its agent to — never the caller's. */
const REBOUND_ADAPTER_ID = 'rebound-adapter';

describe('a joined reserved rehydrate', () => {
  let ctx: ReservedRehydrateContext;
  let bus: ReservedRehydrateContext['bus'];

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
    ({ bus } = ctx);
  });

  afterEach(() => {
    ctx.destroy();
  });

  it('hands on the identity the attempt established, not the one it read before joining', async () => {
    const stored = await ctx.seedAgent('session-joined-refresh', 'agent-joined-refresh', {
      status: 'dead',
      cwd: '/before',
      model: 'model-before',
    });
    // Detached from the store on purpose. The memory backend hands out the row
    // object itself and mutates it in place, so a caller holding it would see
    // writes it never read and this case would pass without the refresh. A
    // backend that materialises rows per query — as the SQL ones do — gives the
    // caller a snapshot, which is what a send actually holds and the only shape
    // in which the defect is observable.
    const snapshot: MakaioSessionAgent = { ...stored };

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = runExclusiveStart(stored.agentId, async () => {
      await gate;
      // Exactly what a rehydrate persists before it commits its row: the
      // instance its connector lives on, and the cwd and model it ran with.
      await bus.request(AgentStorageSubjects.updateRuntime, {
        agentId: stored.agentId,
        adapterId: REBOUND_ADAPTER_ID,
        cwd: '/after',
        model: 'model-after',
      });
      await bus.request(AgentStorageSubjects.updateStatus, { agentId: stored.agentId, status: 'idle' });
      return 'connected';
    });

    const recovering = ctx.recover(snapshot, FRESH_WITH_HISTORY_RECOVERY_PLAN);
    await settleEventLoop();
    release();
    await attempt.settled;
    const outcome = await recovering;

    expect(outcome).toEqual({
      kind: 'recovered',
      agent: expect.objectContaining({
        agentId: stored.agentId,
        adapterId: REBOUND_ADAPTER_ID,
        cwd: '/after',
        model: 'model-after',
        status: 'idle',
      }),
    });
    // Never the instance this call resolved for a dispatch it did not make.
    expect(outcome).not.toEqual(expect.objectContaining({ agent: expect.objectContaining({ adapterId: ADAPTER_ID }) }));
    // And refreshed in the caller's own object, because that object is the
    // session's agent: the send that owns it keeps routing at it afterwards.
    expect(snapshot.cwd).toBe('/after');
  });
});
