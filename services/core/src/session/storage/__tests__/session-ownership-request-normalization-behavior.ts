/** Production-validation-bypass behavior shared by both ownership backends. */
import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  type SessionOwnershipClaimRequest,
  type SessionOwnershipRecoveryGuard,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { SessionStorageSubjects } from '../namespace.js';
import { createAgent, createSession } from './shared.js';

/**
 * Run a request while the bus deliberately skips namespace validation.
 * @param operation - Request to execute under production validation policy.
 */
async function withoutBusValidation<T>(operation: () => Promise<T>): Promise<T> {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await operation();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

/** Seed one active session and member agent. */
async function seedSessionAndAgent(): Promise<{ sessionId: string; agentId: string }> {
  const sessionId = `session-${crypto.randomUUID()}`;
  const agentId = `agent-${crypto.randomUUID()}`;
  await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session: createSession({ sessionId }) });
  await MakaioBus.request(AgentStorageSubjects.set, {
    agentId,
    agent: createAgent({ agentId, sessionId, adapterId: 'adapter-1' }),
  });
  return { sessionId, agentId };
}

/**
 * Seed an additional member agent in an existing session.
 * @param sessionId - Session receiving the agent.
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
 * Build a normalized keyed claim for one seeded agent.
 * @param sessionId - Session containing the claimant.
 * @param agentId - Claiming agent.
 * @param ownerInstanceId - Runtime owner taking the generation.
 */
function claimRequest(sessionId: string, agentId: string, ownerInstanceId: string): SessionOwnershipClaimRequest {
  return {
    machineId: 'machine-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    providerSessionId: 'provider-1',
    sessionId,
    agentId,
    ownerInstance: { instanceId: ownerInstanceId },
    topology: 'shared-machine',
    claimToken: crypto.randomUUID(),
  };
}

/** Snapshot matching a newly seeded agent. */
function recoveryGuard(): SessionOwnershipRecoveryGuard {
  return {
    expectedStatus: 'idle',
    expectedPreimage: { status: 'idle', adapterId: 'adapter-1' },
    expectedRevision: 0,
    expectedCurrencyFence: 0,
    expectedCurrency: {
      adapterSessionId: null,
      currentAdapterSessionId: null,
      currentAdapterSessionIdState: 'inherited',
    },
    ownerGeneration: null,
  };
}

/**
 * Build a keyless designation mutation.
 * @param sessionId - Session whose lead is changing.
 * @param agentId - Target agent or departing lead.
 * @param expectedLeadAgentId - Lead expected by the compare-and-swap.
 * @param mutation - Explicit inactive-safe mutation marker.
 */
function designationRequest(
  sessionId: string,
  agentId: string,
  expectedLeadAgentId: string | null,
  mutation?: { readonly clear?: true; readonly restore?: true },
): SessionOwnershipClaimRequest {
  return {
    machineId: 'keyless-designation',
    adapterId: 'keyless-designation',
    adapterName: 'keyless-designation',
    providerSessionId: null,
    sessionId,
    agentId,
    topology: 'shared-machine',
    claimToken: crypto.randomUUID(),
    designateLead: { expectedLeadAgentId, ...mutation },
  };
}

type InvalidClaimBuilder = (base: SessionOwnershipClaimRequest) => SessionOwnershipClaimRequest;

const INVALID_CLAIMS: ReadonlyArray<readonly [string, InvalidClaimBuilder]> = [
  ['mixed clear keyed', (base) => ({ ...base, designateLead: { expectedLeadAgentId: null, clear: true } })],
  [
    'mixed clear owner-bearing',
    (base) => ({ ...base, providerSessionId: null, designateLead: { expectedLeadAgentId: null, clear: true } }),
  ],
  [
    'mixed clear guarded',
    (base) => ({
      ...base,
      providerSessionId: null,
      recoveryGuard: recoveryGuard(),
      recoveryAttemptId: 'attempt-1',
      designateLead: { expectedLeadAgentId: null, clear: true },
    }),
  ],
  [
    'mixed clear superseding',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      supersedes: { claimToken: 'prior-token' },
      designateLead: { expectedLeadAgentId: null, clear: true },
    }),
  ],
  [
    'clear and restore',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      designateLead: { expectedLeadAgentId: null, clear: true, restore: true },
    }),
  ],
  [
    'pure clear with null expectation',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      designateLead: { expectedLeadAgentId: null, clear: true },
    }),
  ],
  [
    'pure clear naming another agent',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      designateLead: { expectedLeadAgentId: 'other-agent', clear: true },
    }),
  ],
  [
    'pure restore with null expectation',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      designateLead: { expectedLeadAgentId: null, restore: true },
    }),
  ],
  [
    'pure restore targeting the expected lead',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      designateLead: { expectedLeadAgentId: base.agentId, restore: true },
    }),
  ],
  ['mixed restore keyed', (base) => ({ ...base, designateLead: { expectedLeadAgentId: null, restore: true } })],
  [
    'mixed restore owner-bearing',
    (base) => ({ ...base, providerSessionId: null, designateLead: { expectedLeadAgentId: null, restore: true } }),
  ],
  [
    'mixed restore guarded',
    (base) => ({
      ...base,
      providerSessionId: null,
      recoveryGuard: recoveryGuard(),
      recoveryAttemptId: 'attempt-1',
      designateLead: { expectedLeadAgentId: null, restore: true },
    }),
  ],
  [
    'mixed restore superseding',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      supersedes: { claimToken: 'prior-token' },
      designateLead: { expectedLeadAgentId: null, restore: true },
    }),
  ],
  ['keyed without owner', (base) => ({ ...base, ownerInstance: undefined })],
  [
    'guarded without owner',
    (base) => ({
      ...base,
      providerSessionId: null,
      ownerInstance: undefined,
      recoveryGuard: recoveryGuard(),
      recoveryAttemptId: 'attempt-1',
    }),
  ],
  ['guarded without attempt', (base) => ({ ...base, recoveryGuard: recoveryGuard() })],
  ['attempt without guard', (base) => ({ ...base, recoveryAttemptId: 'attempt-1' })],
  [
    'guarded designation',
    (base) => ({
      ...base,
      recoveryGuard: recoveryGuard(),
      recoveryAttemptId: 'attempt-1',
      designateLead: { expectedLeadAgentId: null },
    }),
  ],
  [
    'guard preimage binding adapter mismatch',
    (base) => ({
      ...base,
      recoveryGuard: {
        ...recoveryGuard(),
        expectedPreimage: {
          status: 'idle',
          adapterId: 'adapter-1',
          binding: { adapterId: 'adapter-2', ownerMachineId: 'machine-1', ownerInstanceId: 'owner-1' },
        },
      },
      recoveryAttemptId: 'attempt-1',
    }),
  ],
  [
    'guard preimage status mismatch',
    (base) => ({
      ...base,
      recoveryGuard: { ...recoveryGuard(), expectedPreimage: { status: 'dead', adapterId: 'adapter-1' } },
      recoveryAttemptId: 'attempt-1',
    }),
  ],
  [
    'confirmed currency without id',
    (base) => ({
      ...base,
      recoveryGuard: {
        ...recoveryGuard(),
        expectedCurrency: {
          adapterSessionId: null,
          currentAdapterSessionId: null,
          currentAdapterSessionIdState: 'confirmed',
        },
      },
      recoveryAttemptId: 'attempt-1',
    }),
  ],
  [
    'non-confirmed currency with id',
    (base) => ({
      ...base,
      recoveryGuard: {
        ...recoveryGuard(),
        expectedCurrency: {
          adapterSessionId: null,
          currentAdapterSessionId: 'provider-1',
          currentAdapterSessionIdState: 'moved',
        },
      },
      recoveryAttemptId: 'attempt-1',
    }),
  ],
];

/** Register canonical request-normalization tests for a storage backend. */
export function describeSessionOwnershipRequestNormalizationBehavior(): void {
  describe('claim request normalization without bus validation', () => {
    it.each(INVALID_CLAIMS)('rejects %s before any durable mutation', async (_name, buildInvalid) => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      const invalidOwner = `invalid-${crypto.randomUUID()}`;
      const beforeAgent = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      const beforeSession = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });

      await expect(
        withoutBusValidation(() =>
          MakaioBus.request(
            SessionOwnershipStorageSubjects.claim,
            buildInvalid(claimRequest(sessionId, agentId, invalidOwner)),
          ),
        ),
      ).rejects.toThrow();

      expect(await MakaioBus.request(AgentStorageSubjects.get, { agentId })).toEqual(beforeAgent);
      expect(await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).toEqual(beforeSession);
      expect(
        (await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' })).claims,
      ).toEqual([]);
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: invalidOwner,
          machineId: 'machine-1',
        }),
      ).toEqual({ instance: null });

      const validOwner = `valid-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, claimRequest(sessionId, agentId, validOwner));
      expect(
        await MakaioBus.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
          instanceId: validOwner,
          machineId: 'machine-1',
        }),
      ).toMatchObject({ instance: { incarnation: 1 } });
    });
  });

  describe('inactive-safe lead restoration', () => {
    it('clears the exact departing lead after closure', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, designationRequest(sessionId, agentId, null));
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

      const cleared = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, agentId, agentId, { clear: true }),
      );

      expect(cleared).toMatchObject({ outcome: 'claimed', leadDesignated: true });
      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.leadAgentId).toBeUndefined();
    });

    it('restores the exact prior lead after closure and is idempotent once restored', async () => {
      const { sessionId, agentId: priorLeadId } = await seedSessionAndAgent();
      const failedLeadId = await seedAgent(sessionId);
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, designationRequest(sessionId, priorLeadId, null));
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, failedLeadId, priorLeadId),
      );
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

      const restored = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, priorLeadId, failedLeadId, { restore: true }),
      );
      const retried = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, priorLeadId, failedLeadId, { restore: true }),
      );

      expect(restored).toMatchObject({ outcome: 'claimed', leadDesignated: true });
      expect(retried).toMatchObject({ outcome: 'claimed', leadDesignated: false });
      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.leadAgentId).toBe(
        priorLeadId,
      );
    });

    it('refuses an unmarked inactive designation', async () => {
      const { sessionId, agentId } = await seedSessionAndAgent();
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

      await expect(
        MakaioBus.request(SessionOwnershipStorageSubjects.claim, designationRequest(sessionId, agentId, null)),
      ).resolves.toEqual({ outcome: 'session-not-active', status: 'closed' });
    });

    it.each([
      'archived',
      'discovered',
    ] as const)('refuses pure clear and restore mutations for an %s session', async (status) => {
      const { sessionId, agentId: failedLeadId } = await seedSessionAndAgent();
      const priorLeadId = await seedAgent(sessionId);
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, designationRequest(sessionId, failedLeadId, null));
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status });

      const clear = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, failedLeadId, failedLeadId, { clear: true }),
      );
      const restore = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, priorLeadId, failedLeadId, { restore: true }),
      );

      expect(clear).toEqual({ outcome: 'session-not-active', status });
      expect(restore).toEqual({ outcome: 'session-not-active', status });
      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.leadAgentId).toBe(
        failedLeadId,
      );
    });

    it('preserves a newer lead when the restore expectation is stale', async () => {
      const { sessionId, agentId: staleLeadId } = await seedSessionAndAgent();
      const currentLeadId = await seedAgent(sessionId);
      await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, currentLeadId, null),
      );
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, staleLeadId, 'superseded-lead', { restore: true }),
      );

      expect(result).toEqual({ outcome: 'lead-conflict', currentLeadAgentId: currentLeadId });
      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.leadAgentId).toBe(
        currentLeadId,
      );
    });

    it('refuses a disposed restore target', async () => {
      const { sessionId, agentId: priorLeadId } = await seedSessionAndAgent();
      const failedLeadId = await seedAgent(sessionId);
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, designationRequest(sessionId, failedLeadId, null));
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: priorLeadId, status: 'disposed' });
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, priorLeadId, failedLeadId, { restore: true }),
      );

      expect(result).toEqual({ outcome: 'agent-disposed' });
      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.leadAgentId).toBe(
        failedLeadId,
      );
    });

    it('refuses a missing restore target', async () => {
      const { sessionId, agentId: failedLeadId } = await seedSessionAndAgent();
      await MakaioBus.request(SessionOwnershipStorageSubjects.claim, designationRequest(sessionId, failedLeadId, null));
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });

      const result = await MakaioBus.request(
        SessionOwnershipStorageSubjects.claim,
        designationRequest(sessionId, 'missing-agent', failedLeadId, { restore: true }),
      );

      expect(result).toEqual({ outcome: 'not-found', missing: 'agent' });
      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.leadAgentId).toBe(
        failedLeadId,
      );
    });
  });
}
