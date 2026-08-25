import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterSubjects, type CallerSettlementAckRefusal, type MakaioSessionAgent } from '@makaio/contracts';
import { createReservedRehydrateContext, FIRST, type ReservedRehydrateContext } from './reserved-rehydrate-fixture.js';

/** Caller-owned settlement acknowledgement through the real ownership consumer. */
describe('caller-owned settlement acknowledgement', () => {
  let ctx: ReservedRehydrateContext;
  let agent: MakaioSessionAgent;

  beforeEach(async () => {
    ctx = await createReservedRehydrateContext();
    agent = await ctx.seedAgent('session-ack-refused', 'agent-ack-refused');
  });

  afterEach(() => {
    ctx.destroy();
  });

  it.each<CallerSettlementAckRefusal>([
    'not-hosted',
    'stale-token',
  ])('retires only its named generations and never commits idle when Ack returns %s', async (reason) => {
    ctx.track(
      ctx.bus.on(
        AdapterSubjects.acknowledgeCallerSettlement,
        (request) => {
          request.setResult({ acknowledged: false, reason });
        },
        FIRST,
      ),
    );
    ctx.registerAdapter();

    await expect(
      ctx.recover(agent, { kind: 'native-resume', resumeAdapterSessionId: agent.adapterSessionId as string }),
    ).rejects.toMatchObject({ code: 'settlement-unresolved' });

    expect(await ctx.readStatus(agent.agentId)).toBe('dead');
    expect(ctx.stopped).toEqual([agent.agentId]);
    const claims = await ctx.listClaims();
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.agentId === agent.agentId && claim.status === 'abandoned')).toBe(true);
  });
});
