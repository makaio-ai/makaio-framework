import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { callerOwnedSuccessFields } from '../testing/caller-owned-adapter-stub.js';
import { createTestAgent } from './shared.js';
import { SendDeferralPolicyHarness } from './send-deferral-policy.fixture.js';

type ReplacementFailure = 'dispatch-uncertain' | 'settlement' | 'completion' | 'admission';

describe('SessionOrchestrator send deferral convergence', () => {
  let harness: SendDeferralPolicyHarness;

  beforeEach(async () => {
    harness = await SendDeferralPolicyHarness.create();
  });

  afterEach(() => {
    harness.destroy();
  });

  it('refuses an all-target send after guarded and recovery deferrals arrive in separate waves', async () => {
    const sessionId = 'session-two-wave-total-deferral';
    const agents = await harness.seedSession(sessionId, ['agent-a', 'agent-b'], {
      agentOverrides: {
        'agent-a': { status: 'starting', recoveryAttemptId: 'guarded-attempt-a' },
      },
    });
    const agentB = agents[1];
    if (agentB === undefined) throw new Error('missing seeded agent-b');
    harness.occupyAgentKey(agentB);

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'all targets must converge',
      agentIds: 'all',
    }).catch((error: unknown) => error);

    expect(harness.probedAgentIds).toEqual(['agent-b']);
    expect(harness.dispatched).toEqual([]);
    expect(harness.routed).toEqual([]);
    expectDeferralFailure(failure, ['agent-a', 'agent-b']);
  });

  it('bounds repeated guarded designation winners instead of restarting forever', async () => {
    const sessionId = 'session-repeated-guarded-winners';
    const [lead] = await harness.seedSession(sessionId, ['agent-original']);
    if (lead === undefined) throw new Error('missing seeded lead');
    harness.occupyAgentKey(lead);
    let winnerCount = 0;
    harness.addCleanup(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        async (ctx) => {
          // eslint-disable-next-line custom/prefer-bus-filter -- replacement starts have generated ids; the original guarded lead must pass through
          if (ctx.payload.agentId === lead.agentId) return ctx.next();
          winnerCount += 1;
          const winnerId = `guarded-winner-${winnerCount}`;
          const winner = createTestAgent(winnerId, {
            sessionId,
            adapterId: 'stale-adapter',
            adapterSessionId: `provider-${winnerId}`,
            role: 'lead',
            status: 'starting',
            recoveryAttemptId: `guarded-attempt-${winnerCount}`,
            runtimeOwner: { machineId: 'foreign-machine', instanceId: `foreign-runtime-${winnerCount}` },
          });
          await MakaioBus.request(AgentStorageSubjects.set, { agentId: winnerId, agent: winner });
          await MakaioBus.emit(SessionSubjects.agent.added, {
            sessionId,
            agentId: winnerId,
            adapterId: winner.adapterId,
            adapterName: winner.adapterName,
            adapterSessionId: winner.adapterSessionId as string,
            role: 'lead',
          });
          ctx.setResult({ outcome: 'lead-conflict', currentLeadAgentId: winnerId });
        },
        { priority: 200 },
      ),
    );

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'the winner remains guarded',
    }).catch((error: unknown) => error);

    const error = findErrorWithCode(failure, 'start-unresolved');
    expect(error).toBeDefined();
    expect(error?.message).toContain('did not stabilize after 2 deferral convergence passes');
    expect(winnerCount).toBe(2);
    expect(harness.dispatched).toEqual([]);
    expect(harness.routed).toEqual([]);
  });

  it.each([
    'dispatch-uncertain',
    'settlement',
    'completion',
    'admission',
  ] as const)('restores the deferred foreign lead when replacement %s fails', async (failure: ReplacementFailure) => {
    const sessionId = `session-replacement-${failure}`;
    const [oldLead] = await harness.seedSession(sessionId, [`old-lead-${failure}`]);
    if (oldLead === undefined) throw new Error('missing seeded lead');
    harness.occupyAgentKey(oldLead);
    let replacementAgentId: string | undefined;
    const stopped: Array<{ agentId: string; ownerInstanceId?: string; teardown?: string }> = [];
    harness.addCleanup(
      MakaioBus.on(
        AdapterSubjects.startAgent,
        async (ctx) => {
          replacementAgentId = ctx.payload.agentId;
          if (replacementAgentId === undefined) throw new Error('replacement start omitted its caller-owned identity');
          if (failure === 'dispatch-uncertain') {
            ctx.setResult({ success: false, dispatch: 'dispatch-uncertain', message: 'replacement uncertain' });
            return;
          }
          if (failure === 'admission') await MakaioBus.request(SessionSubjects.close, { sessionId });
          ctx.setResult({
            success: true,
            agentId: replacementAgentId,
            adapterId: ctx.payload.adapterId,
            sessionId,
            adapterSessionId: `provider-replacement-${failure}`,
            ...callerOwnedSuccessFields(ctx.payload),
          });
        },
        { priority: 200 },
      ),
    );
    harness.addCleanup(
      MakaioBus.on(
        SessionSubjects.ownership.settleMovement,
        (ctx) => {
          if (failure === 'settlement' && ctx.payload.agentId === replacementAgentId) {
            throw new Error('replacement settlement failed');
          }
          return ctx.next();
        },
        { priority: 200 },
      ),
    );
    harness.addCleanup(
      MakaioBus.on(
        AdapterSubjects.acknowledgeCallerSettlement,
        (ctx) => {
          if (failure === 'completion' && ctx.payload.agentId === replacementAgentId) {
            ctx.setResult({ acknowledged: false, reason: 'status-refused' });
            return;
          }
          return ctx.next();
        },
        { priority: 200 },
      ),
    );
    harness.addCleanup(
      MakaioBus.on(
        AdapterSubjects.stopAgent,
        (ctx) => {
          stopped.push(ctx.payload);
          ctx.setResult({ success: true, evidence: 'released' });
        },
        { priority: 200 },
      ),
    );

    await expect(
      MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'replace the deferred lead' }),
    ).rejects.toThrow();

    expect(replacementAgentId).toBeDefined();
    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(session?.status).toBe(failure === 'admission' ? 'closed' : 'active');
    expect(session?.leadAgentId).toBe(oldLead.agentId);
    const { agent: storedOldLead } = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: oldLead.agentId,
    });
    expect(storedOldLead?.status).toBe('idle');
    expect(session?.agents.find((agent) => agent.agentId === replacementAgentId)?.status).toBe('dead');
    expect(stopped).toEqual([
      expect.objectContaining({
        agentId: replacementAgentId,
        ownerInstanceId: harness.service.requireOwnershipInstanceId(),
        teardown: 'connector-only',
      }),
    ]);
    const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId: 'deferral-machine',
    });
    expect(claims.filter((claim) => claim.agentId === replacementAgentId).map((claim) => claim.status)).toEqual(
      failure === 'completion' || failure === 'admission' ? ['abandoned'] : [],
    );
  });

  it('designates a successful replacement after deferring the foreign lead', async () => {
    const sessionId = 'session-replacement-success';
    const [oldLead] = await harness.seedSession(sessionId, ['old-lead-success']);
    if (oldLead === undefined) throw new Error('missing seeded lead');
    harness.occupyAgentKey(oldLead);

    await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'replace the deferred lead' });

    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(session?.leadAgentId).toBe(harness.routed[0]);
    expect(session?.leadAgentId).not.toBe(oldLead.agentId);
    expect(session?.agents.find((agent) => agent.agentId === session.leadAgentId)?.status).toBe('idle');
  });
});

/**
 * Assert a total deferral reports all targets through its error contract.
 * @param failure - Whatever the send rejected with.
 * @param agentIds - Agents the send could not act for.
 */
function expectDeferralFailure(failure: unknown, agentIds: readonly string[]): void {
  const error = failure instanceof Error ? failure : new Error(String(failure));
  const carried = describeCarriedDeferral(error);
  expect(carried.deferredAgentIds).toEqual(agentIds);
  for (const agentId of agentIds) expect(carried.message).toContain(agentId);
  expect(carried.message).toContain('no agent this runtime may drive');
}

/**
 * Find the deferral the send raised through any error wrapper.
 * @param error - The rejection, possibly a transport wrapper.
 * @returns The deferred ids and the message that named them.
 */
function describeCarriedDeferral(error: Error): { deferredAgentIds: readonly string[] | undefined; message: string } {
  let current: Error | undefined = error;
  while (current !== undefined) {
    const carried = (current as { deferredAgentIds?: readonly string[] }).deferredAgentIds;
    if (carried !== undefined) return { deferredAgentIds: carried, message: current.message };
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return { deferredAgentIds: undefined, message: error.message };
}

/**
 * Find a coded error through the bus's wrapper chain.
 * @param failure - Whatever the send rejected with.
 * @param code - Session-start code the test expects.
 * @returns The coded error, when the chain carries one.
 */
function findErrorWithCode(failure: unknown, code: string): Error | undefined {
  let current: Error | undefined = failure instanceof Error ? failure : undefined;
  while (current !== undefined) {
    if ((current as { code?: string }).code === code) return current;
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
