/**
 * Shared behavioral test suite for session ownership storage handlers.
 *
 * Both the Drizzle and memory backends implement the same contract
 * (`SessionOwnershipStorageSubjects`). This module defines the shared behavioral
 * tests so each backend only needs to provide its setup and test
 * backend-specific concerns separately.
 *
 * Call `describeSessionOwnershipBehavior()` inside a `describe` block **after**
 * the backend's lifecycle hooks are configured (i.e. after `beforeEach`/`afterEach`
 * or `beforeAll`/`afterAll` have registered and wired the relevant handlers).
 */
import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  resolveResumableAdapterSessionId,
  type AdapterSessionClaimRecord,
} from '@makaio/contracts';
import { SessionStorageSubjects } from '../namespace.js';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { createSession, createAgent } from './shared.js';

/** Backend-specific setup used to place a real persisted claim in legacy form. */
export interface SessionOwnershipBehaviorFixture {
  /** Clear the persisted runtime owner identity for the named claim. */
  readonly clearClaimOwnerInstanceId: (claimId: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Internal test helpers
// ---------------------------------------------------------------------------

/**
 * Seed one session into the bus-registered backend.
 * @returns The seeded session ID.
 */
async function seedSession(): Promise<string> {
  const sessionId = `session-${crypto.randomUUID()}`;
  await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session: createSession({ sessionId }) });
  return sessionId;
}

/**
 * Seed one member agent into an already-seeded session.
 *
 * Several tests need a *second* agent in the same session — a competitor for the
 * key, a foreign presenter of somebody else's token, a member next to the lead —
 * so seeding one is its own step rather than a copy of {@link seedSessionAndAgent}
 * with the session part deleted.
 * @param sessionId - Session the agent belongs to.
 * @returns The seeded agent ID.
 */
async function seedAgent(sessionId: string): Promise<string> {
  const agentId = `agent-${crypto.randomUUID()}`;
  await MakaioBus.request(AgentStorageSubjects.set, {
    agentId,
    agent: createAgent({ agentId, sessionId, adapterId: 'adapter-1' }),
  });
  return agentId;
}

/**
 * Seed one session and one agent into the bus-registered backend.
 * Returns the seeded values for use in assertions.
 * @returns IDs of the seeded rows.
 */
async function seedSessionAndAgent(): Promise<{ sessionId: string; agentId: string }> {
  const sessionId = await seedSession();
  return { sessionId, agentId: await seedAgent(sessionId) };
}

/**
 * The settle target that names no provider session at all.
 *
 * Shared by every settle whose subject is the refusal rather than the currency
 * written: `inherited` is the state a never-settled agent row already carries,
 * and pairing it with a null ID is what the `confirmed ↔ id !== null` invariant
 * requires of any target the backends will accept.
 */
const INHERITED_TARGET = {
  currentAdapterSessionId: null,
  currentAdapterSessionIdState: 'inherited',
} as const;

/**
 * The generation a keyed acquisition or retry must carry.
 *
 * `claim` is nullable on the response because a keyless reservation writes no
 * row. Every assertion that reaches for it names a provider session, so a `null`
 * here is a backend bug rather than a case the test has to branch on — and
 * failing loudly is what keeps that distinction visible.
 * @param claim - The claim a `claimed` or `idempotent` outcome reported.
 * @returns That claim.
 */
function requireClaim(claim: AdapterSessionClaimRecord | null): AdapterSessionClaimRecord {
  if (claim === null) throw new Error('a keyed claim reported no generation');
  return claim;
}

/**
 * Build a minimal claim request for the given agent, using a fixed ownership key.
 * @param agentId - Agent to claim for.
 * @param sessionId - Session the agent belongs to.
 * @param claimToken - Caller-minted claim generation token.
 * @param machineId - Machine identity (default `machine-1`).
 * @param adapterId - Adapter identity (default `adapter-1`).
 * @param providerSessionId - Provider session identity (default `provider-session-1`).
 * @param ownerInstanceId - Runtime process taking the generation.
 */
function buildClaimRequest(
  agentId: string,
  sessionId: string,
  claimToken: string,
  machineId = 'machine-1',
  adapterId = 'adapter-1',
  providerSessionId: string | null = 'provider-session-1',
  ownerInstanceId = `instance-${claimToken}`,
) {
  return {
    machineId,
    adapterId,
    adapterName: 'test-adapter',
    providerSessionId,
    sessionId,
    agentId,
    ownerInstance: { instanceId: ownerInstanceId },
    claimToken,
  } as const;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

/**
 * Registers the shared behavioral tests for any `SessionOwnershipStorage` backend.
 *
 * Call inside a `describe()` block after the backend's `beforeEach`/`afterEach`
 * lifecycle is configured.
 * @param fixture - Backend hook that prepares a persisted legacy claim.
 */
export function describeSessionOwnershipBehavior(fixture: SessionOwnershipBehaviorFixture): void {
  describe('finalizeRecovery — attempt-fenced lifecycle', () => {
    it('applies only the exact attempt and binding, clears the attempt on success, and restores an absent prior binding', async () => {
      const sessionId = await seedSession();
      const agentId = `agent-${crypto.randomUUID()}`;
      const currentBinding = {
        adapterId: 'recovery-adapter',
        ownerMachineId: 'recovery-machine',
        ownerInstanceId: 'recovery-owner',
      };
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: createAgent({
          agentId,
          sessionId,
          adapterId: currentBinding.adapterId,
          status: 'starting',
          runtimeOwner: { machineId: currentBinding.ownerMachineId, instanceId: currentBinding.ownerInstanceId },
          recoveryAttemptId: 'attempt-1',
        }),
      });

      const stale = await MakaioBus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
        agentId,
        attemptId: 'attempt-0',
        binding: currentBinding,
        action: { kind: 'failed' },
      });
      expect(stale.applied).toBe(false);

      const rolledBack = await MakaioBus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
        agentId,
        attemptId: 'attempt-1',
        binding: currentBinding,
        action: {
          kind: 'rollback',
          preimage: { status: 'active', adapterId: 'prior-adapter', recoveryAttemptId: 'prior-attempt' },
        },
      });
      expect(rolledBack.applied).toBe(true);
      const afterRollback = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(afterRollback.agent?.status).toBe('active');
      expect(afterRollback.agent?.adapterId).toBe('prior-adapter');
      expect(afterRollback.agent?.runtimeOwner).toBeUndefined();
      expect(afterRollback.agent?.recoveryAttemptId).toBe('prior-attempt');

      const succeedingAgentId = `agent-${crypto.randomUUID()}`;
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: succeedingAgentId,
        agent: createAgent({
          agentId: succeedingAgentId,
          sessionId,
          adapterId: currentBinding.adapterId,
          status: 'starting',
          runtimeOwner: { machineId: currentBinding.ownerMachineId, instanceId: currentBinding.ownerInstanceId },
          recoveryAttemptId: 'attempt-2',
        }),
      });
      const staleFirstAttempt = await MakaioBus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
        agentId: succeedingAgentId,
        attemptId: 'attempt-1',
        binding: currentBinding,
        action: { kind: 'failed' },
      });
      expect(staleFirstAttempt.applied).toBe(false);
      const succeeded = await MakaioBus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
        agentId: succeedingAgentId,
        attemptId: 'attempt-2',
        binding: currentBinding,
        action: { kind: 'succeeded' },
      });
      expect(succeeded.applied).toBe(true);
      const afterSuccess = await MakaioBus.request(AgentStorageSubjects.get, { agentId: succeedingAgentId });
      expect(afterSuccess.agent).toMatchObject({ status: 'idle', runtimeOwner: { machineId: 'recovery-machine' } });
      expect(afterSuccess.agent?.recoveryAttemptId).toBeUndefined();
    });
  });

  // ─── claim: acquisition, retry, contention ─────────────────────────────────────────────────────────────────────

  describe('claim — free key', () => {
    it('takes an unclaimed key and returns outcome=claimed with fence===1', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );

      expect(result.outcome).toBe('claimed');
      if (result.outcome !== 'claimed') return;
      expect(requireClaim(result.claim).fence).toBe(1);
      expect(requireClaim(result.claim).claimToken).toBe(claimToken);
      expect(requireClaim(result.claim).agentId).toBe(agentId);
      expect(requireClaim(result.claim).sessionId).toBe(sessionId);
      expect(requireClaim(result.claim).status).toBe('held');
      expect(result.leadDesignated).toBe(false);
    });

    it('returns outcome=idempotent with same fence on a retry of the same claimToken', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();
      const req = buildClaimRequest(agentId, sessionId, claimToken);

      const first = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, req);
      expect(first.outcome).toBe('claimed');

      const second = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, req);
      expect(second.outcome).toBe('idempotent');
      if (second.outcome !== 'idempotent') return;
      expect(requireClaim(second.claim).fence).toBe(1);
      expect(requireClaim(second.claim).claimToken).toBe(claimToken);

      // Exactly one claim row must exist
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(1);
    });

    it('reuses an existing owner without consuming the next runtime incarnation', async () => {
      const sessionId = await seedSession();
      const firstAgentId = await seedAgent(sessionId);
      const secondAgentId = await seedAgent(sessionId);
      const thirdAgentId = await seedAgent(sessionId);
      const machineId = `machine-incarnation-${crypto.randomUUID()}`;
      const adapterId = `adapter-incarnation-${crypto.randomUUID()}`;
      const firstOwnerInstanceId = `instance-incarnation-first-${crypto.randomUUID()}`;
      const firstRequest = buildClaimRequest(
        firstAgentId,
        sessionId,
        crypto.randomUUID(),
        machineId,
        adapterId,
        `provider-incarnation-first-${crypto.randomUUID()}`,
        firstOwnerInstanceId,
      );

      const first = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, firstRequest);
      expect(first.outcome).toBe('claimed');
      const beforeRetry = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId: firstAgentId });

      const repeated = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, firstRequest);
      expect(repeated.outcome).toBe('idempotent');
      const refused = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...firstRequest,
        agentId: secondAgentId,
        claimToken: crypto.randomUUID(),
      });
      expect(refused.outcome).toBe('already-claimed');

      const afterRefusal = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId: firstAgentId });
      expect(afterRefusal).toEqual(beforeRetry);
      const held = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId, adapterId });
      expect(held.claims).toHaveLength(1);

      const secondOwnerInstanceId = `instance-incarnation-second-${crypto.randomUUID()}`;
      const second = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          thirdAgentId,
          sessionId,
          crypto.randomUUID(),
          machineId,
          adapterId,
          `provider-incarnation-second-${crypto.randomUUID()}`,
          secondOwnerInstanceId,
        ),
      );
      expect(second.outcome).toBe('claimed');

      const [firstRuntime, secondRuntime] = await Promise.all([
        MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: firstOwnerInstanceId,
          machineId,
        }),
        MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: secondOwnerInstanceId,
          machineId,
        }),
      ]);
      expect(firstRuntime.instance?.incarnation).toBe(1);
      expect(secondRuntime.instance?.incarnation).toBe(2);
    });

    it('returns outcome=already-claimed carrying the holder when a different token races', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();
      const secondToken = crypto.randomUUID();

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, buildClaimRequest(agentId, sessionId, firstToken));

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, secondToken),
      );

      expect(result.outcome).toBe('already-claimed');
      if (result.outcome !== 'already-claimed') return;
      expect(result.holder.claimToken).toBe(firstToken);
    });

    it('refuses a foreign agent presenting the holder’s token instead of calling it idempotent', async () => {
      const sessionId = await seedSession();
      const holderAgentId = await seedAgent(sessionId);
      const foreignAgentId = await seedAgent(sessionId);

      const claimToken = crypto.randomUUID();
      const held = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(holderAgentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(held.outcome).toBe('claimed');

      // The token is not a password: presenting somebody else's generation must
      // not report success, and above all must not let the presenter redirect
      // the session's lead on the way through.
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(foreignAgentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: holderAgentId },
      });

      expect(result.outcome).toBe('already-claimed');
      if (result.outcome !== 'already-claimed') return;
      expect(result.holder.agentId).toBe(holderAgentId);
      expect(result.holder.claimToken).toBe(claimToken);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(holderAgentId);
    });
  });

  // ─── claim: missing referenced rows ────────────────────────────────────────────────────────────────────────────

  describe('claim — not-found', () => {
    it('returns not-found with missing=agent when agentId is unknown and creates no row', async () => {
      const { sessionId } = await seedSessionAndAgent();
      const nonexistentAgentId = `agent-${crypto.randomUUID()}`;

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(nonexistentAgentId, sessionId, crypto.randomUUID()),
      );

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('agent');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(0);
    });

    it('returns not-found with missing=session when sessionId is unknown and creates no row', async () => {
      const { agentId } = await seedSessionAndAgent();
      const nonexistentSessionId = `session-${crypto.randomUUID()}`;

      // Claim with an agent that exists but for a session that doesn't
      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, nonexistentSessionId, crypto.randomUUID()),
      );

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('session');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(0);
    });

    it('reports missing=session when neither the session nor the agent exists', async () => {
      // The contract names the session the more specific finding and decides it
      // first, so the answer for "nothing referenced here exists" is `session` —
      // a caller told `agent` would go looking for an agent row in a session
      // that has no rows at all.
      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(`agent-${crypto.randomUUID()}`, `session-${crypto.randomUUID()}`, crypto.randomUUID()),
      );

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('session');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(0);
    });
  });

  // ─── claim: the agent must belong to the named session ─────────────────────────────────────────────────────────

  describe('claim — agent/session membership', () => {
    /**
     * Seed two sessions, each with its own agent, and make the second session's
     * agent its lead — the state a cross-session claim would try to redirect.
     */
    async function seedTwoSessions(): Promise<{
      homeSessionId: string;
      homeAgentId: string;
      foreignSessionId: string;
      foreignLeadAgentId: string;
    }> {
      const home = await seedSessionAndAgent();
      const foreign = await seedSessionAndAgent();

      const leadClaim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          foreign.agentId,
          foreign.sessionId,
          crypto.randomUUID(),
          'machine-membership',
          'adapter-foreign',
          'prov-foreign',
        ),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(leadClaim.outcome).toBe('claimed');

      return {
        homeSessionId: home.sessionId,
        homeAgentId: home.agentId,
        foreignSessionId: foreign.sessionId,
        foreignLeadAgentId: foreign.agentId,
      };
    }

    it('returns not-found with missing=agent when the acquisition names a session the agent is not in', async () => {
      const { homeSessionId, foreignSessionId, homeAgentId, foreignLeadAgentId } = await seedTwoSessions();

      // The agent exists and the session exists — but not together. What the
      // claim references is that agent *in that session*, and it does not exist.
      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          homeAgentId,
          foreignSessionId,
          crypto.randomUUID(),
          'machine-membership',
          'adapter-1',
          'prov-cross',
        ),
      );

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('agent');

      // No claim row was filed under the foreign session …
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-membership',
        adapterId: 'adapter-1',
      });
      expect(listed.claims).toHaveLength(0);

      // … and the agent's own session is untouched too.
      const homeResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: homeSessionId });
      expect(homeResult.session?.leadAgentId ?? null).toBeNull();
      const foreignResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: foreignSessionId });
      expect(foreignResult.session?.leadAgentId).toBe(foreignLeadAgentId);
    });

    it('refuses a cross-session acquisition that would also redirect the foreign session’s lead', async () => {
      const { foreignSessionId, homeAgentId, foreignLeadAgentId } = await seedTwoSessions();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          homeAgentId,
          foreignSessionId,
          crypto.randomUUID(),
          'machine-membership',
          'adapter-1',
          'prov-cross-lead',
        ),
        designateLead: { expectedLeadAgentId: foreignLeadAgentId },
      });

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('agent');

      // The designation is never reached: membership is decided first.
      const foreignResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: foreignSessionId });
      expect(foreignResult.session?.leadAgentId).toBe(foreignLeadAgentId);
    });

    it('returns not-found with missing=agent when a takeover names a session the taking agent is not in', async () => {
      // What this pins is the *classification* the takeover's membership
      // predicate produces: a zero-row UPDATE whose token CAS held is reported
      // as the same `not-found` every other path gives for a broken
      // `(agent, session)` pair, and the superseded generation is left intact.
      // It does not — and from the public API cannot — pin the interleaving the
      // predicate exists for: an agent moved away *between* the classifying read
      // and the UPDATE lives inside one transaction and cannot be steered from
      // here. That window has no test anywhere; it is closed by construction
      // alone (the guard is a condition of the write, never of a preceding
      // read), so a regression back to a pre-read would surface only in review,
      // not in CI.
      const { foreignSessionId, homeAgentId, foreignLeadAgentId } = await seedTwoSessions();
      const heldToken = crypto.randomUUID();

      // The foreign session's lead holds the key that is about to be taken over.
      const held = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          foreignLeadAgentId,
          foreignSessionId,
          heldToken,
          'machine-membership',
          'adapter-1',
          'prov-takeover',
        ),
      );
      expect(held.outcome).toBe('claimed');
      if (held.outcome !== 'claimed') return;

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          homeAgentId,
          foreignSessionId,
          crypto.randomUUID(),
          'machine-membership',
          'adapter-1',
          'prov-takeover',
        ),
        supersedes: { claimToken: heldToken },
        designateLead: { expectedLeadAgentId: foreignLeadAgentId },
      });

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('agent');

      // The superseded generation still stands, and the lead was not redirected.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-membership',
        providerSessionId: 'prov-takeover',
      });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]).toEqual(held.claim);

      const foreignResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: foreignSessionId });
      expect(foreignResult.session?.leadAgentId).toBe(foreignLeadAgentId);
    });
  });

  // ─── claim: lead designation ───────────────────────────────────────────────────────────────────────────────────

  describe('claim — designateLead', () => {
    it('sets leadDesignated=true and updates the session row when expectation matches no lead', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(result.outcome).toBe('claimed');
      if (result.outcome !== 'claimed') return;
      expect(result.leadDesignated).toBe(true);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(agentId);
    });

    it('returns leadDesignated=false on retry when agent is already the lead', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const firstToken = crypto.randomUUID();
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, firstToken),
        designateLead: { expectedLeadAgentId: null },
      });

      // Idempotent retry: agent is already the lead
      const second = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, firstToken),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(second.outcome).toBe('idempotent');
      if (second.outcome !== 'idempotent') return;
      expect(second.leadDesignated).toBe(false);
    });

    it('designates the lead on an idempotent retry that first carries the designation', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      // The acquisition takes the key without touching the lead …
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;
      expect(first.leadDesignated).toBe(false);

      // … and the retry adds the designation against a still-leaderless session.
      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(retry.outcome).toBe('idempotent');
      if (retry.outcome !== 'idempotent') return;
      expect(retry.leadDesignated).toBe(true);
      expect(requireClaim(retry.claim).fence).toBe(requireClaim(first.claim).fence);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(agentId);
    });

    it('returns lead-conflict and does NOT take the claim when lead expectation is wrong', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      // Seed a second agent as the actual lead
      const otherAgentId = await seedAgent(sessionId);

      // Make otherAgent the current lead by claiming with it first
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(otherAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-2', 'provider-2'),
        designateLead: { expectedLeadAgentId: null },
      });

      // Now attempt to claim a different key and designate lead with a wrong expectation
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        designateLead: { expectedLeadAgentId: null }, // wrong: session already has a lead
      });

      expect(result.outcome).toBe('lead-conflict');
      if (result.outcome !== 'lead-conflict') return;
      expect(result.currentLeadAgentId).toBe(otherAgentId);

      // The claim must NOT have been created (rollback proof)
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
        adapterId: 'adapter-1',
      });
      expect(listed.claims).toHaveLength(0);
    });

    it('returns lead-conflict on an idempotent retry and leaves the held claim intact', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const otherAgentId = await seedAgent(sessionId);

      // The claiming agent takes its key without designating a lead …
      const claimToken = crypto.randomUUID();
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(first.outcome).toBe('claimed');

      // … and another agent becomes the session's lead in the meantime.
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(otherAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-2', 'provider-2'),
        designateLead: { expectedLeadAgentId: null },
      });

      // Retrying the same acquisition with a stale lead expectation conflicts,
      // and must not cost the caller the claim it already holds.
      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(retry.outcome).toBe('lead-conflict');
      if (retry.outcome !== 'lead-conflict') return;
      expect(retry.currentLeadAgentId).toBe(otherAgentId);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
        adapterId: 'adapter-1',
      });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimToken).toBe(claimToken);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(otherAgentId);
    });
  });

  // ─── claim: a promotion publishes the new lead's currency ──────────────────────────────────────────────────────

  describe('claim — designateLead mirrors the new lead’s currency', () => {
    it('publishes the agent’s settled currency when an idempotent retry promotes it to lead', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      // The agent takes its key as a plain member …
      const claim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      expect(claim.leadDesignated).toBe(false);

      // … and settles a currency that the session must not yet carry.
      const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claim.claim).fence,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'member-then-lead', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(settled.outcome).toBe('settled');
      if (settled.outcome !== 'settled') return;
      expect(settled.sessionSnapshotUpdated).toBe(false);

      const beforePromotion = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(beforePromotion.session?.currentAdapterSessionId ?? null).toBeNull();

      // The retry adds the designation. A settle would now report `idempotent`
      // and mirror nothing, so the promotion is the only writer left that can
      // make the session's snapshot true.
      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(retry.outcome).toBe('idempotent');
      if (retry.outcome !== 'idempotent') return;
      expect(retry.leadDesignated).toBe(true);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(agentId);
      expect(sessionResult.session?.currentAdapterSessionId).toBe('member-then-lead');
      expect(sessionResult.session?.currentAdapterSessionIdState).toBe('confirmed');
    });

    it('mirrors an inherited currency verbatim when a fresh acquisition designates the lead', async () => {
      // The session carries a snapshot from before it had this lead — seeded at
      // insert, because the ownership seam is the only writer of that pair
      // afterwards and the partial-update surface no longer carries it at all.
      const sessionId = `session-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: createSession({
          sessionId,
          currentAdapterSessionId: 'previous-lead-session',
          currentAdapterSessionIdState: 'confirmed',
        }),
      });
      const agentId = await seedAgent(sessionId);

      const claim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      expect(claim.leadDesignated).toBe(true);

      // The snapshot is the *designated lead's* currency, whatever it is: this
      // agent has never settled, so the session must now say so too.
      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBeNull();
      expect(readResult.ownership?.currency.currentAdapterSessionIdState).toBe('inherited');

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.currentAdapterSessionId ?? null).toBeNull();
      expect(sessionResult.session?.currentAdapterSessionIdState).toBe('inherited');
    });

    /**
     * Seed a session and a member agent that carry the given origin identities.
     *
     * `inherited` resolves against *the reading row's own* origin, so a mirror
     * that copies the state across rows is only observable when the two origins
     * differ — which is exactly what these fixtures set up.
     * @param sessionOrigin - The session row's immutable origin, if any.
     * @param agentOrigin - The agent row's immutable origin, if any.
     * @returns IDs of the seeded rows.
     */
    async function seedWithOrigins(
      sessionOrigin: string | undefined,
      agentOrigin: string | undefined,
    ): Promise<{ sessionId: string; agentId: string }> {
      const sessionId = `session-${crypto.randomUUID()}`;
      const agentId = `agent-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: createSession({ sessionId, adapterSessionId: sessionOrigin }),
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: createAgent({ agentId, sessionId, adapterSessionId: agentOrigin }),
      });
      return { sessionId, agentId };
    }

    /**
     * Promote the agent to lead of its session and report what each row then
     * resolves as its resume target.
     * @param sessionId - Session being led.
     * @param agentId - Agent being promoted.
     * @returns The resolved targets of the agent and of the session row.
     */
    async function promoteAndResolve(
      sessionId: string,
      agentId: string,
    ): Promise<{ leadTarget: string | null; sessionTarget: string | null; sessionState: string | undefined }> {
      const claim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome === 'claimed') expect(claim.leadDesignated).toBe(true);

      const ownership = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      const session = stored.session;

      return {
        leadTarget: resolveResumableAdapterSessionId(
          ownership.ownership?.currency ?? {
            adapterSessionId: null,
            currentAdapterSessionId: null,
            currentAdapterSessionIdState: 'inherited',
          },
        ),
        sessionTarget: resolveResumableAdapterSessionId({
          adapterSessionId: session?.adapterSessionId ?? null,
          currentAdapterSessionId: session?.currentAdapterSessionId ?? null,
          currentAdapterSessionIdState: session?.currentAdapterSessionIdState ?? 'inherited',
        }),
        sessionState: session?.currentAdapterSessionIdState,
      };
    }

    it('names the promoted lead’s own origin when it differs from the session’s', async () => {
      const sessionOrigin = `prev-lead-origin-${crypto.randomUUID()}`;
      const agentOrigin = `promoted-lead-origin-${crypto.randomUUID()}`;
      const { sessionId, agentId } = await seedWithOrigins(sessionOrigin, agentOrigin);

      const resolved = await promoteAndResolve(sessionId, agentId);

      // The lead has never settled, so its currency is `inherited` and resolves
      // to its own origin. Copying that state onto the session row would make
      // the session resolve to the *previous* lead's origin instead.
      expect(resolved.leadTarget).toBe(agentOrigin);
      expect(resolved.sessionState).toBe('confirmed');
      expect(resolved.sessionTarget).toBe(agentOrigin);
    });

    it('leaves the session inherited when the promoted lead shares its origin', async () => {
      const origin = `shared-origin-${crypto.randomUUID()}`;
      const { sessionId, agentId } = await seedWithOrigins(origin, origin);

      const resolved = await promoteAndResolve(sessionId, agentId);

      // Both rows already resolve to the same provider session, so `inherited`
      // is still true of the session row and is left standing.
      expect(resolved.sessionState).toBe('inherited');
      expect(resolved.sessionTarget).toBe(origin);
      expect(resolved.leadTarget).toBe(origin);
    });

    it('marks the session moved when the promoted lead has nothing resumable', async () => {
      const sessionOrigin = `prev-lead-origin-${crypto.randomUUID()}`;
      const { sessionId, agentId } = await seedWithOrigins(sessionOrigin, undefined);

      const resolved = await promoteAndResolve(sessionId, agentId);

      // The lead resolves to nothing, so the session must stop advertising the
      // origin it inherited from the previous one.
      expect(resolved.leadTarget).toBeNull();
      expect(resolved.sessionState).toBe('moved');
      expect(resolved.sessionTarget).toBeNull();
    });

    it('leaves the session snapshot alone on a retry by the agent that is already the lead', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      const claim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;
      expect(claim.leadDesignated).toBe(true);

      // Settlement moves the snapshot on after the designation — through the
      // seam, which is the only writer of the pair on either row.
      await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claim.claim).fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'settled-after-designation',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      // The retry designates nobody — the session already names this agent — so
      // it must not reset the snapshot to the agent's (still unsettled) pair.
      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(retry.outcome).toBe('idempotent');
      if (retry.outcome !== 'idempotent') return;
      expect(retry.leadDesignated).toBe(false);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.currentAdapterSessionId).toBe('settled-after-designation');
      expect(sessionResult.session?.currentAdapterSessionIdState).toBe('confirmed');
    });
  });

  // ─── claim: the retry is revalidated, not trusted ──────────────────────────────────────────────────────────────

  describe('claim — same-token retry revalidates the generation', () => {
    /**
     * Take a key without designating a lead, leaving the session leaderless — so
     * a retry that wrongly promotes the caller is observable on the session row.
     * @returns The seeded rows and the generation that holds the key.
     */
    async function claimLeaderless(): Promise<{
      sessionId: string;
      agentId: string;
      claimToken: string;
      fence: number;
    }> {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();
      const claim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') throw new Error('claim did not succeed');
      expect(claim.leadDesignated).toBe(false);

      const beforeRetry = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(beforeRetry.session?.leadAgentId ?? null).toBeNull();

      return { sessionId, agentId, claimToken, fence: requireClaim(claim.claim).fence };
    }

    /**
     * Retry the acquisition after the generation was given up with a disposition
     * that keeps its row blocking the key.
     * @param disposition - Non-freeing disposition to mark the generation with.
     */
    async function expectRetryAfterMarkedRelease(disposition: 'releasing' | 'abandoned'): Promise<void> {
      const { sessionId, agentId, claimToken, fence } = await claimLeaderless();

      const release = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken,
        disposition,
      });
      expect(release.outcome).toBe('marked');

      // The row still blocks the key, so the retry is told who blocks it — but
      // the generation behind it is no longer live for new work, and above all
      // must not carry a lead designation through.
      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(retry.outcome).toBe('already-claimed');
      if (retry.outcome !== 'already-claimed') return;
      expect(retry.holder.claimToken).toBe(claimToken);
      expect(retry.holder.status).toBe(disposition);

      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId ?? null).toBeNull();

      // The refusal wrote nothing either: no new generation, no fence move.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimToken).toBe(claimToken);
      expect(listed.claims[0]?.fence).toBe(fence);
      expect(listed.claims[0]?.status).toBe(disposition);
    }

    it('reports already-claimed and designates no lead when the generation is releasing', async () => {
      await expectRetryAfterMarkedRelease('releasing');
    });

    it('reports already-claimed and designates no lead when the generation is abandoned', async () => {
      await expectRetryAfterMarkedRelease('abandoned');
    });

    it('reports not-found with missing=agent when the agent has since moved to another session', async () => {
      const { sessionId, agentId, claimToken, fence } = await claimLeaderless();

      // A second, leaderless session the agent is moved into by a whole-record
      // write — the generation stays filed under the session it has left.
      const newSessionId = await seedSession();
      const stored = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...stored.agent!, sessionId: newSessionId },
      });
      const moved = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(moved.agent?.sessionId).toBe(newSessionId);

      // `settleCurrency` already refuses this generation, so a retry that called
      // it idempotent would designate a lead whose currency nothing may publish.
      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(retry.outcome).toBe('not-found');
      if (retry.outcome !== 'not-found') return;
      expect(retry.missing).toBe('agent');

      // Neither session was given a lead …
      const oldSession = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(oldSession.session?.leadAgentId ?? null).toBeNull();
      const newSession = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: newSessionId });
      expect(newSession.session?.leadAgentId ?? null).toBeNull();

      // … and the claim row stands exactly as it did.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimToken).toBe(claimToken);
      expect(listed.claims[0]?.sessionId).toBe(sessionId);
      expect(listed.claims[0]?.fence).toBe(fence);
      expect(listed.claims[0]?.status).toBe('held');
    });

    it('still reports idempotent and promotes a healthy retry that revalidates cleanly', async () => {
      const { sessionId, agentId, claimToken, fence } = await claimLeaderless();

      // Nothing about the generation changed, so the revalidation must pass the
      // retry through untouched — token uniqueness included: the row the retry
      // names carries the caller's own token, which is not a reused one.
      const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'healthy-retry', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(settled.outcome).toBe('settled');

      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });

      expect(retry.outcome).toBe('idempotent');
      if (retry.outcome !== 'idempotent') return;
      expect(requireClaim(retry.claim).claimToken).toBe(claimToken);
      expect(requireClaim(retry.claim).fence).toBe(fence);
      expect(retry.leadDesignated).toBe(true);

      // The promotion still mirrors the new lead's currency onto the session.
      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(agentId);
      expect(sessionResult.session?.currentAdapterSessionId).toBe('healthy-retry');
      expect(sessionResult.session?.currentAdapterSessionIdState).toBe('confirmed');
    });
  });

  // ─── claim: ownership decided before designation ───────────────────────────────────────────────────────────────

  describe('claim — precedence', () => {
    it('returns already-claimed when key is held by another generation AND lead expectation is wrong', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const otherAgentId = await seedAgent(sessionId);

      // First: claim as otherAgent and designate as lead
      const firstToken = crypto.randomUUID();
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(otherAgentId, sessionId, firstToken),
        designateLead: { expectedLeadAgentId: null },
      });

      // Second: agentId tries same key with wrong lead expectation
      // Precedence rule: already-claimed beats lead-conflict
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        designateLead: { expectedLeadAgentId: null }, // would be wrong, but never evaluated
      });

      expect(result.outcome).toBe('already-claimed');
      if (result.outcome !== 'already-claimed') return;
      expect(result.holder.agentId).toBe(otherAgentId);
      expect(result.holder.claimToken).toBe(firstToken);

      // The designation was never evaluated, so it also wrote nothing.
      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.leadAgentId).toBe(otherAgentId);
    });
  });

  // ─── claim: takeover ───────────────────────────────────────────────────────────────────────────────────────────

  describe('claim — takeover', () => {
    it('atomically retokenizes a guarded recovery, moves status to starting, and fences the old owner', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const ownerInstanceId = `instance-${crypto.randomUUID()}`;
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'recover-key',
          ownerInstanceId,
        ),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;
      const firstClaim = requireClaim(first.claim);
      const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(before.ownership).not.toBeNull();
      if (before.ownership === null) return;

      const recovered = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'recover-key',
          ownerInstanceId,
        ),
        recoveryAttemptId: crypto.randomUUID(),
        recoveryGuard: {
          expectedStatus: 'idle' as const,
          expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
          expectedRevision: before.ownership.revision,
          expectedCurrencyFence: before.ownership.currencyFence,
          expectedCurrency: before.ownership.currency,
          ownerGeneration: {
            claimId: firstClaim.claimId,
            claimToken: firstClaim.claimToken,
            fence: firstClaim.fence,
            ownerInstanceId: firstClaim.ownerInstanceId,
            status: firstClaim.status,
          },
        },
      });

      expect(recovered.outcome).toBe('claimed');
      if (recovered.outcome !== 'claimed') return;
      const recoveredClaim = requireClaim(recovered.claim);
      expect(recoveredClaim.claimToken).not.toBe(firstClaim.claimToken);
      expect(recoveredClaim.fence).toBeGreaterThan(firstClaim.fence);
      const agent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(agent.agent?.status).toBe('starting');

      const lateSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: firstClaim.claimToken,
        fence: firstClaim.fence,
        expectedRevision: before.ownership.revision,
        target: INHERITED_TARGET,
      });
      expect(lateSettle.outcome).toBe('not-owner');
    });

    it('refuses stale recovery currency without changing status, claims, or runtime identities', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;
      const firstClaim = requireClaim(first.claim);
      const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(before.ownership).not.toBeNull();
      if (before.ownership === null) return;
      const unallocatedOwner = `instance-${crypto.randomUUID()}`;

      for (const stale of [
        { expectedRevision: before.ownership.revision + 1, expectedCurrencyFence: before.ownership.currencyFence },
        { expectedRevision: before.ownership.revision, expectedCurrencyFence: before.ownership.currencyFence + 1 },
      ]) {
        const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
          ...buildClaimRequest(
            agentId,
            sessionId,
            crypto.randomUUID(),
            'machine-1',
            'adapter-1',
            'provider-session-1',
            unallocatedOwner,
          ),
          recoveryAttemptId: crypto.randomUUID(),
          recoveryGuard: {
            expectedStatus: 'idle' as const,
            expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
            ...stale,
            expectedCurrency: before.ownership.currency,
            ownerGeneration: {
              claimId: firstClaim.claimId,
              claimToken: firstClaim.claimToken,
              fence: firstClaim.fence,
              ownerInstanceId: firstClaim.ownerInstanceId,
              status: firstClaim.status,
            },
          },
        });
        expect(result.outcome).toBe('currency-changed');
      }

      const after = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(after.ownership).toEqual(before.ownership);
      const agent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(agent.agent?.status).toBe('idle');
      const runtime = await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: unallocatedOwner,
        machineId: 'machine-1',
      });
      expect(runtime.instance).toBeNull();
    });

    it('refuses every mismatched expected preimage field without mutating either ownership or the agent row', async () => {
      const sessionId = await seedSession();
      const agentId = `agent-${crypto.randomUUID()}`;
      const priorBinding = { machineId: 'prior-machine', instanceId: 'prior-owner' };
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: createAgent({
          agentId,
          sessionId,
          adapterId: 'adapter-1',
          runtimeOwner: priorBinding,
          recoveryAttemptId: 'prior-attempt',
        }),
      });
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'preimage-key'),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;
      const firstClaim = requireClaim(first.claim);
      const beforeOwnership = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      const beforeAgent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(beforeOwnership.ownership).not.toBeNull();
      expect(beforeAgent.agent).not.toBeNull();
      if (beforeOwnership.ownership === null || beforeAgent.agent === null) return;

      const basePreimage = {
        status: 'idle' as const,
        adapterId: 'adapter-1',
        binding: {
          adapterId: 'adapter-1',
          ownerMachineId: priorBinding.machineId,
          ownerInstanceId: priorBinding.instanceId,
        },
        recoveryAttemptId: 'prior-attempt',
      };
      const mismatches = [
        {
          ...basePreimage,
          adapterId: 'other-adapter',
          binding: { ...basePreimage.binding, adapterId: 'other-adapter' },
        },
        { ...basePreimage, binding: { ...basePreimage.binding, ownerInstanceId: 'other-owner' } },
        { ...basePreimage, recoveryAttemptId: 'other-attempt' },
      ];

      for (const expectedPreimage of mismatches) {
        const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
          ...buildClaimRequest(
            agentId,
            sessionId,
            crypto.randomUUID(),
            'machine-1',
            'adapter-1',
            'preimage-key',
            `new-owner-${crypto.randomUUID()}`,
          ),
          recoveryAttemptId: crypto.randomUUID(),
          recoveryGuard: {
            expectedStatus: 'idle',
            expectedPreimage,
            expectedRevision: beforeOwnership.ownership.revision,
            expectedCurrencyFence: beforeOwnership.ownership.currencyFence,
            expectedCurrency: beforeOwnership.ownership.currency,
            ownerGeneration: {
              claimId: firstClaim.claimId,
              claimToken: firstClaim.claimToken,
              fence: firstClaim.fence,
              ownerInstanceId: firstClaim.ownerInstanceId,
              status: firstClaim.status,
            },
          },
        });
        expect(result.outcome).toBe('recovery-conflict');
        expect(await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId })).toEqual(beforeOwnership);
        expect(await MakaioBus.request(AgentStorageSubjects.get, { agentId })).toEqual(beforeAgent);
      }
    });

    it('refuses an ABA-stale owner generation and preserves the replacement generation', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const ownerInstanceId = `instance-${crypto.randomUUID()}`;
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'aba-key',
          ownerInstanceId,
        ),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;
      const firstClaim = requireClaim(first.claim);
      const observed = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(observed.ownership).not.toBeNull();
      if (observed.ownership === null) return;

      const replacement = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'aba-key',
          ownerInstanceId,
        ),
      );
      expect(replacement.outcome).toBe('claimed');
      if (replacement.outcome !== 'claimed') return;

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'aba-key',
          ownerInstanceId,
        ),
        recoveryAttemptId: crypto.randomUUID(),
        recoveryGuard: {
          expectedStatus: 'idle' as const,
          expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
          expectedRevision: observed.ownership.revision,
          expectedCurrencyFence: observed.ownership.currencyFence,
          expectedCurrency: observed.ownership.currency,
          ownerGeneration: {
            claimId: firstClaim.claimId,
            claimToken: firstClaim.claimToken,
            fence: firstClaim.fence,
            ownerInstanceId: firstClaim.ownerInstanceId,
            status: firstClaim.status,
          },
        },
      });
      expect(result.outcome).toBe('recovery-conflict');

      const after = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(after.ownership?.claims).toEqual([replacement.claim]);
      const agent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(agent.agent?.status).toBe('idle');
    });

    it('rejects a guarded takeover that also tries to designate a lead', async () => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const leadAgentId = await seedAgent(sessionId);
      const lead = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(leadAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'lead-key'),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(lead.outcome).toBe('claimed');

      const ownerInstanceId = `instance-${crypto.randomUUID()}`;
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'rollback-key',
          ownerInstanceId,
        ),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;
      const firstClaim = requireClaim(first.claim);
      const observed = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(observed.ownership).not.toBeNull();
      if (observed.ownership === null) return;

      await expect(
        MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
          ...buildClaimRequest(
            agentId,
            sessionId,
            crypto.randomUUID(),
            'machine-1',
            'adapter-1',
            'rollback-key',
            ownerInstanceId,
          ),
          designateLead: { expectedLeadAgentId: null },
          recoveryAttemptId: crypto.randomUUID(),
          recoveryGuard: {
            expectedStatus: 'idle' as const,
            expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
            expectedRevision: observed.ownership.revision,
            expectedCurrencyFence: observed.ownership.currencyFence,
            expectedCurrency: observed.ownership.currency,
            ownerGeneration: {
              claimId: firstClaim.claimId,
              claimToken: firstClaim.claimToken,
              fence: firstClaim.fence,
              ownerInstanceId: firstClaim.ownerInstanceId,
              status: firstClaim.status,
            },
          },
        }),
      ).rejects.toThrow('guarded recovery claim cannot designate');

      const after = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(after.ownership).toEqual(observed.ownership);
      const agent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(agent.agent?.status).toBe('idle');
    });

    it('accepts supersedes and returns claimed with a strictly higher fence and new token', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();
      const takeoverToken = crypto.randomUUID();

      const firstResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, firstToken),
      );
      expect(firstResult.outcome).toBe('claimed');
      if (firstResult.outcome !== 'claimed') return;
      const firstFence = requireClaim(firstResult.claim).fence;

      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, takeoverToken),
        supersedes: { claimToken: firstToken },
      });

      expect(takeover.outcome).toBe('claimed');
      if (takeover.outcome !== 'claimed') return;
      expect(requireClaim(takeover.claim).fence).toBeGreaterThan(firstFence);
      expect(requireClaim(takeover.claim).claimToken).toBe(takeoverToken);
      expect(requireClaim(takeover.claim).claimToken).not.toBe(firstToken);
    });

    it('returns already-claimed when supersedes carries a stale token', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();
      const takeoverToken = crypto.randomUUID();
      const staleSupersedes = crypto.randomUUID(); // not the current holder

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, buildClaimRequest(agentId, sessionId, firstToken));

      const held = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(held.claims).toHaveLength(1);

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, takeoverToken),
        supersedes: { claimToken: staleSupersedes },
      });

      expect(result.outcome).toBe('already-claimed');
      if (result.outcome !== 'already-claimed') return;
      expect(result.holder.claimToken).toBe(firstToken);

      // The failed takeover wrote nothing: the held generation keeps its token
      // and its fence.
      const after = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(after.claims).toHaveLength(1);
      expect(after.claims[0]?.claimToken).toBe(firstToken);
      expect(after.claims[0]?.fence).toBe(held.claims[0]?.fence);
    });

    it('returns not-found with missing=agent when the takeover names an unknown agent', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const heldToken = crypto.randomUUID();
      const unknownAgentId = `agent-${crypto.randomUUID()}`;

      const held = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, heldToken),
      );
      expect(held.outcome).toBe('claimed');

      // The takeover repoints the row at an agent that does not exist: a modeled
      // not-found, never a foreign-key failure from the underlying store.
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(unknownAgentId, sessionId, crypto.randomUUID()),
        supersedes: { claimToken: heldToken },
      });

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('agent');

      // The generation that held the key is untouched.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimToken).toBe(heldToken);
      expect(listed.claims[0]?.agentId).toBe(agentId);
    });

    it('returns not-found with missing=session when the takeover names an unknown session', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const heldToken = crypto.randomUUID();
      const unknownSessionId = `session-${crypto.randomUUID()}`;

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, buildClaimRequest(agentId, sessionId, heldToken));

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, unknownSessionId, crypto.randomUUID()),
        supersedes: { claimToken: heldToken },
      });

      expect(result.outcome).toBe('not-found');
      if (result.outcome !== 'not-found') return;
      expect(result.missing).toBe('session');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimToken).toBe(heldToken);
    });

    it('allocates the takeover fence above the taking agent’s currency fence, not just the superseded row’s', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const otherAgentId = await seedAgent(sessionId);

      // What this pins is the *floor* the allocating statement computes: the
      // taker's own `currency_fence` bounds a takeover even when the superseded
      // row and every live claim of the taker sit below it, and the generation
      // that results can actually settle. It does not pin the interleaving that
      // motivated computing the floor in-statement — a concurrent settle landing
      // between a pre-read and the takeover cannot be steered through the public
      // API. That window has no test anywhere; it is closed by construction
      // alone (the floor is a subquery of the write), so a regression back to a
      // pre-read floor would surface only in review, not in CI. The conformance
      // suite's per-agent fence race covers a different seam: the allocation
      // lock serializing two fresh claims.
      //
      // The taker raises its own currency fence on keys it then gives up, so at
      // takeover time neither the superseded row nor any live claim of its own
      // still bounds the allocation — only `currency_fence` does.
      let revision = 0;
      for (const providerSessionId of ['fence-key-a', 'fence-key-b']) {
        const token = crypto.randomUUID();
        const claim = await MakaioBus.request(
          SessionOwnershipStorageSubjects.claim,
          buildClaimRequest(agentId, sessionId, token, 'machine-1', 'adapter-1', providerSessionId),
        );
        expect(claim.outcome).toBe('claimed');
        if (claim.outcome !== 'claimed') return;

        const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
          agentId,
          claimToken: token,
          fence: requireClaim(claim.claim).fence,
          expectedRevision: revision,
          target: { currentAdapterSessionId: providerSessionId, currentAdapterSessionIdState: 'confirmed' as const },
        });
        expect(settled.outcome).toBe('settled');
        if (settled.outcome !== 'settled') return;
        revision = settled.revision;

        await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
          agentId,
          claimToken: token,
          disposition: 'released' as const,
        });
      }

      const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      const currencyFence = before.ownership?.currencyFence ?? 0;
      expect(currencyFence).toBeGreaterThan(0);
      expect(before.ownership?.claims).toHaveLength(0);

      // A third party holds the key at a fence of its own, well below the
      // taker's currency fence.
      const heldToken = crypto.randomUUID();
      const held = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(otherAgentId, sessionId, heldToken, 'machine-1', 'adapter-1', 'fence-key-c'),
      );
      expect(held.outcome).toBe('claimed');
      if (held.outcome !== 'claimed') return;
      expect(requireClaim(held.claim).fence).toBeLessThanOrEqual(currencyFence);

      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'fence-key-c'),
        supersedes: { claimToken: heldToken },
      });
      expect(takeover.outcome).toBe('claimed');
      if (takeover.outcome !== 'claimed') return;

      // The floor is the taker's own currency fence, not the row it superseded.
      expect(requireClaim(takeover.claim).fence).toBe(currencyFence + 1);

      // Which is the whole point: the generation this call just took must be
      // able to write the currency it was taken for.
      const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: requireClaim(takeover.claim).claimToken,
        fence: requireClaim(takeover.claim).fence,
        expectedRevision: revision,
        target: { currentAdapterSessionId: 'after-takeover', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(settled.outcome).toBe('settled');
    });

    it('restores every column of the superseded generation when the takeover’s lead designation conflicts', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const otherAgentId = await seedAgent(sessionId);

      // The holder is also the session's lead, so a takeover expecting a
      // leaderless session conflicts.
      const heldToken = crypto.randomUUID();
      const held = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, heldToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(held.outcome).toBe('claimed');
      if (held.outcome !== 'claimed') return;

      // A *different* agent, under a different adapter name, takes the key over,
      // so a partial rollback would leave an observably foreign row behind.
      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(otherAgentId, sessionId, crypto.randomUUID()),
        adapterName: 'other-adapter',
        supersedes: { claimToken: heldToken },
        designateLead: { expectedLeadAgentId: null },
      });

      expect(takeover.outcome).toBe('lead-conflict');
      if (takeover.outcome !== 'lead-conflict') return;
      expect(takeover.currentLeadAgentId).toBe(agentId);

      // Nothing was written: the superseded generation still stands exactly as
      // it did — all seven mutated columns included.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
        adapterId: 'adapter-1',
      });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]).toEqual(held.claim);
    });
  });

  // ─── claim: fence allocation ───────────────────────────────────────────────────────────────────────────────────

  describe('claim — fence allocation across keys', () => {
    it('allocates fence > agent currencyFence when re-claiming a different key after settle', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const token1 = crypto.randomUUID();

      // Claim key1
      const claim1 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token1, 'machine-1', 'adapter-1', 'prov-1'),
      );
      expect(claim1.outcome).toBe('claimed');
      if (claim1.outcome !== 'claimed') return;

      // Settle currency under fence 1 to advance the agent's currencyFence to 1
      const settleResult = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: token1,
        fence: requireClaim(claim1.claim).fence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });
      expect(settleResult.outcome).toBe('settled');

      // Release key1
      await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken: token1,
        disposition: 'released',
      });

      // Claim key2 — fence must be above agent's currencyFence (which is 1), so >= 2
      const token2 = crypto.randomUUID();
      const claim2 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token2, 'machine-1', 'adapter-1', 'prov-2'),
      );
      expect(claim2.outcome).toBe('claimed');
      if (claim2.outcome !== 'claimed') return;
      // currencyFence is 1 and no claim is live, so the allocation is exactly 2.
      expect(requireClaim(claim2.claim).fence).toBe(2);
    });

    it('allocates a strictly higher fence for a second key held at the same time', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const token1 = crypto.randomUUID();
      const token2 = crypto.randomUUID();

      const claim1 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token1, 'machine-two', 'adapter-1', 'prov-1'),
      );
      expect(claim1.outcome).toBe('claimed');
      if (claim1.outcome !== 'claimed') return;
      expect(requireClaim(claim1.claim).fence).toBe(1);

      // Nothing has settled, so `currencyFence` is still 0 — the live claim is
      // the only thing that can lift the allocation.
      const claim2 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token2, 'machine-two', 'adapter-1', 'prov-2'),
      );
      expect(claim2.outcome).toBe('claimed');
      if (claim2.outcome !== 'claimed') return;
      expect(requireClaim(claim2.claim).fence).toBe(requireClaim(claim1.claim).fence + 1);

      // Settling under the second generation moves the agent's currency fence
      // above the first one …
      const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: token2,
        fence: requireClaim(claim2.claim).fence,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'second-key', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(settled.outcome).toBe('settled');

      // … so the first generation, whose claim row is still held, is refused by
      // comparison rather than by absence.
      const late = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: token1,
        fence: requireClaim(claim1.claim).fence,
        expectedRevision: 1,
        target: { currentAdapterSessionId: 'first-key', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(late.outcome).toBe('superseded');
      if (late.outcome !== 'superseded') return;
      expect(late.currentFence).toBe(requireClaim(claim2.claim).fence);

      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBe('second-key');
    });
  });

  // ─── settleCurrency: the write lands ───────────────────────────────────────────────────────────────────────────

  describe('settleCurrency — happy path', () => {
    it('returns settled, increments revision, and read reflects new currency', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;

      const settleResult = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claimResult.claim).fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'confirmed-id',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      expect(settleResult.outcome).toBe('settled');
      if (settleResult.outcome !== 'settled') return;
      expect(settleResult.revision).toBe(1);
      expect(settleResult.currency.currentAdapterSessionId).toBe('confirmed-id');
      expect(settleResult.currency.currentAdapterSessionIdState).toBe('confirmed');

      // Verify read reflects the new state
      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership).not.toBeNull();
      expect(readResult.ownership?.revision).toBe(1);
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBe('confirmed-id');
      expect(readResult.ownership?.currency.currentAdapterSessionIdState).toBe('confirmed');
    });

    it('resolveResumableAdapterSessionId yields the correct target for all three states', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const adapterSessionId = 'origin-session';

      // Give the agent an adapterSessionId (origin identity)
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
        agentId,
        adapterSessionId,
      });

      const claimToken = crypto.randomUUID();
      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;
      const fence = requireClaim(claimResult.claim).fence;

      // --- inherited ---
      const inheritedSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });
      expect(inheritedSettle.outcome).toBe('settled');
      if (inheritedSettle.outcome !== 'settled') return;
      expect(resolveResumableAdapterSessionId(inheritedSettle.currency)).toBe(adapterSessionId);

      // --- confirmed ---
      const confirmedSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 1,
        target: {
          currentAdapterSessionId: 'new-session-id',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });
      expect(confirmedSettle.outcome).toBe('settled');
      if (confirmedSettle.outcome !== 'settled') return;
      expect(resolveResumableAdapterSessionId(confirmedSettle.currency)).toBe('new-session-id');

      // --- moved ---
      const movedSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 2,
        target: {
          currentAdapterSessionId: null,
          currentAdapterSessionIdState: 'moved' as const,
        },
      });
      expect(movedSettle.outcome).toBe('settled');
      if (movedSettle.outcome !== 'settled') return;
      expect(resolveResumableAdapterSessionId(movedSettle.currency)).toBeNull();
    });
  });

  // ─── settleCurrency: repeated target ───────────────────────────────────────────────────────────────────────────

  describe('settleCurrency — idempotent', () => {
    it('returns idempotent on the same target under the same fence and leaves revision unchanged', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();
      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;
      const fence = requireClaim(claimResult.claim).fence;

      const first = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });
      expect(first.outcome).toBe('settled');
      if (first.outcome !== 'settled') return;
      const revAfterFirst = first.revision;

      // Same target, same fence, same (now-stale) expectedRevision — must be idempotent
      const second = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: revAfterFirst,
        target: INHERITED_TARGET,
      });

      expect(second.outcome).toBe('idempotent');
      if (second.outcome !== 'idempotent') return;
      expect(second.revision).toBe(revAfterFirst);
      expect(second.sessionSnapshotUpdated).toBe(false);
    });
  });

  // ─── settleCurrency: lost race within a generation ─────────────────────────────────────────────────────────────

  describe('settleCurrency — out-of-order', () => {
    it('lets the first writer win and rejects the second with currency-changed', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();
      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;
      const fence = requireClaim(claimResult.claim).fence;

      // Both settlers read the same revision=0 before either writes
      const settleA = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'session-A',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });
      expect(settleA.outcome).toBe('settled');

      // Second settler also uses expectedRevision=0 (stale)
      const settleB = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'session-B',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      expect(settleB.outcome).toBe('currency-changed');
      if (settleB.outcome !== 'currency-changed') return;
      // The stored currency must reflect the first writer's value, not B's
      expect(settleB.currency.currentAdapterSessionId).toBe('session-A');
      expect(settleB.revision).toBe(1);

      // Verify the read also shows A's value
      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBe('session-A');
    });
  });

  // ─── settleCurrency: superseded generations ────────────────────────────────────────────────────────────────────

  describe('settleCurrency — stale owner after takeover', () => {
    it('rejects the superseded generation as not-owner once the takeover reused its claim row', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();
      const takeoverToken = crypto.randomUUID();

      const firstClaim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, firstToken),
      );
      expect(firstClaim.outcome).toBe('claimed');
      if (firstClaim.outcome !== 'claimed') return;
      const firstFence = requireClaim(firstClaim.claim).fence;

      // Take over
      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, takeoverToken),
        supersedes: { claimToken: firstToken },
      });
      expect(takeover.outcome).toBe('claimed');
      if (takeover.outcome !== 'claimed') return;
      const newFence = requireClaim(takeover.claim).fence;
      expect(newFence).toBeGreaterThan(firstFence);

      // Stale owner tries to settle under the old fence
      const staleSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: firstToken,
        fence: firstFence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });

      // Authority is decided before order: the takeover rewrote the row the old
      // generation was named by, so there is no claim left to compare fences
      // against and the caller is simply not the owner.
      expect(staleSettle.outcome).toBe('not-owner');

      // Verify nothing was written: revision must still be 0
      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.revision).toBe(0);
    });

    it('reports superseded when the stale generation still holds a claim below the currency fence', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const staleToken = crypto.randomUUID();
      const movedToken = crypto.randomUUID();
      const takeoverToken = crypto.randomUUID();

      // The agent holds two claims at once — the state a movement passes through
      // between claim-new and release-old.
      const stale = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, staleToken, 'machine-1', 'adapter-1', 'prov-stale'),
      );
      expect(stale.outcome).toBe('claimed');
      if (stale.outcome !== 'claimed') return;

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, movedToken, 'machine-1', 'adapter-1', 'prov-moved'),
      );

      // Take the moved key over so its fence rises above the stale generation's,
      // then settle under it to move the agent's currency fence with it.
      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, takeoverToken, 'machine-1', 'adapter-1', 'prov-moved'),
        supersedes: { claimToken: movedToken },
      });
      expect(takeover.outcome).toBe('claimed');
      if (takeover.outcome !== 'claimed') return;
      expect(requireClaim(takeover.claim).fence).toBeGreaterThan(requireClaim(stale.claim).fence);

      const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: takeoverToken,
        fence: requireClaim(takeover.claim).fence,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'moved-session', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(settled.outcome).toBe('settled');

      // The stale generation's claim row still exists, so the refusal names the
      // fence that outranked it rather than denying ownership outright.
      const staleSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: staleToken,
        fence: requireClaim(stale.claim).fence,
        expectedRevision: 1,
        target: { currentAdapterSessionId: 'stale-session', currentAdapterSessionIdState: 'confirmed' as const },
      });

      expect(staleSettle.outcome).toBe('superseded');
      if (staleSettle.outcome !== 'superseded') return;
      expect(staleSettle.currentFence).toBe(requireClaim(takeover.claim).fence);

      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBe('moved-session');
    });

    it('fence rejection survives release + re-claim of the key (fence lives on the agent row)', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();
      const takeoverToken = crypto.randomUUID();
      const reClaimToken = crypto.randomUUID();

      // Step 1: initial claim (fence 1)
      const claim1 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, firstToken),
      );
      expect(claim1.outcome).toBe('claimed');
      if (claim1.outcome !== 'claimed') return;
      const fence1 = requireClaim(claim1.claim).fence;

      // Step 2: takeover (fence 2)
      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, takeoverToken),
        supersedes: { claimToken: firstToken },
      });
      expect(takeover.outcome).toBe('claimed');
      if (takeover.outcome !== 'claimed') return;

      // Settle under takeover fence to advance agent's currencyFence
      const settle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: takeoverToken,
        fence: requireClaim(takeover.claim).fence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });
      expect(settle.outcome).toBe('settled');

      // Step 3: release the key
      await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken: takeoverToken,
        disposition: 'released',
      });

      // Step 4: re-claim the key with a new token — fence must be higher than agent's currencyFence
      const reClaim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, reClaimToken),
      );
      expect(reClaim.outcome).toBe('claimed');
      if (reClaim.outcome !== 'claimed') return;
      const newFence = requireClaim(reClaim.claim).fence;

      // Step 5: stale owner (generation 1) still cannot write
      const staleSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: firstToken,
        fence: fence1,
        expectedRevision: 1, // after the settled revision
        target: {
          currentAdapterSessionId: 'stale-id',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });
      // Must be rejected: first generation's fence is below agent's currencyFence
      expect(staleSettle.outcome).toBe('not-owner'); // token is gone, so not-owner
      // The re-claim is allocated exactly one above the fence that wrote the
      // agent's currency — the key's own history was released with its row.
      expect(newFence).toBe(requireClaim(takeover.claim).fence + 1);
      expect(newFence).toBeGreaterThan(fence1);
    });
  });

  // ─── settleCurrency: no authority ──────────────────────────────────────────────────────────────────────────────

  describe('settleCurrency — not-owner', () => {
    it('returns not-found for an unknown agentId, distinguishing it from not-owner', async () => {
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: `agent-${crypto.randomUUID()}`,
        claimToken: crypto.randomUUID(),
        fence: 1,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });

      // The agent row is what is missing — `not-owner` would claim the agent
      // exists and the caller merely lacks authority over it.
      expect(result.outcome).toBe('not-found');
    });

    it('returns not-owner for an unknown claimToken', async () => {
      const { agentId } = await seedSessionAndAgent();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: 'unknown-token',
        fence: 1,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });

      expect(result.outcome).toBe('not-owner');
    });

    it('returns not-owner when claimToken is held by a different agent', async () => {
      const sessionId = await seedSession();
      const agentId1 = await seedAgent(sessionId);
      const agentId2 = await seedAgent(sessionId);

      const claimToken = crypto.randomUUID();
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId1, sessionId, claimToken),
      );

      // agentId2 tries to settle under agentId1's token
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: agentId2,
        claimToken,
        fence: 1,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });

      expect(result.outcome).toBe('not-owner');
    });

    it('returns not-owner when claim status is releasing', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, buildClaimRequest(agentId, sessionId, claimToken));

      // Mark the claim as releasing
      await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken,
        disposition: 'releasing',
      });

      // Attempt to settle under a releasing claim
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: 1,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });

      expect(result.outcome).toBe('not-owner');
    });

    it('returns not-owner when claim status is abandoned', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, buildClaimRequest(agentId, sessionId, claimToken));

      await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken,
        disposition: 'abandoned',
      });

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: 1,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });

      expect(result.outcome).toBe('not-owner');
    });

    it('returns not-owner when the claim is live but carries a different fence than the caller named', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      const claim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      // Authority is the pair token + fence. The token is live, but no
      // generation ever carried it at this fence, so the pair does not exist.
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claim.claim).fence + 1,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'never-settled', currentAdapterSessionIdState: 'confirmed' as const },
      });

      // Pins the verdict for a fence mismatch on a live token: `not-owner`, and
      // specifically not `superseded` — nothing outranked this caller, and the
      // only fence a `superseded` could report here is the agent's own
      // `currencyFence` (0), which is *below* the fence the caller presented and
      // therefore a bound no caller could act on.
      expect(result.outcome).toBe('not-owner');

      // And nothing was written.
      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.revision).toBe(0);
      expect(readResult.ownership?.currencyFence).toBe(0);
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBeNull();
    });
  });

  // ─── settleCurrency: session snapshot mirroring ────────────────────────────────────────────────────────────────

  describe('settleCurrency — lead vs member snapshot', () => {
    it('updates the session row when the settling agent is the session lead', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      // Claim and designate as lead
      const claimResult = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;

      const settleResult = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claimResult.claim).fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'lead-session',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      expect(settleResult.outcome).toBe('settled');
      if (settleResult.outcome !== 'settled') return;
      expect(settleResult.sessionSnapshotUpdated).toBe(true);

      // The session row should reflect the lead's currency
      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.currentAdapterSessionId).toBe('lead-session');
      expect(sessionResult.session?.currentAdapterSessionIdState).toBe('confirmed');
    });

    it('does NOT update the session row when the settling agent is a member', async () => {
      const sessionId = await seedSession();
      const leadAgentId = await seedAgent(sessionId);
      const memberAgentId = await seedAgent(sessionId);

      // Lead takes key1 and designates itself
      const leadToken = crypto.randomUUID();
      const leadClaim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(leadAgentId, sessionId, leadToken, 'machine-1', 'adapter-1', 'prov-lead'),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(leadClaim.outcome).toBe('claimed');

      // Member takes key2 (no designateLead)
      const memberToken = crypto.randomUUID();
      const memberClaim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(memberAgentId, sessionId, memberToken, 'machine-1', 'adapter-2', 'prov-member'),
      );
      expect(memberClaim.outcome).toBe('claimed');
      if (memberClaim.outcome !== 'claimed') return;

      // Member settles
      const memberSettle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: memberAgentId,
        claimToken: memberToken,
        fence: requireClaim(memberClaim.claim).fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'member-session',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      expect(memberSettle.outcome).toBe('settled');
      if (memberSettle.outcome !== 'settled') return;
      expect(memberSettle.sessionSnapshotUpdated).toBe(false);

      // Session row must NOT have member's currency. The contract does not pin
      // undefined-vs-null on this read-back surface, so both spell "unset".
      const sessionResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(sessionResult.session?.currentAdapterSessionId ?? null).toBeNull();

      // Member agent row IS updated independently
      const memberRead = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId: memberAgentId });
      expect(memberRead.ownership?.currency.currentAdapterSessionId).toBe('member-session');
    });

    it('resolves an inherited settle onto the session row instead of copying it', async () => {
      // The two rows carry *different* origins, which is the only situation in
      // which a mirror that copies the pair verbatim is observable: `inherited`
      // resolves against the reading row's own origin, so copying it onto the
      // session makes the session resolve to origin B while its lead resolves to
      // origin A. Against a verbatim mirror this test fails on the last
      // assertion, reporting the session's own origin.
      const sessionOrigin = `session-origin-${crypto.randomUUID()}`;
      const leadOrigin = `lead-origin-${crypto.randomUUID()}`;
      const sessionId = `session-${crypto.randomUUID()}`;
      const agentId = `agent-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: createSession({ sessionId, adapterSessionId: sessionOrigin }),
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: createAgent({ agentId, sessionId, adapterSessionId: leadOrigin }),
      });

      // Promote the member to lead. The designation already mirrors correctly;
      // the settle below is what this test is about.
      const claim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      // Settling `inherited` says "resume whatever I originally came from" — for
      // this lead that is origin A, not the session's origin B. The fence is
      // still 0 on the agent row, so this is a real write rather than an
      // idempotent no-op.
      const settled = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: requireClaim(claim.claim).claimToken,
        fence: requireClaim(claim.claim).fence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });
      expect(settled.outcome).toBe('settled');
      if (settled.outcome !== 'settled') return;
      expect(settled.sessionSnapshotUpdated).toBe(true);
      expect(resolveResumableAdapterSessionId(settled.currency)).toBe(leadOrigin);

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      const session = stored.session;
      expect(
        resolveResumableAdapterSessionId({
          adapterSessionId: session?.adapterSessionId ?? null,
          currentAdapterSessionId: session?.currentAdapterSessionId ?? null,
          currentAdapterSessionIdState: session?.currentAdapterSessionIdState ?? 'inherited',
        }),
      ).toBe(leadOrigin);
    });

    it('member can write confirmed → moved → confirmed independently of the lead', async () => {
      const sessionId = await seedSession();
      const memberAgentId = await seedAgent(sessionId);

      const memberToken = crypto.randomUUID();
      const memberClaim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(memberAgentId, sessionId, memberToken, 'machine-1', 'adapter-3', 'prov-m'),
      );
      expect(memberClaim.outcome).toBe('claimed');
      if (memberClaim.outcome !== 'claimed') return;
      const fence = requireClaim(memberClaim.claim).fence;

      // confirmed
      const c1 = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: memberAgentId,
        claimToken: memberToken,
        fence,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'sess-v1', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(c1.outcome).toBe('settled');
      if (c1.outcome !== 'settled') return;

      // moved
      const c2 = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: memberAgentId,
        claimToken: memberToken,
        fence,
        expectedRevision: c1.revision,
        target: { currentAdapterSessionId: null, currentAdapterSessionIdState: 'moved' as const },
      });
      expect(c2.outcome).toBe('settled');
      if (c2.outcome !== 'settled') return;

      // confirmed again
      const c3 = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: memberAgentId,
        claimToken: memberToken,
        fence,
        expectedRevision: c2.revision,
        target: { currentAdapterSessionId: 'sess-v2', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(c3.outcome).toBe('settled');
      if (c3.outcome !== 'settled') return;

      const memberRead = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId: memberAgentId });
      expect(memberRead.ownership?.currency.currentAdapterSessionId).toBe('sess-v2');
      expect(memberRead.ownership?.currency.currentAdapterSessionIdState).toBe('confirmed');
      expect(memberRead.ownership?.revision).toBe(c3.revision);
    });
  });

  // ─── release ───────────────────────────────────────────────────────────────────────────────────────────────────

  describe('release', () => {
    it('released disposition removes the row and frees the key for re-claim', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, buildClaimRequest(agentId, sessionId, firstToken));

      const releaseResult = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken: firstToken,
        disposition: 'released',
      });

      expect(releaseResult.outcome).toBe('released');

      // The row is gone, not merely marked.
      const afterRelease = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(afterRelease.claims).toHaveLength(0);

      // Key is free — nothing settled, so `currencyFence` is still 0 and no live
      // claim remains: the re-claim is allocated at exactly 1.
      const secondToken = crypto.randomUUID();
      const reClaim = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, secondToken),
      );
      expect(reClaim.outcome).toBe('claimed');
      if (reClaim.outcome !== 'claimed') return;
      expect(requireClaim(reClaim.claim).fence).toBe(1);
    });

    it('releasing disposition marks the row as releasing and keeps key blocked', async () => {
      const sessionId = await seedSession();
      const agentId1 = await seedAgent(sessionId);
      const agentId2 = await seedAgent(sessionId);

      const claimToken = crypto.randomUUID();
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId1, sessionId, claimToken),
      );

      const markResult = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId: agentId1,
        claimToken,
        disposition: 'releasing',
      });

      expect(markResult.outcome).toBe('marked');
      if (markResult.outcome !== 'marked') return;
      expect(requireClaim(markResult.claim).status).toBe('releasing');

      // Key is still blocked
      const competitorToken = crypto.randomUUID();
      const competitorResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId2, sessionId, competitorToken),
      );
      expect(competitorResult.outcome).toBe('already-claimed');
    });

    it('abandoned disposition marks the row and keeps key blocked', async () => {
      const sessionId = await seedSession();
      const agentId1 = await seedAgent(sessionId);
      const agentId2 = await seedAgent(sessionId);

      const claimToken = crypto.randomUUID();
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId1, sessionId, claimToken),
      );

      const markResult = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId: agentId1,
        claimToken,
        disposition: 'abandoned',
      });

      expect(markResult.outcome).toBe('marked');
      if (markResult.outcome !== 'marked') return;
      expect(requireClaim(markResult.claim).status).toBe('abandoned');

      // Still blocks: storage does not decide that an abandoned owner may be
      // displaced by a competitor that merely wants the key. Only a takeover
      // naming this row's token gets it.
      const competitorResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId2, sessionId, crypto.randomUUID()),
      );
      expect(competitorResult.outcome).toBe('already-claimed');
      if (competitorResult.outcome !== 'already-claimed') return;
      expect(competitorResult.holder.claimToken).toBe(claimToken);
      expect(competitorResult.holder.status).toBe('abandoned');
    });

    it('returns not-owner when agentId does not match the claim', async () => {
      const sessionId = await seedSession();
      const agentId1 = await seedAgent(sessionId);
      const agentId2 = await seedAgent(sessionId);

      const claimToken = crypto.randomUUID();
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId1, sessionId, claimToken),
      );

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId: agentId2,
        claimToken,
        disposition: 'released',
      });

      expect(result.outcome).toBe('not-owner');
      if (result.outcome !== 'not-owner') return;
      // The refusal names the real holder — the caller's next decision depends
      // on who that is.
      expect(result.holder.agentId).toBe(agentId1);
      expect(result.holder.claimToken).toBe(claimToken);

      // And the claim it could not take is untouched.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.status).toBe('held');
    });

    it('returns not-found for an unknown claimToken', async () => {
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId: 'any-agent',
        claimToken: 'nonexistent-token',
        disposition: 'released',
      });

      expect(result.outcome).toBe('not-found');
    });
  });

  // ─── listClaims ────────────────────────────────────────────────────────────────────────────────────────────────

  describe('listClaims', () => {
    it('filters by machineId and returns deterministic order', async () => {
      const sessionId = await seedSession();
      const agentAId = await seedAgent(sessionId);
      const agentBId = await seedAgent(sessionId);

      const tokenA = crypto.randomUUID();
      const tokenB = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentAId, sessionId, tokenA, 'machine-list', 'adapter-1', 'prov-a'),
      );
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentBId, sessionId, tokenB, 'machine-list', 'adapter-1', 'prov-b'),
      );

      // Claims for a different machine must not appear
      const agentCId = await seedAgent(sessionId);
      const tokenC = crypto.randomUUID();
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentCId, sessionId, tokenC, 'machine-other', 'adapter-1', 'prov-c'),
      );

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-list',
      });

      expect(result.claims).toHaveLength(2);
      expect(result.claims.every((c) => c.machineId === 'machine-list')).toBe(true);

      const ids = result.claims.map((c) => c.claimToken);
      expect(ids).toContain(tokenA);
      expect(ids).toContain(tokenB);

      // Deterministic order: claimedAt ASC then claimId ASC. Sorting a copy and
      // comparing pins the documented comparator rather than "some order".
      const sorted = [...result.claims].sort((a, b) => a.claimedAt - b.claimedAt || a.claimId.localeCompare(b.claimId));
      expect(result.claims).toEqual(sorted);
    });

    it('filters by adapterId', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const token1 = crypto.randomUUID();
      const token2 = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token1, 'machine-f', 'adapter-X', 'prov-1'),
      );
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token2, 'machine-f', 'adapter-Y', 'prov-2'),
      );

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-f',
        adapterId: 'adapter-X',
      });

      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.claimToken).toBe(token1);
    });

    it('filters by providerSessionId', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const token1 = crypto.randomUUID();
      const token2 = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token1, 'machine-p', 'adapter-1', 'prov-alpha'),
      );
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token2, 'machine-p', 'adapter-2', 'prov-beta'),
      );

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-p',
        providerSessionId: 'prov-alpha',
      });

      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.claimToken).toBe(token1);
    });

    it('filters by status', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const tokenHeld = crypto.randomUUID();
      const tokenAbandoned = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, tokenHeld, 'machine-s', 'adapter-1', 'prov-held'),
      );
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, tokenAbandoned, 'machine-s', 'adapter-2', 'prov-abandoned'),
      );
      await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken: tokenAbandoned,
        disposition: 'abandoned',
      });

      const heldResult = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-s',
        statuses: ['held'],
      });
      expect(heldResult.claims).toHaveLength(1);
      expect(heldResult.claims[0]!.status).toBe('held');

      const abandonedResult = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-s',
        statuses: ['abandoned'],
      });
      expect(abandonedResult.claims).toHaveLength(1);
      expect(abandonedResult.claims[0]!.status).toBe('abandoned');
    });
  });

  // ─── whole-record writes cannot resurrect ──────────────────────────────────────────────────────────────────────

  describe('whole-record writes cannot resurrect currency or claims', () => {
    it('storage:session.set with a pre-settlement snapshot leaves the mirrored currency untouched', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      const preSettleSnapshot = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session!;

      const claim = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      expect(claim.outcome).toBe('claimed');
      if (claim.outcome !== 'claimed') return;

      await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claim.claim).fence,
        expectedRevision: 0,
        target: { currentAdapterSessionId: 'mirrored-id', currentAdapterSessionIdState: 'confirmed' as const },
      });

      // A caller holding the session as it looked before the settlement writes
      // it back wholesale. The currency pair is not on `set` at all, so the
      // mirror must survive — otherwise any stale reader could resurrect a
      // provider session the lead has already moved away from.
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: { ...preSettleSnapshot, title: 'renamed' },
      });

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      // The allowed part of the write landed — a backend that refused the whole
      // record would satisfy the currency assertions for the wrong reason.
      expect(stored.session?.title).toBe('renamed');
      expect(stored.session?.currentAdapterSessionId).toBe('mirrored-id');
      expect(stored.session?.currentAdapterSessionIdState).toBe('confirmed');
    });

    it('storage:agent.set with a pre-movement snapshot leaves currency, revision and fence untouched', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      // Read the initial agent for the "pre-movement snapshot"
      const initialAgentResult = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      const preMoveSnapshot = initialAgentResult.agent!;

      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;

      // Settle to advance currency and revision
      await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claimResult.claim).fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'confirmed-target',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      // Attempt to overwrite with the pre-movement snapshot
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...preMoveSnapshot, status: 'active' }, // modified to not be a no-op
      });

      // The allowed part of the write must have landed — a backend that refused
      // the whole record would satisfy the assertions below for the wrong reason.
      const afterSet = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(afterSet.agent?.status).toBe('active');

      // Currency, revision, and fence must be unchanged
      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBe('confirmed-target');
      expect(readResult.ownership?.currency.currentAdapterSessionIdState).toBe('confirmed');
      expect(readResult.ownership?.revision).toBe(1);
      expect(readResult.ownership?.currencyFence).toBeGreaterThan(0);
    });

    it('storage:agent.updateRuntime cannot overwrite currency columns', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') return;

      await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence: requireClaim(claimResult.claim).fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'settled-id',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });

      // updateRuntime cannot touch currency columns (no such fields in the request schema)
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
        agentId,
        adapterId: 'adapter-updated',
      });

      // The field updateRuntime *may* write must have landed, so the assertions
      // below cannot pass on a backend that simply refused the call.
      const afterUpdate = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(afterUpdate.agent?.adapterId).toBe('adapter-updated');

      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBe('settled-id');
      expect(readResult.ownership?.revision).toBe(1);
    });

    it('storage:agent.set cannot overwrite the stored origin adapterSessionId', async () => {
      const sessionId = await seedSession();
      const agentId = `agent-${crypto.randomUUID()}`;

      // Fresh insert: there is no stored origin to protect, so the caller's wins.
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: createAgent({ agentId, sessionId, adapterSessionId: 'origin-1' }),
      });
      const inserted = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(inserted.agent?.adapterSessionId).toBe('origin-1');

      const stored = inserted.agent!;

      // Conflict upsert carrying a *different* origin — a stale snapshot.
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...stored, adapterSessionId: 'snapshot-origin', status: 'active' },
      });
      const afterStale = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(afterStale.agent?.adapterSessionId).toBe('origin-1');
      // The allowed part of the write must have landed — a backend that refused
      // the whole record would satisfy the origin assertion for the wrong reason.
      expect(afterStale.agent?.status).toBe('active');

      // Conflict upsert *omitting* the origin — identity enrichment, which
      // writes a record it never read the origin into.
      const { adapterSessionId: _neverRead, ...withoutOrigin } = stored;
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...withoutOrigin, status: 'idle' },
      });
      const afterAbsent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(afterAbsent.agent?.adapterSessionId).toBe('origin-1');
      expect(afterAbsent.agent?.status).toBe('idle');
    });

    it('storage:session.set with a pre-designation snapshot leaves the newer lead intact', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const preDesignationSnapshot = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session!;
      expect(preDesignationSnapshot.leadAgentId).toBeUndefined();

      const designated = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });
      expect(designated.outcome).toBe('claimed');

      // A caller holding the session as it looked before the designation writes
      // it back wholesale. The designation has exactly one writer — the
      // reserving transaction — so a snapshot that never observed it must not be
      // able to put the previous value back, nor to unset one.
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: { ...preDesignationSnapshot, title: 'renamed' },
      });

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      // The allowed part of the write landed — a backend that refused the whole
      // record would satisfy the designation assertion for the wrong reason.
      expect(stored.session?.title).toBe('renamed');
      expect(stored.session?.leadAgentId).toBe(agentId);

      // And a snapshot naming a *different* lead is refused the same way: `set`
      // has no expectation in it, so it may not redirect the session either.
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: { ...stored.session!, leadAgentId: 'some-other-agent' },
      });
      const afterForeign = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(afterForeign.session?.leadAgentId).toBe(agentId);
    });
  });

  // ─── settle authority is bound to the agent's current session ──────────────────────────────────────────────────

  describe('settleCurrency — claim session must match the agent’s session', () => {
    /**
     * Claim a key, then move the agent to a second session it leads, leaving the
     * claim filed under the session the agent has left.
     * @returns The stale generation and both sessions.
     */
    async function claimThenReassignSession(): Promise<{
      agentId: string;
      oldSessionId: string;
      newSessionId: string;
      claimToken: string;
      fence: number;
    }> {
      const { sessionId: oldSessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();
      const claimResult = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, oldSessionId, claimToken),
      );
      expect(claimResult.outcome).toBe('claimed');
      if (claimResult.outcome !== 'claimed') throw new Error('claim did not succeed');

      // A second session the agent leads, so a settle that slipped through would
      // publish the currency onto a session the claim's holder was never in.
      const newSessionId = `session-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: newSessionId,
        session: createSession({ sessionId: newSessionId, leadAgentId: agentId }),
      });

      const stored = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...stored.agent!, sessionId: newSessionId },
      });
      const moved = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(moved.agent?.sessionId).toBe(newSessionId);

      return { agentId, oldSessionId, newSessionId, claimToken, fence: requireClaim(claimResult.claim).fence };
    }

    it('returns not-owner and mirrors nothing when the claim names the session the agent left', async () => {
      const { agentId, newSessionId, claimToken, fence } = await claimThenReassignSession();

      const settle = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'cross-session-target',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      });
      expect(settle.outcome).toBe('not-owner');

      // The agent row is untouched: no currency, no revision bump, no fence move.
      const ownership = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(ownership.ownership?.currency.currentAdapterSessionId).toBeNull();
      expect(ownership.ownership?.currency.currentAdapterSessionIdState).toBe('inherited');
      expect(ownership.ownership?.revision).toBe(0);
      expect(ownership.ownership?.currencyFence).toBe(0);

      // And the session the agent now leads never saw the foreign generation's target.
      const newSession = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: newSessionId });
      expect(newSession.session?.currentAdapterSessionId ?? null).toBeNull();
      expect(newSession.session?.currentAdapterSessionIdState).toBe('inherited');
    });

    it('still lets the owner release that same stale claim', async () => {
      const { agentId, claimToken } = await claimThenReassignSession();

      // The asymmetry: settling under this generation is refused, but giving it
      // up is not — otherwise the ownership key would stay blocked forever.
      const release = await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId,
        claimToken,
        disposition: 'released' as const,
      });
      expect(release.outcome).toBe('released');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(listed.claims).toHaveLength(0);
    });
  });

  // ─── cascade ───────────────────────────────────────────────────────────────────────────────────────────────────

  describe('cascade', () => {
    it('deleting the session removes its claims', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken, 'machine-cascade'),
      );

      const beforeDelete = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-cascade',
      });
      expect(beforeDelete.claims).toHaveLength(1);

      await MakaioBus.request(SessionStorageSubjects.delete, { sessionId });

      const afterDelete = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-cascade',
      });
      expect(afterDelete.claims).toHaveLength(0);
    });

    it('deleting the agent removes its claims', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken, 'machine-agent-cascade'),
      );

      const beforeDelete = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-agent-cascade',
      });
      expect(beforeDelete.claims).toHaveLength(1);

      await MakaioBus.request(AgentStorageSubjects.delete, { agentId });

      const afterDelete = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-agent-cascade',
      });
      expect(afterDelete.claims).toHaveLength(0);
    });

    it('deleting the session removes its agents and their ownership', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, claimToken, 'machine-session-agent-cascade'),
      );

      await MakaioBus.request(SessionStorageSubjects.delete, { sessionId });

      // The agent goes with its session (drizzle: FK cascade; memory: explicit
      // cascade in the session delete handler), so ownership must not keep
      // reporting state for an agent whose session no longer exists.
      const agentAfter = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(agentAfter.agent ?? null).toBeNull();

      const ownership = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(ownership.ownership).toBeNull();
    });
  });

  // ─── read ──────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('read', () => {
    it('returns ownership=null for an unknown agent', async () => {
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.read, {
        agentId: 'nonexistent-agent',
      });

      expect(result.ownership).toBeNull();
    });

    it('returns both claims when an agent holds two simultaneously, ordered by fence asc', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const token1 = crypto.randomUUID();
      const token2 = crypto.randomUUID();

      const claim1 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token1, 'machine-read', 'adapter-1', 'prov-1'),
      );
      expect(claim1.outcome).toBe('claimed');

      const claim2 = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, token2, 'machine-read', 'adapter-2', 'prov-2'),
      );
      expect(claim2.outcome).toBe('claimed');

      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });

      expect(readResult.ownership).not.toBeNull();
      expect(readResult.ownership?.claims).toHaveLength(2);
      expect(claim1.outcome).toBe('claimed');
      expect(claim2.outcome).toBe('claimed');
      if (claim1.outcome !== 'claimed' || claim2.outcome !== 'claimed') return;

      // Ordered by fence ASC, and the fences are the exact per-agent allocation:
      // the first key at 1, the second strictly above it while both are live.
      const fences = readResult.ownership!.claims.map((c) => c.fence);
      expect(fences).toEqual([1, 2]);
      expect(fences).toEqual([requireClaim(claim1.claim).fence, requireClaim(claim2.claim).fence]);
    });

    it('returns currency fields as null (never undefined) when agent has no currency', async () => {
      const { agentId } = await seedSessionAndAgent();

      const readResult = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });

      expect(readResult.ownership).not.toBeNull();
      // Nullable columns map to null inside currency
      expect(readResult.ownership?.currency.adapterSessionId).toBeNull();
      expect(readResult.ownership?.currency.currentAdapterSessionId).toBeNull();
      expect(readResult.ownership?.currency.currentAdapterSessionIdState).toBe('inherited');
    });
  });

  // ─── Wave 2: keyless reservation ───────────────────────────────────────────────────────────────────────────────

  describe('claim — keyless reservation', () => {
    it.each([
      'keyed',
      'owner-bearing',
      'guarded',
      'superseding',
    ] as const)('rejects an active mixed clear (%s) before allocating runtime authority', async (kind) => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const ownerInstanceId = `mixed-clear-${crypto.randomUUID()}`;
      const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      if (before.ownership === null) throw new Error('expected seeded ownership state');
      const base = buildClaimRequest(
        agentId,
        sessionId,
        crypto.randomUUID(),
        'machine-1',
        'adapter-1',
        null,
        ownerInstanceId,
      );
      const mixed =
        kind === 'keyed'
          ? { ...base, providerSessionId: 'mixed-clear-key' }
          : kind === 'owner-bearing'
            ? base
            : kind === 'guarded'
              ? {
                  ...base,
                  recoveryAttemptId: crypto.randomUUID(),
                  recoveryGuard: {
                    expectedStatus: 'idle' as const,
                    expectedPreimage: { status: 'idle' as const, adapterId: 'adapter-1' },
                    expectedRevision: before.ownership.revision,
                    expectedCurrencyFence: before.ownership.currencyFence,
                    expectedCurrency: before.ownership.currency,
                    ownerGeneration: null,
                  },
                }
              : { ...base, ownerInstance: undefined, supersedes: { claimToken: crypto.randomUUID() } };
      await expect(
        MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
          ...mixed,
          designateLead: { expectedLeadAgentId: null, clear: true },
        }),
      ).rejects.toThrow('keyless, unguarded relinquishment');
      expect(
        (await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' })).claims,
      ).toEqual([]);
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: ownerInstanceId,
          machineId: 'machine-1',
        }),
      ).toEqual({ instance: null });
      const nextInstanceId = `next-${crypto.randomUUID()}`;
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'next-key',
          nextInstanceId,
        ),
      );
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: nextInstanceId,
          machineId: 'machine-1',
        }),
      ).toMatchObject({ instance: { incarnation: 1 } });
    });

    it('registers an exact runtime identity for a guarded recovery and rolls it back when the guard refuses', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      if (before.ownership === null) throw new Error('expected seeded ownership state');
      const ownerInstanceId = `instance-${crypto.randomUUID()}`;
      const recoveryAttemptId = crypto.randomUUID();
      const request = {
        ...buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'unused-provider-session',
          ownerInstanceId,
        ),
        providerSessionId: null,
        recoveryAttemptId,
        recoveryGuard: {
          expectedStatus: 'idle' as const,
          expectedPreimage: { status: 'idle' as const, adapterId: 'adapter-1' },
          expectedRevision: before.ownership.revision,
          expectedCurrencyFence: before.ownership.currencyFence,
          expectedCurrency: before.ownership.currency,
          ownerGeneration: null,
        },
      };

      const reserved = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, request);
      expect(reserved.outcome).toBe('claimed');
      expect(reserved).toMatchObject({ claim: null, recovery: { attemptId: recoveryAttemptId } });
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: ownerInstanceId,
          machineId: 'machine-1',
        }),
      ).toMatchObject({
        instance: { instanceId: ownerInstanceId, machineId: 'machine-1', incarnation: 1, retiredAt: null },
      });
      expect((await MakaioBus.request(AgentStorageSubjects.get, { agentId })).agent).toMatchObject({
        status: 'starting',
        runtimeOwner: { machineId: 'machine-1', instanceId: ownerInstanceId },
        recoveryAttemptId,
      });

      const refusedInstanceId = `instance-${crypto.randomUUID()}`;
      const refused = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...request,
        ownerInstance: { instanceId: refusedInstanceId },
        recoveryAttemptId: crypto.randomUUID(),
        recoveryGuard: { ...request.recoveryGuard, expectedRevision: before.ownership.revision + 1 },
      });
      expect(refused.outcome).toBe('currency-changed');
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: refusedInstanceId,
          machineId: 'machine-1',
        }),
      ).toEqual({ instance: null });

      const nextInstanceId = `instance-${crypto.randomUUID()}`;
      const next = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'after-refusal',
          nextInstanceId,
        ),
      );
      expect(next.outcome).toBe('claimed');
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: nextInstanceId,
          machineId: 'machine-1',
        }),
      ).toMatchObject({ instance: { instanceId: nextInstanceId, incarnation: 2 } });
    });

    it('reuses an existing runtime identity without consuming another incarnation', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const ownerInstanceId = `instance-${crypto.randomUUID()}`;
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'existing-key',
          ownerInstanceId,
        ),
      );
      const before = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      if (before.ownership === null) throw new Error('expected seeded ownership state');

      const reserved = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'unused-provider-session',
          ownerInstanceId,
        ),
        providerSessionId: null,
        recoveryAttemptId: crypto.randomUUID(),
        recoveryGuard: {
          expectedStatus: 'idle',
          expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
          expectedRevision: before.ownership.revision,
          expectedCurrencyFence: before.ownership.currencyFence,
          expectedCurrency: before.ownership.currency,
          ownerGeneration: null,
        },
      });
      expect(reserved.outcome).toBe('claimed');
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: ownerInstanceId,
          machineId: 'machine-1',
        }),
      ).toMatchObject({ instance: { instanceId: ownerInstanceId, incarnation: 1, retiredAt: null } });
    });

    it('designates the lead, writes no claim row, and reports previousLeadAgentId=null', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });

      expect(result.outcome).toBe('claimed');
      if (result.outcome !== 'claimed') return;
      // The whole effect is the designation: a fresh start has no provider
      // identity to own yet, so there is nothing for a claim row to name.
      expect(result.claim).toBeNull();
      expect(result.leadDesignated).toBe(true);
      expect(result.previousLeadAgentId).toBeNull();

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(0);

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId).toBe(agentId);
    });

    it('reports the lead it replaced, so a rollback has something to restore', async () => {
      const sessionId = await seedSession();
      const firstAgentId = await seedAgent(sessionId);
      const secondAgentId = await seedAgent(sessionId);

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(firstAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });

      const promoted = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(secondAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: firstAgentId },
      });

      expect(promoted.outcome).toBe('claimed');
      if (promoted.outcome !== 'claimed') return;
      expect(promoted.previousLeadAgentId).toBe(firstAgentId);

      // And the restore that value enables is a CAS of its own.
      const restored = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(firstAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: secondAgentId },
      });
      expect(restored.outcome).toBe('claimed');

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId).toBe(firstAgentId);
    });

    it('reports previousLeadAgentId honestly when no designation is requested', async () => {
      const sessionId = await seedSession();
      const leadAgentId = await seedAgent(sessionId);
      const memberAgentId = await seedAgent(sessionId);

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(leadAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-lead'),
        designateLead: { expectedLeadAgentId: null },
      });

      const member = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(memberAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-member'),
      );

      expect(member.outcome).toBe('claimed');
      if (member.outcome !== 'claimed') return;
      expect(member.leadDesignated).toBe(false);
      expect(member.previousLeadAgentId).toBe(leadAgentId);
    });

    it('clears the designation under CAS, and leaves a non-lead removal writing nothing', async () => {
      const sessionId = await seedSession();
      const leadAgentId = await seedAgent(sessionId);
      const memberAgentId = await seedAgent(sessionId);

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(leadAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });

      // Removing a member names itself as the expectation, which the session
      // does not carry — so the lead it does carry stays standing.
      const memberClear = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(memberAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        ownerInstance: undefined,
        designateLead: { expectedLeadAgentId: memberAgentId, clear: true },
      });
      expect(memberClear.outcome).toBe('lead-conflict');

      const untouched = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(untouched.session?.leadAgentId).toBe(leadAgentId);

      // Removing the lead is the same call with an expectation that holds — and
      // it is still permitted after the removal marked the agent `disposed`,
      // because giving authority up is the one act a removed agent must keep.
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: leadAgentId, status: 'disposed' });
      const leadClear = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(leadAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        ownerInstance: undefined,
        designateLead: { expectedLeadAgentId: leadAgentId, clear: true },
      });
      expect(leadClear.outcome).toBe('claimed');
      if (leadClear.outcome !== 'claimed') return;
      expect(leadClear.previousLeadAgentId).toBe(leadAgentId);

      const cleared = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(cleared.session?.leadAgentId ?? null).toBeNull();
    });
  });

  // ─── Wave 2: `disposed` is absorbing for ownership ─────────────────────────────────────────────────────────────

  describe('claim — a removed agent may never re-acquire authority', () => {
    it('refuses every acquisition path with agent-disposed and writes nothing', async () => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const incumbentAgentId = await seedAgent(sessionId);

      // A generation the disposed agent already holds, so the same-token retry
      // path has something to revalidate against …
      const ownToken = crypto.randomUUID();
      const own = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, ownToken, 'machine-1', 'adapter-1', 'prov-own'),
      );
      expect(own.outcome).toBe('claimed');

      // … and a foreign generation for the takeover paths.
      const incumbentToken = crypto.randomUUID();
      const incumbent = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(incumbentAgentId, sessionId, incumbentToken, 'machine-1', 'adapter-1', 'prov-foreign'),
      );
      expect(incumbent.outcome).toBe('claimed');

      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      // Free acquisition.
      const free = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-free'),
      );
      expect(free.outcome).toBe('agent-disposed');

      // Same-token idempotent retry.
      const retry = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, ownToken, 'machine-1', 'adapter-1', 'prov-own'),
      );
      expect(retry.outcome).toBe('agent-disposed');

      // Token-named takeover.
      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-foreign'),
        supersedes: { claimToken: incumbentToken },
      });
      expect(takeover.outcome).toBe('agent-disposed');

      // Keyless reservation.
      const keyless = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });
      expect(keyless.outcome).toBe('agent-disposed');

      // Nothing was written on any of those paths: the two pre-existing
      // generations still stand and the session still has no lead.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims.map((claim) => claim.claimToken).sort()).toEqual([ownToken, incumbentToken].sort());
      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.leadAgentId ?? null).toBeNull();
    });

    it('keeps a disposed incumbent authoritative even against a disposed contender', async () => {
      const sessionId = await seedSession();
      const takerAgentId = await seedAgent(sessionId);
      const incumbentAgentId = await seedAgent(sessionId);

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(incumbentAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-both'),
      );
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: incumbentAgentId, status: 'disposed' });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: takerAgentId, status: 'disposed' });

      // Neither agent status proves connector liveness. With no T1/T3/T4 or
      // named-token evidence, occupancy wins before taker classification.
      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(takerAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-both'),
      );
      expect(result.outcome).toBe('already-claimed');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.agentId).toBe(incumbentAgentId);
    });

    it('refuses a lead designation that would keep a removed agent lead', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const claimToken = crypto.randomUUID();

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: null },
      });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      const retry = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, claimToken),
        designateLead: { expectedLeadAgentId: agentId },
      });
      expect(retry.outcome).toBe('agent-disposed');
    });
  });

  describe('claim — session lifecycle admission', () => {
    it.each([
      'closed',
      'archived',
      'discovered',
    ] as const)('refuses every reservation path for a %s session without changing ownership', async (status) => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const incumbentAgentId = await seedAgent(sessionId);
      const ownToken = crypto.randomUUID();
      const incumbentToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, ownToken, 'machine-1', 'adapter-1', 'prov-own'),
      );
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(incumbentAgentId, sessionId, incumbentToken, 'machine-1', 'adapter-1', 'prov-foreign'),
      );
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status });

      const free = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-free'),
      );
      const retry = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, ownToken, 'machine-1', 'adapter-1', 'prov-own'),
      );
      const takeover = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-foreign'),
        supersedes: { claimToken: incumbentToken },
      });
      const keyless = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(agentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });

      for (const result of [free, retry, takeover, keyless]) {
        expect(result).toEqual({ outcome: 'session-not-active', status });
      }
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims.map((claim) => claim.claimToken).sort()).toEqual([ownToken, incumbentToken].sort());
      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.status).toBe(status);
      expect(stored.session?.leadAgentId).toBeUndefined();
    });
  });

  // ─── Conservative takeover of a disposed incumbent ───────────────────────────────────────────────────────────

  describe('claim — disposed incumbent', () => {
    it('keeps the key occupied until runtime liveness provides takeover evidence', async () => {
      const sessionId = await seedSession();
      const incumbentAgentId = await seedAgent(sessionId);
      const takerAgentId = await seedAgent(sessionId);
      const incumbentToken = crypto.randomUUID();

      const held = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(incumbentAgentId, sessionId, incumbentToken, 'machine-1', 'adapter-1', 'prov-unusable'),
      );
      expect(held.outcome).toBe('claimed');
      if (held.outcome !== 'claimed') return;
      const heldClaim = requireClaim(held.claim);

      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: incumbentAgentId, status: 'disposed' });

      // Agent disposal does not prove that its runtime connector has stopped.
      // Shared-machine ownership therefore remains conservative without T3.
      const takeover = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(takerAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-unusable'),
      );
      expect(takeover.outcome).toBe('already-claimed');
      if (takeover.outcome !== 'already-claimed') return;
      expect(takeover.holder).toEqual(heldClaim);

      // The row was repointed rather than duplicated …
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
        providerSessionId: 'prov-unusable',
      });
      expect(listed.claims).toHaveLength(1);

      // The disposed agent still cannot exercise the retained generation.
      const late = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId: incumbentAgentId,
        claimToken: incumbentToken,
        fence: heldClaim.fence,
        expectedRevision: 0,
        target: INHERITED_TARGET,
      });
      expect(late.outcome).toBe('agent-disposed');
    });

    it('never takes over a live incumbent, including one a reconcile marked abandoned', async () => {
      const sessionId = await seedSession();
      const incumbentAgentId = await seedAgent(sessionId);
      const takerAgentId = await seedAgent(sessionId);
      const incumbentToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(incumbentAgentId, sessionId, incumbentToken, 'machine-1', 'adapter-1', 'prov-live'),
      );
      // An `abandoned` marking is a diagnostic presumption and confers nothing:
      // the rows are live, so the key is still owned.
      await MakaioBus.request(SessionOwnershipStorageSubjects.release, {
        agentId: incumbentAgentId,
        claimToken: incumbentToken,
        disposition: 'abandoned',
      });

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(takerAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-live'),
      );
      expect(result.outcome).toBe('already-claimed');
      if (result.outcome !== 'already-claimed') return;
      expect(result.holder.claimToken).toBe(incumbentToken);
      expect(result.holder.status).toBe('abandoned');
    });

    it('frees the key by cascade when a parent row is deleted, rather than producing a takeover', async () => {
      const sessionId = await seedSession();
      const incumbentAgentId = await seedAgent(sessionId);
      const takerAgentId = await seedAgent(sessionId);

      const held = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(incumbentAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-cascade'),
      );
      expect(held.outcome).toBe('claimed');
      if (held.outcome !== 'claimed') return;
      const heldClaimId = requireClaim(held.claim).claimId;

      await MakaioBus.request(AgentStorageSubjects.delete, { agentId: incumbentAgentId });

      // The claim went with its parent, so the next claimant does a plain
      // acquisition: a new row, and a fence from its *own* per-agent sequence
      // rather than one inherited from the vanished owner.
      const fresh = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(takerAgentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-cascade'),
      );
      expect(fresh.outcome).toBe('claimed');
      if (fresh.outcome !== 'claimed') return;
      const freshClaim = requireClaim(fresh.claim);
      expect(freshClaim.claimId).not.toBe(heldClaimId);
      expect(freshClaim.fence).toBe(1);
    });
  });

  // ─── Wave 5: runtime owner identity and liveness takeover ─────────────────────────────────────────────────────

  describe('runtime owner identity', () => {
    it('allocates no runtime row for a refused claim or a movement with no generation', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const incumbentInstanceId = `instance-${crypto.randomUUID()}`;
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-runtime-refusal',
          incumbentInstanceId,
        ),
      );

      const refusedInstanceId = `instance-${crypto.randomUUID()}`;
      const refused = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-runtime-refusal',
          refusedInstanceId,
        ),
      );
      expect(refused.outcome).toBe('already-claimed');
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: refusedInstanceId,
          machineId: 'machine-1',
        }),
      ).toEqual({ instance: null });

      const targetlessInstanceId = `instance-${crypto.randomUUID()}`;
      const targetless = await MakaioBus.request(SessionOwnershipStorageSubjects.settleMovement, {
        machineId: 'machine-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        ownerInstance: { instanceId: targetlessInstanceId },
        sessionId,
        agentId,
        expectedRevision: 0,
        movement: { kind: 'demote', claimToken: crypto.randomUUID() },
      });
      expect(targetless.outcome).toBe('idempotent');
      if (targetless.outcome !== 'idempotent') return;
      expect(targetless.claim).toBeNull();
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: targetlessInstanceId,
          machineId: 'machine-1',
        }),
      ).toEqual({ instance: null });
    });

    it('re-generates a held claim only for the same agent and runtime instance', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const ownerInstanceId = `instance-${crypto.randomUUID()}`;
      const firstToken = crypto.randomUUID();
      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, firstToken, 'machine-1', 'adapter-1', 'prov-t1', ownerInstanceId),
      );
      expect(first.outcome).toBe('claimed');
      if (first.outcome !== 'claimed') return;

      const replacementToken = crypto.randomUUID();
      const replaced = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, replacementToken, 'machine-1', 'adapter-1', 'prov-t1', ownerInstanceId),
      );
      expect(replaced.outcome).toBe('claimed');
      if (replaced.outcome !== 'claimed') return;
      const replacement = requireClaim(replaced.claim);
      expect(replacement.claimId).toBe(requireClaim(first.claim).claimId);
      expect(replacement.claimToken).toBe(replacementToken);
      expect(replacement.fence).toBeGreaterThan(requireClaim(first.claim).fence);
      expect(replacement.ownerInstanceId).toBe(ownerInstanceId);

      const restarted = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-t1',
          `instance-${crypto.randomUUID()}`,
        ),
      );
      expect(restarted.outcome).toBe('already-claimed');
    });

    it('retains claims on retirement and lets a new instance take them through T3', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const retiredInstanceId = `instance-${crypto.randomUUID()}`;
      const held = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-retired',
          retiredInstanceId,
        ),
      );
      expect(held.outcome).toBe('claimed');

      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.retireInstance, { instanceId: retiredInstanceId }),
      ).toEqual({ retiredMachines: 1 });
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.retireInstance, { instanceId: retiredInstanceId }),
      ).toEqual({ retiredMachines: 0 });
      const retired = await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: retiredInstanceId,
        machineId: 'machine-1',
      });
      expect(retired.instance?.retiredAt).not.toBeNull();

      const stillHeld = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(stillHeld.claims).toHaveLength(1);

      const takerInstanceId = `instance-${crypto.randomUUID()}`;
      const taken = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-retired',
          takerInstanceId,
        ),
      );
      expect(taken.outcome).toBe('claimed');
      if (taken.outcome !== 'claimed') return;
      expect(requireClaim(taken.claim).ownerInstanceId).toBe(takerInstanceId);
    });

    it('admits supersession only for a newer instance under machine-exclusive topology', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const oldInstanceId = `instance-${crypto.randomUUID()}`;
      const newInstanceId = `instance-${crypto.randomUUID()}`;
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(agentId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-old', oldInstanceId),
      );
      const auxiliary = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-new-instance',
          newInstanceId,
        ),
      );
      expect(auxiliary.outcome).toBe('claimed');

      const shared = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-old',
          newInstanceId,
        ),
        topology: 'shared-machine',
      });
      expect(shared.outcome).toBe('already-claimed');

      const exclusive = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(
          agentId,
          sessionId,
          crypto.randomUUID(),
          'machine-1',
          'adapter-1',
          'prov-old',
          newInstanceId,
        ),
        topology: 'machine-exclusive',
      });
      expect(exclusive.outcome).toBe('claimed');
      if (exclusive.outcome !== 'claimed') return;
      expect(requireClaim(exclusive.claim).ownerInstanceId).toBe(newInstanceId);
    });
  });

  // ─── Wave 2: settleMovement ───────────────────────────────────────────────────────────────────────────────────

  describe('settleMovement', () => {
    /**
     * Build a movement request for one agent against a fixed ownership key.
     * @param agentId - Agent whose conversation moved.
     * @param sessionId - Session the agent belongs to.
     * @param movement - What the provider did.
     * @param expectedRevision - Revision the caller read.
     * @param machineId - Machine identity (default `machine-1`).
     * @param adapterId - Adapter identity (default `adapter-1`).
     * @param ownerInstanceId - Runtime instance reporting the movement.
     */
    function buildMovementRequest(
      agentId: string,
      sessionId: string,
      movement:
        | { kind: 'confirmed'; providerSessionId: string; claimToken: string }
        | { kind: 'demote'; claimToken: string },
      expectedRevision = 0,
      machineId = 'machine-1',
      adapterId = 'adapter-1',
      ownerInstanceId = `movement-instance-${agentId}`,
    ) {
      return {
        machineId,
        adapterId,
        adapterName: 'test-adapter',
        ownerInstance: { instanceId: ownerInstanceId },
        sessionId,
        agentId,
        expectedRevision,
        movement,
      };
    }

    it('reports an idempotent legacy repeat from its unadopted persisted preimage', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const providerSessionId = 'prov-legacy-repeat';
      const settled = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(
          agentId,
          sessionId,
          { kind: 'confirmed', providerSessionId, claimToken: crypto.randomUUID() },
          0,
          'machine-1',
          'adapter-1',
          'initial-owner',
        ),
      );
      expect(settled.outcome).toBe('settled');
      if (settled.outcome !== 'settled') return;

      await fixture.clearClaimOwnerInstanceId(settled.claim.claimId);
      const ownershipBefore = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      const claimsBefore = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });

      const repeated = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(
          agentId,
          sessionId,
          { kind: 'confirmed', providerSessionId, claimToken: crypto.randomUUID() },
          settled.revision,
          'machine-1',
          'adapter-1',
          'different-owner',
        ),
      );
      expect(repeated.outcome).toBe('idempotent');
      if (repeated.outcome !== 'idempotent') return;
      expect(requireClaim(repeated.claim).ownerInstanceId).toBeNull();
      expect(repeated.revision).toBe(settled.revision);
      expect(repeated.currency).toEqual(settled.currency);
      expect(repeated.sessionSnapshotUpdated).toBe(false);

      const ownershipAfter = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      const claimsAfter = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(ownershipAfter).toEqual(ownershipBefore);
      expect(claimsAfter).toEqual(claimsBefore);
      expect(ownershipAfter.ownership?.claims[0]?.ownerInstanceId).toBeNull();
      expect(claimsAfter.claims[0]?.ownerInstanceId).toBeNull();
    });

    it('refuses a movement token another live generation already holds', async () => {
      // Tokens are unique per generation — the SQL backends enforce it with
      // `uniq_adapter_session_claims_token`, and the acquisition path mirrors
      // that in memory. The movement's successor write is an acquisition too, so
      // it answers the same way: not a modeled outcome, because a reused token
      // is a caller minting one per attempt incorrectly rather than a race the
      // store arbitrates. Two generations sharing one identity would make every
      // later token-keyed release and settle resolve to whichever it found first.
      const sessionId = await seedSession();
      const holderAgentId = await seedAgent(sessionId);
      const movingAgentId = await seedAgent(sessionId);
      const sharedToken = crypto.randomUUID();

      const held = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(holderAgentId, sessionId, sharedToken),
        providerSessionId: 'prov-token-holder',
      });
      expect(held.outcome).toBe('claimed');

      await expect(
        MakaioBus.request(
          SessionOwnershipStorageSubjects.settleMovement,
          buildMovementRequest(movingAgentId, sessionId, {
            kind: 'confirmed',
            providerSessionId: 'prov-token-reuse',
            claimToken: sharedToken,
          }),
        ),
      ).rejects.toThrow(/claim_token/i);

      // Nothing was written: the movement rolled back with the acquisition it
      // could not make, and the holder's generation is untouched.
      const { ownership } = await MakaioBus.request(SessionOwnershipStorageSubjects.read, {
        agentId: movingAgentId,
      });
      expect(ownership?.revision).toBe(0);
      expect(ownership?.claims).toEqual([]);
      const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
        machineId: 'machine-1',
      });
      expect(claims.filter((claim) => claim.claimToken === sharedToken)).toHaveLength(1);
    });

    it('adopts an unreserved agent’s successor key and mirrors it only for a lead', async () => {
      const sessionId = await seedSession();
      const leadAgentId = await seedAgent(sessionId);
      const memberAgentId = await seedAgent(sessionId);

      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        ...buildClaimRequest(leadAgentId, sessionId, crypto.randomUUID()),
        providerSessionId: null,
        designateLead: { expectedLeadAgentId: null },
      });

      // The lead holds no claim at all — the movement is what takes one.
      const lead = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(leadAgentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-lead-moved',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(lead.outcome).toBe('settled');
      if (lead.outcome !== 'settled') return;
      expect(lead.sessionSnapshotUpdated).toBe(true);
      expect(lead.claim.providerSessionId).toBe('prov-lead-moved');
      expect(lead.releasedProviderSessionIds).toEqual([]);
      expect(lead.currency.currentAdapterSessionId).toBe('prov-lead-moved');

      const member = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(memberAgentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-member-moved',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(member.outcome).toBe('settled');
      if (member.outcome !== 'settled') return;
      expect(member.sessionSnapshotUpdated).toBe(false);

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(stored.session?.currentAdapterSessionId).toBe('prov-lead-moved');
    });

    it('rotates A→B atomically, names the new generation, and refuses a late settle under the predecessor', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const firstToken = crypto.randomUUID();

      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-a',
          claimToken: firstToken,
        }),
      );
      expect(first.outcome).toBe('settled');
      if (first.outcome !== 'settled') return;

      const second = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(
          agentId,
          sessionId,
          { kind: 'confirmed', providerSessionId: 'prov-b', claimToken: crypto.randomUUID() },
          first.revision,
        ),
      );
      expect(second.outcome).toBe('settled');
      if (second.outcome !== 'settled') return;
      // The response names the generation the currency now stands under …
      expect(second.claim.providerSessionId).toBe('prov-b');
      expect(second.claim.fence).toBeGreaterThan(first.claim.fence);
      // … and the predecessor's key is free again, reported by ID.
      expect(second.releasedProviderSessionIds).toEqual(['prov-a']);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.providerSessionId).toBe('prov-b');

      // The predecessor was deleted, so its late settle is refused by absence —
      // `not-owner`, never `superseded`: there is no row left to compare fences
      // against.
      const late = await MakaioBus.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken: firstToken,
        fence: first.claim.fence,
        expectedRevision: second.revision,
        target: { currentAdapterSessionId: 'prov-a', currentAdapterSessionIdState: 'confirmed' as const },
      });
      expect(late.outcome).toBe('not-owner');
    });

    it('repeats idempotently under a fresh token, reusing the held generation and deleting nothing', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-repeat',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(first.outcome).toBe('settled');
      if (first.outcome !== 'settled') return;

      // The seam re-announces on every confirmation, and mints a fresh token per
      // attempt. That token names no row: the agent already holds this key, so
      // the repeat settles under the generation it has — and a predecessor
      // delete keyed on the *request's* token would have destroyed it.
      const repeat = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(
          agentId,
          sessionId,
          { kind: 'confirmed', providerSessionId: 'prov-repeat', claimToken: crypto.randomUUID() },
          first.revision,
        ),
      );
      expect(repeat.outcome).toBe('idempotent');
      if (repeat.outcome !== 'idempotent') return;
      expect(repeat.claim?.claimId).toBe(first.claim.claimId);
      expect(repeat.revision).toBe(first.revision);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimId).toBe(first.claim.claimId);
    });

    it('demotes to moved, keeps the claim, and leaves the key blocked', async () => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const competitorId = await seedAgent(sessionId);
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, { agentId, adapterSessionId: 'prov-origin' });

      const demoted = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, { kind: 'demote', claimToken: crypto.randomUUID() }),
      );
      expect(demoted.outcome).toBe('settled');
      if (demoted.outcome !== 'settled') return;
      expect(demoted.currency.currentAdapterSessionIdState).toBe('moved');
      expect(demoted.claim.providerSessionId).toBe('prov-origin');
      // Only a clean release frees a key, and nothing here proves the provider
      // is done with the conversation being voided.
      expect(demoted.releasedProviderSessionIds).toEqual([]);

      const competitor = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(competitorId, sessionId, crypto.randomUUID(), 'machine-1', 'adapter-1', 'prov-origin'),
      );
      expect(competitor.outcome).toBe('already-claimed');
    });

    it('reports idempotent with no generation when a demotion resolves no key', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, { kind: 'demote', claimToken: crypto.randomUUID() }),
      );

      expect(result.outcome).toBe('idempotent');
      if (result.outcome !== 'idempotent') return;
      // Nothing was resumable, so the movement resolves no key and therefore
      // names no generation — the one outcome whose `claim` is legitimately null.
      expect(result.claim).toBeNull();

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(0);
    });

    it('refuses a movement onto a key another agent owns, and changes nothing', async () => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const ownerId = await seedAgent(sessionId);
      const ownerToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(ownerId, sessionId, ownerToken, 'machine-1', 'adapter-1', 'prov-taken'),
      );

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-taken',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(result.outcome).toBe('already-claimed');
      if (result.outcome !== 'already-claimed') return;
      expect(result.holder.claimToken).toBe(ownerToken);

      // The refusal rolled the whole movement back: no currency, no revision.
      const ownership = await MakaioBus.request(SessionOwnershipStorageSubjects.read, { agentId });
      expect(ownership.ownership?.revision).toBe(0);
      expect(ownership.ownership?.currency.currentAdapterSessionIdState).toBe('inherited');
      expect(ownership.ownership?.claims).toHaveLength(0);
    });

    it('refuses a removed agent and an agent that is not in the named session', async () => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const foreignSessionId = await seedSession();

      const foreign = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, foreignSessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-foreign-session',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(foreign.outcome).toBe('not-found');

      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
      const disposed = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-disposed',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(disposed.outcome).toBe('agent-disposed');

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(0);
    });

    it('reports currency-changed on a stale revision without writing', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();

      const first = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(agentId, sessionId, {
          kind: 'confirmed',
          providerSessionId: 'prov-first',
          claimToken: crypto.randomUUID(),
        }),
      );
      expect(first.outcome).toBe('settled');

      const stale = await MakaioBus.request(
        SessionOwnershipStorageSubjects.settleMovement,
        buildMovementRequest(
          agentId,
          sessionId,
          { kind: 'confirmed', providerSessionId: 'prov-second', claimToken: crypto.randomUUID() },
          0,
        ),
      );
      expect(stale.outcome).toBe('currency-changed');

      // The claims phase rolled back with the settle: the successor key it had
      // already allocated must not survive a refusal.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.providerSessionId).toBe('prov-first');
    });
  });

  // ─── Wave 2: releaseAgentClaims ───────────────────────────────────────────────────────────────────────────────

  describe('releaseAgentClaims', () => {
    /**
     * Give one agent two live generations — the state a movement passes through.
     * @returns The agent and both generation tokens.
     */
    async function claimTwoKeys(): Promise<{ sessionId: string; agentId: string; first: string; second: string }> {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      for (const [token, providerSessionId] of [
        [first, 'prov-one'],
        [second, 'prov-two'],
      ] as const) {
        const claimed = await MakaioBus.request(
          SessionOwnershipStorageSubjects.claim,
          buildClaimRequest(agentId, sessionId, token, 'machine-1', 'adapter-1', providerSessionId),
        );
        expect(claimed.outcome).toBe('claimed');
      }
      return { sessionId, agentId, first, second };
    }

    it('scopes to one generation when a token is named, and leaves the other standing', async () => {
      const { agentId, first, second } = await claimTwoKeys();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.releaseAgentClaims, {
        agentId,
        claimToken: first,
        disposition: 'released' as const,
      });
      expect(result.releasedProviderSessionIds).toEqual(['prov-one']);
      expect(result.claimTokenNotFound).toBe(false);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.claimToken).toBe(second);
    });

    it('retires everything the agent holds when no token is named', async () => {
      const { agentId } = await claimTwoKeys();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.releaseAgentClaims, {
        agentId,
        disposition: 'released' as const,
      });
      expect(result.releasedProviderSessionIds.sort()).toEqual(['prov-one', 'prov-two']);
      expect(result.claimTokenNotFound).toBe(false);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(0);
    });

    it('marks rather than deletes for a non-freeing disposition, and keeps the keys blocked', async () => {
      const { agentId } = await claimTwoKeys();

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.releaseAgentClaims, {
        agentId,
        disposition: 'abandoned' as const,
      });
      expect(result.releasedProviderSessionIds).toEqual([]);
      expect(result.markedClaims).toHaveLength(2);
      expect(result.markedClaims.every((claim) => claim.status === 'abandoned')).toBe(true);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(2);
    });

    it('reports a foreign token as not-found without revealing its holder', async () => {
      const sessionId = await seedSession();
      const agentId = await seedAgent(sessionId);
      const otherAgentId = await seedAgent(sessionId);
      const otherToken = crypto.randomUUID();

      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        buildClaimRequest(otherAgentId, sessionId, otherToken, 'machine-1', 'adapter-1', 'prov-foreign'),
      );

      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.releaseAgentClaims, {
        agentId,
        claimToken: otherToken,
        disposition: 'released' as const,
      });
      expect(result.claimTokenNotFound).toBe(true);
      expect(result.releasedProviderSessionIds).toEqual([]);
      expect(result.markedClaims).toEqual([]);

      // The claim it could not take is untouched.
      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(1);
      expect(listed.claims[0]?.status).toBe('held');
    });

    it('still lets a removed agent give its claims up', async () => {
      const { agentId } = await claimTwoKeys();
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      // The one ownership act `disposed` does not absorb: guarding it would
      // strand exactly the claims that most need retiring.
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.releaseAgentClaims, {
        agentId,
        disposition: 'released' as const,
      });
      expect(result.releasedProviderSessionIds).toHaveLength(2);

      const listed = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(listed.claims).toHaveLength(0);
    });

    it('is idempotent, and reports nothing for an agent that no longer exists', async () => {
      const result = await MakaioBus.request(SessionOwnershipStorageSubjects.releaseAgentClaims, {
        agentId: `agent-${crypto.randomUUID()}`,
        disposition: 'released' as const,
      });
      expect(result.releasedProviderSessionIds).toEqual([]);
      expect(result.markedClaims).toEqual([]);
      expect(result.claimTokenNotFound).toBe(false);
    });
  });
}
