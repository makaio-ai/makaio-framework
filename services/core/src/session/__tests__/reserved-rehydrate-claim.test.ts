/**
 * Path B — the claim that opens a reserved rehydrate.
 *
 * The row claim is a compare-and-swap, and what it requires is the status the
 * rollback would restore: the two are one statement about the identity this
 * attempt observed. A caller whose observation a peer has overtaken loses the
 * claim rather than writing a status it never saw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { createReservedRehydrateContext, type ReservedRehydrateContext } from './reserved-rehydrate-fixture.js';

describe('reserved rehydrate claim', () => {
  let ctx: ReservedRehydrateContext;
  let dispatched: ReservedRehydrateContext['dispatched'];

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
    ({ dispatched } = ctx);
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

  it('plans from the canonical row rather than a stale caller snapshot', async () => {
    // G9 rebuilds recovery input from storage before reserving, so a stale
    // caller object cannot supply the claim expectation or rollback status. A
    // later movement is fenced atomically by the recovery guard.
    const stored = await ctx.seedAgent('session-overtaken', 'agent-overtaken', { status: 'active' });
    // What the caller holds: an observation the peer has already overtaken.
    const stale: MakaioSessionAgent = { ...stored, status: 'dead' };
    await ctx.occupyKey(stored.adapterSessionId as string);
    ctx.registerAdapter();

    await expect(recoverNatively(stale)).resolves.toEqual({ kind: 'deferred', reason: 'occupied' });

    // Nothing was claimed and nothing was written: the row is exactly what the
    // peer left, not the `dead` the caller's snapshot would have restored.
    expect(await ctx.readStatus(stored.agentId)).toBe('active');
    expect(dispatched).toEqual([]);
  });
});
