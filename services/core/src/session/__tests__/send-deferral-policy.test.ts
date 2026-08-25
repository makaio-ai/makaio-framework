// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 480 }] */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionOwnershipStorageSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { verifyAndRecoverAgents } from '../utils/agent-recovery.js';
import { DEFERRAL_LIVE_ADAPTER_ID, SendDeferralPolicyHarness } from './send-deferral-policy.fixture.js';
import { createTestAgent } from './shared.js';

/**
 * What a send does with an agent this runtime may not drive (§8.2a).
 *
 * The seam under test is the **policy**, not the gate: what the send does once
 * the authority has said the agent's provider session belongs to someone else.
 *
 * **The verdict is injected, and that is a statement about the framework, not a
 * convenience.** Fresh-with-history recovery is keyless, so its reservation
 * cannot be `occupied` and this policy is unreachable in that composition.
 * Native resume and attach meet the verdict live in their own suites. The
 * injection sits at priority 100 in front of the real authority and only for
 * named agents; all other requests still reach the real authority.
 *
 * Every assertion is on what was *routed*, because the bug this policy exists
 * to prevent is a correct recovery result that never reaches routing.
 */

describe('deferred agents in a send', () => {
  let harness: SendDeferralPolicyHarness;
  /** Agents each `agent.sendMessage` reached, in order. */
  let routed: string[];
  /** The session context each routed turn carried, by agent. */
  let routedContexts: Map<string, unknown>;
  /** Every rehydrate the adapter stand-in observed. */
  let dispatched: Array<Record<string, unknown>>;
  /** Agents reported live by the liveness probe. */
  let liveAgentIds: Set<string>;
  /** Agents addressed by liveness probes. */
  let probedAgentIds: string[];
  /** Agents whose reservation is answered `occupied`. */
  let occupiedAgentIds: Set<string>;

  beforeEach(async () => {
    harness = await SendDeferralPolicyHarness.create();
    routed = harness.routed;
    routedContexts = harness.routedContexts;
    dispatched = harness.dispatched;
    liveAgentIds = harness.liveAgentIds;
    probedAgentIds = harness.probedAgentIds;
    occupiedAgentIds = harness.occupiedAgentIds;
  });

  afterEach(() => {
    harness.destroy();
  });

  it('dispatches the lazy recovery to a freshly resolved adapter instance (case 69)', async () => {
    const sessionId = 'session-fresh-adapter';
    await harness.seedSession(sessionId, ['agent-fresh']);

    await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'hello' });

    expect(dispatched).toEqual([
      expect.objectContaining({
        agentId: 'agent-fresh',
        // The live instance, not the row's stale one: the reservation and the
        // dispatch have to name one instance, and a persisted id goes stale
        // across a runtime restart.
        adapterId: DEFERRAL_LIVE_ADAPTER_ID,
        callerOwnsAgentRow: true,
      }),
    ]);
    expect(routed).toEqual(['agent-fresh']);
  });

  it('mints a new lead when the session lead is held elsewhere (case 110, lead-default total)', async () => {
    const sessionId = 'session-lead-default';
    const [lead] = await harness.seedSession(sessionId, ['agent-lead']);
    harness.occupyAgentKey(lead as MakaioSessionAgent);

    const result = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'continue please' });

    // A deferred lead is always total: the default send has exactly one target.
    // Fresh-with-history against an agent owned elsewhere means a fresh *agent*,
    // not a second connector on the one this runtime may not drive.
    expect(dispatched).toEqual([]);
    expect(result.deferredAgentIds).toEqual(['agent-lead']);
    expect(routed).toHaveLength(1);
    expect(routed[0]).not.toBe('agent-lead');
    // The session now speaks through the replacement. The old row survives —
    // this runtime may not drive that agent, which is not the same as removing
    // it — but it no longer leads and nothing was routed to it.
    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
    expect(session?.leadAgentId).toBe(routed[0]);
    // The replacement inherits the *containment* the agent it stands in for
    // had. Omitting it is not "less configured": it is a connector with no
    // directory restriction at all, which nobody asked for.
    const { agent: replacement } = await MakaioBus.request(AgentStorageSubjects.get, { agentId: routed[0] as string });
    expect(replacement?.allowedDirectories).toEqual(['/work/repo']);
    expect(replacement?.cwd).toBe(lead?.cwd);
    // Credentials and endpoint resolve from this and nothing else: a
    // replacement without it does not fall back to the agent's account, it
    // starts against an unresolved provider context.
    expect(replacement?.providerConfigId).toBe('provider-config-abc');
  });

  it('retargets a legacy ownerless lead without probing or recovering it', async () => {
    const sessionId = 'session-legacy-lead-default';
    const [legacyLead] = await harness.seedSession(sessionId, ['legacy-lead'], { legacy: true });

    const result = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'continue please' });

    expect(probedAgentIds).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(result.deferredAgentIds).toEqual([legacyLead?.agentId]);
    expect(routed).toHaveLength(1);
    expect(routed[0]).not.toBe(legacyLead?.agentId);
  });

  it('delivers to the usable agents of a broadcast and names the rest (cases 110, 114)', async () => {
    const sessionId = 'session-all-partial';
    const [lead, member] = await harness.seedSession(sessionId, ['agent-usable', 'agent-held']);
    liveAgentIds.add((lead as MakaioSessionAgent).agentId);
    harness.occupyAgentKey(member as MakaioSessionAgent);

    const result = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'to everyone',
      agentIds: 'all',
    });

    // Case 114: the deferral reaches *routing*, not just a bookkeeping set.
    expect(routed).toEqual(['agent-usable']);
    expect(result.deferredAgentIds).toEqual(['agent-held']);
    // …and the survivor is routed as itself. It never lost its connector, so
    // the recovery history belongs to nobody here: injecting it would replay the
    // whole conversation into a live agent and tell it this is its first turn.
    expect(routedContexts.get('agent-usable')).toBeUndefined();
  });

  it('fails a broadcast whose every agent is held elsewhere (case 110, all total)', async () => {
    const sessionId = 'session-all-total';
    const agents = await harness.seedSession(sessionId, ['agent-a', 'agent-b']);
    for (const agent of agents) harness.occupyAgentKey(agent);

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'to everyone',
      agentIds: 'all',
    }).catch((error: unknown) => error);

    // A broadcast with no recipient is not a delivery, and no agent is
    // substituted: the caller asked for the session's agents.
    expect(routed).toEqual([]);
    expectDeferralFailure(failure, ['agent-a', 'agent-b']);
  });

  it('refuses an all-target legacy row without probing or recovering it', async () => {
    const sessionId = 'session-legacy-all';
    const [legacyAgent] = await harness.seedSession(sessionId, ['legacy-all'], { legacy: true });

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'to everyone',
      agentIds: 'all',
    }).catch((error: unknown) => error);

    expect(probedAgentIds).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(routed).toEqual([]);
    expectDeferralFailure(failure, [legacyAgent?.agentId as string]);
  });

  it('delivers to the named agents it may drive and names the rest (case 110, explicit partial)', async () => {
    const sessionId = 'session-explicit-partial';
    const [lead, member] = await harness.seedSession(sessionId, ['agent-named-usable', 'agent-named-held']);
    liveAgentIds.add((lead as MakaioSessionAgent).agentId);
    harness.occupyAgentKey(member as MakaioSessionAgent);

    const result = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'to the two of you',
      agentIds: ['agent-named-usable', 'agent-named-held'],
    });

    expect(routed).toEqual(['agent-named-usable']);
    expect(result.deferredAgentIds).toEqual(['agent-named-held']);
  });

  it('fails a named send whose every agent is held elsewhere (case 110, explicit total)', async () => {
    const sessionId = 'session-explicit-total';
    const [lead, member] = await harness.seedSession(sessionId, ['agent-other', 'agent-named-only']);
    liveAgentIds.add((lead as MakaioSessionAgent).agentId);
    harness.occupyAgentKey(member as MakaioSessionAgent);

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'only you',
      agentIds: ['agent-named-only'],
    }).catch((error: unknown) => error);

    // The session still has a usable agent, and it is deliberately not
    // substituted: the caller named the one it wanted.
    expect(routed).toEqual([]);
    expectDeferralFailure(failure, ['agent-named-only']);
  });

  it('refuses an explicit legacy row without probing or recovering it', async () => {
    const sessionId = 'session-legacy-explicit';
    const [legacyAgent] = await harness.seedSession(sessionId, ['legacy-explicit'], { legacy: true });

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'only you',
      agentIds: [legacyAgent?.agentId as string],
    }).catch((error: unknown) => error);

    expect(probedAgentIds).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(routed).toEqual([]);
    expectDeferralFailure(failure, [legacyAgent?.agentId as string]);
  });

  it('starts the replacement on this runtime\u2019s instance rather than inheriting a pinned one', async () => {
    const sessionId = 'session-instance-substitution';
    const [lead] = await harness.seedSession(sessionId, ['agent-pinned']);
    harness.occupyAgentKey(lead as MakaioSessionAgent);

    await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'continue please' });

    // Pinned to an instance this runtime did not resolve, and the replacement
    // does **not** inherit it: an instance ID is a one-way hash of
    // `(machineId, adapterName)`, so inheriting names an instance without its
    // owning machine and rebuilds the mixed key. The substitution is deliberate.
    expect(lead?.adapterId).toBe('stale-adapter');
    const { agent: replacement } = await MakaioBus.request(AgentStorageSubjects.get, { agentId: routed[0] as string });
    expect(replacement).toMatchObject({ adapterId: DEFERRAL_LIVE_ADAPTER_ID, adapterName: lead?.adapterName });
  });

  it('recovers the agents a replacement start adopted after losing the designation race', async () => {
    const sessionId = 'session-replacement-adopts';
    const [lead] = await harness.seedSession(sessionId, ['agent-lead-adopt']);
    harness.occupyAgentKey(lead as MakaioSessionAgent);

    // The replacement the deferral path mints loses its own designation race to
    // a peer, so it adopts the winner's agents instead of its own. Those have
    // never been through this send's recovery step — the fresh-start branch
    // consumes exactly this, one step earlier.
    const winner = 'winner-agent';
    let conflicted = false;
    harness.addCleanup(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,

        async (ctx) => {
          if (conflicted || occupiedAgentIds.has(ctx.payload.agentId)) return ctx.next();
          conflicted = true;
          // What the winner left behind: its own agent, designated through the
          // handler production designates from, and still `starting` because a
          // reserved start designates before it dispatches.
          const agent = createTestAgent(winner, {
            sessionId,
            adapterId: 'stale-adapter',
            adapterSessionId: `provider-${winner}`,
            role: 'lead',
            status: 'starting',
            runtimeOwner: { machineId: 'deferral-machine', instanceId: harness.service.requireOwnershipInstanceId() },
          });
          await MakaioBus.request(AgentStorageSubjects.set, { agentId: winner, agent });
          await MakaioBus.emit(SessionSubjects.agent.added, {
            sessionId,
            agentId: winner,
            adapterId: 'stale-adapter',
            adapterName: agent.adapterName,
            adapterSessionId: agent.adapterSessionId as string,
            role: 'lead',
          });
          ctx.setResult({ outcome: 'lead-conflict', currentLeadAgentId: winner });
        },
        { priority: 200 },
      ),
    );

    await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'continue please' });

    // The adopted agent is rebuilt before anything is routed to it. Discarding
    // the adoption would route this turn at a lead whose connector never existed.
    expect(dispatched.map((payload) => payload.agentId)).toEqual([winner]);
    expect(routed).toEqual([winner]);
  });

  it('leaves the foreign generation untouched whichever of the three consumers met it (case 75)', async () => {
    const sessionId = 'session-consumer-parity';
    const [agent] = await harness.seedSession(sessionId, ['agent-parity']);
    harness.occupyAgentKey(agent as MakaioSessionAgent);

    // Consumer 1 — the restart handler reports the deferred plan and dispatches
    // nothing.
    const restart = await MakaioBus.request(SessionSubjects.restartAgents, { sessionId });
    expect(restart.results).toEqual([{ agentId: 'agent-parity', adapterId: 'stale-adapter', success: true }]);

    // Consumer 2 — the liveness-verification helper, which the product recovery
    // path drives. It names the agent and decides nothing with it.
    const verified = await verifyAndRecoverAgents(MakaioBus, [agent as MakaioSessionAgent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });
    expect([...verified.deferredAgentIds]).toEqual(['agent-parity']);
    expect(verified.usable).toEqual([]);
    expect([...verified.recoveredAgentIds]).toEqual([]);

    // Consumer 3 — the send path, which drops the agent and speaks through a
    // replacement instead of failing.
    await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'anything' });

    // No consumer dispatched, and none took a generation for the agent it was
    // told it may not drive. The replacement lead the send minted has one of its
    // own, which is a different agent entirely.
    expect(dispatched).toEqual([]);
    const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId: 'deferral-machine',
    });
    expect(claims.filter((claim) => claim.agentId === 'agent-parity')).toEqual([]);
    // §8.2a's other half, asserted where it is observable: the send is only
    // "still a delivery" if the replacement receives the conversation, so the
    // routed turn carries the injected history rather than an empty context.
    expect(routed).toHaveLength(1);
    expect(routed[0]).not.toBe('agent-parity');
    expect(routedContexts.get(routed[0] as string)).toMatchObject({ isFirstTurn: true });
  });
});

/**
 * Assert a total deferral failed the way §8.2a prescribes.
 *
 * Both carriers are checked: the field, for an in-process caller, and the
 * message, for anything crossing a transport that may not preserve custom
 * error properties.
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
 * Find the deferral the send raised, through whatever wrapped it.
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
