import { describe, expect, it, beforeEach } from 'vitest';
import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import { PROVIDER_ALLOCATION_REF_VERSION } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowEngineService } from '../workflow-engine-service.js';
import {
  decodeDurableOutcome,
  durableOutcome,
  type ExecutionAttemptRepository,
} from '../execution-attempt-repository.js';
import type { ProviderOperationClaim } from '../provider-operation.js';
import {
  INITIAL_ATTEMPT_CONTROL_STATE,
  TEST_OWNER_ID,
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
  beginTestProvisioning,
  createInMemoryAttemptRepository,
  leaseAt,
  makeBeginProvisioningInput,
  makeEvidence,
  type InMemoryAttemptRepository,
  workflowRunResultOutcomeCodec,
} from '../testing/index.js';

// ─────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────

function makeCompletedResult(executionId: string): WorkflowRunResult {
  return {
    executionId,
    workflowId: 'test-workflow',
    status: 'completed',
  };
}

function makeFailedResult(executionId: string): WorkflowRunResult {
  return {
    executionId,
    workflowId: 'test-workflow',
    status: 'failed',
    error: 'something went wrong',
  };
}

function makePausedResult(executionId: string): WorkflowRunResult {
  return {
    executionId,
    workflowId: 'test-workflow',
    status: 'paused',
    pausedAtGateId: 'gate-1',
    pausedAtFrameId: 'frame-1',
  };
}

function makeAllocationRef(
  providerId: string = TEST_PROVIDER_ID,
  data: Record<string, unknown> = { machineId: 'machine-1' },
): ProviderAllocationRef {
  return {
    version: PROVIDER_ALLOCATION_REF_VERSION,
    providerId,
    providerData: data,
  };
}

/**
 * Advance a claimed operation to `terminal-convergence`.
 *
 * The infrastructure-failure settlement is reachable only from there, so a
 * test about that settlement records the confirmed termination which precedes
 * it instead of asserting a transition the port does not offer.
 * @param authority - Authority under test.
 * @param claim - Claim authorizing the record.
 * @throws When the termination is not recorded.
 */
async function terminateAllocation(
  authority: ExecutionAttemptAuthority<WorkflowRunResult>,
  claim: ProviderOperationClaim,
): Promise<void> {
  const decision = await authority.recordAllocationTerminated({ claim, evidence: makeEvidence() });
  if (decision.kind !== 'recorded') throw new Error(`Expected termination to record, got '${decision.kind}'`);
}

/**
 * Create a "correlated" allocation ref with additional run/job identity,
 * simulating hosted-runner correlation after dispatch.
 * @param providerId - Provider identifier.
 * @param runId - Correlated run identifier.
 * @param jobId - Correlated job identifier.
 * @returns Evolved allocation reference with correlation data.
 */
function makeCorrelatedAllocationRef(
  providerId: string = TEST_PROVIDER_ID,
  runId: string = 'run-123',
  jobId: string = 'job-456',
): ProviderAllocationRef {
  return {
    version: PROVIDER_ALLOCATION_REF_VERSION,
    providerId,
    providerData: { machineId: 'machine-1', runId, jobId },
  };
}

/**
 * Build a repository that implements only the required port surface.
 *
 * Used to prove that recovery operations are gated rather than assumed.
 * @returns A repository without any recovery operation.
 */
function createMinimalRepository(): ExecutionAttemptRepository<WorkflowRunResult> {
  const claim: ProviderOperationClaim = {
    executionAttemptId: 'attempt-1',
    generation: 1,
    ownerId: TEST_OWNER_ID,
    token: 'token-1',
    leaseExpiresAt: leaseAt(60_000),
  };
  return {
    canonicalizeOutcome: (outcome) => durableOutcome(workflowRunResultOutcomeCodec, outcome),
    decodeOutcome: (text) => decodeDurableOutcome(workflowRunResultOutcomeCodec, text),
    createAttempt: async (input) => ({
      ...INITIAL_ATTEMPT_CONTROL_STATE,
      executionAttemptId: input.executionAttemptId,
      executionId: input.executionId,
      status: 'pending' as const,
      allocationRef: null,
      createdAt: new Date().toISOString(),
      providerId: null,
      allocationLifetime: null,
      provisionerIncarnationId: null,
    }),
    beginProvisioning: async () => ({ kind: 'started' as const, claim }),
    getProviderOperation: async () => null,
    renewProviderOperationClaim: async () => ({ kind: 'not-found' as const }),
    takeOverProviderOperation: async () => ({ kind: 'not-found' as const }),
    handoffProviderOperation: async () => ({ kind: 'not-found' as const }),
    recordProviderOperationUncertainty: async () => ({ kind: 'not-found' as const }),
    recordAllocation: async () => ({ kind: 'recorded' as const }),
    recordProvisioningAbsent: async () => ({ kind: 'recorded' as const }),
    recordProvisionerIncarnationLost: async () => ({ kind: 'not-found' as const }),
    recordAllocationTerminated: async () => ({ kind: 'recorded' as const }),
    recordInfrastructureFailure: async () => ({ kind: 'not-found' as const }),
    getActiveAttempt: async () => null,
    commitOutcome: async () => ({ kind: 'fenced' as const }),
    abandonPendingAttempt: async () => ({ kind: 'fenced' as const }),
    registerRuntime: async () => ({ kind: 'not-found' as const }),
    admitOperation: async () => ({ kind: 'not-found' as const }),
    completeOperation: async () => ({ kind: 'not-found' as const }),
    markRuntimeReady: async () => ({ kind: 'not-found' as const }),
    getAttemptControlState: async () => null,
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('ExecutionAttemptAuthority', () => {
  let repository: InMemoryAttemptRepository<WorkflowRunResult>;
  let authority: ExecutionAttemptAuthority<WorkflowRunResult>;

  beforeEach(() => {
    repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    authority = new ExecutionAttemptAuthority(repository);
  });

  // ─────────────────────────────────────────────────────────
  // Authority-Created IDs
  // ─────────────────────────────────────────────────────────

  describe('attempt creation', () => {
    it('generates a unique executionAttemptId for each attempt', async () => {
      const executionId = 'exec-1';
      const attempt1 = await authority.createAttempt(executionId);
      const attempt2 = await authority.createAttempt(executionId);

      expect(attempt1.executionAttemptId).toBeTruthy();
      expect(attempt2.executionAttemptId).toBeTruthy();
      expect(attempt1.executionAttemptId).not.toBe(attempt2.executionAttemptId);
    });

    it('persists the attempt through the repository before returning', async () => {
      const executionId = 'exec-1';
      const attempt = await authority.createAttempt(executionId);

      expect(repository.attempts.has(attempt.executionAttemptId)).toBe(true);
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored).toEqual(
        expect.objectContaining({
          executionAttemptId: attempt.executionAttemptId,
          executionId,
          status: 'pending',
          allocationRef: null,
        }),
      );
    });

    it('returns a record with status pending, no allocation, and no provider binding', async () => {
      const attempt = await authority.createAttempt('exec-1');

      expect(attempt.status).toBe('pending');
      expect(attempt.allocationRef).toBeNull();
      expect(attempt.providerId).toBeNull();
      expect(attempt.allocationLifetime).toBeNull();
      expect(attempt.provisionerIncarnationId).toBeNull();
      expect(attempt.createdAt).toBeTruthy();
    });

    it('opens no provider operation before provisioning begins', async () => {
      const attempt = await authority.createAttempt('exec-1');

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toBeNull();
    });

    it('installs an in-process waiter that can be awaited', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      expect(waiterPromise).toBeInstanceOf(Promise);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Single Atomic Provisioning Authorization
  // ─────────────────────────────────────────────────────────

  describe('provisioning authorization', () => {
    it('authorizes exactly one provider call per attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const input = makeBeginProvisioningInput(attempt.executionAttemptId, 'exec-1');

      const first = await authority.beginProvisioning(input);
      const second = await authority.beginProvisioning(input);

      expect(first.kind).toBe('started');
      expect(second).toEqual({ kind: 'already-provisioning' });
    });

    it('opens the operation at generation 1 with the provisioning-resolution obligation', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      expect(claim.generation).toBe(1);
      expect(claim.ownerId).toBe(TEST_OWNER_ID);
      expect(claim.token).toBeTruthy();
      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        generation: 1,
        ownerId: TEST_OWNER_ID,
        token: claim.token,
        obligation: 'provisioning-resolution',
        failureCount: 0,
        lastFailure: null,
      });
    });

    it('binds provider, lifetime, and provisioner incarnation atomically with the first begin', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'provisioning',
        providerId: TEST_PROVIDER_ID,
        allocationLifetime: 'provider-managed',
        provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
      });
    });

    it('keeps the provider binding immutable when a second begin names a different provider', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      const second = await authority.beginProvisioning(
        makeBeginProvisioningInput(attempt.executionAttemptId, 'exec-1', {
          providerId: 'other-provider',
          allocationLifetime: 'provisioner-process-bound',
          provisionerIncarnationId: 'provisioner-incarnation-2',
        }),
      );

      expect(second).toEqual({ kind: 'already-provisioning' });
      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        providerId: TEST_PROVIDER_ID,
        allocationLifetime: 'provider-managed',
        provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
      });
    });

    it('denies a superseded attempt a new provider call', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      await authority.createAttempt('exec-1');

      await expect(
        authority.beginProvisioning(makeBeginProvisioningInput(attempt1.executionAttemptId, 'exec-1')),
      ).resolves.toEqual({ kind: 'fenced' });
    });

    it('reports not-found for an attempt that was never created', async () => {
      await expect(
        authority.beginProvisioning(makeBeginProvisioningInput('nonexistent-attempt', 'exec-1')),
      ).resolves.toEqual({ kind: 'not-found' });
    });

    it('denies a new provider call once the attempt is allocated', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const allocationRef = makeAllocationRef();
      await authority.recordAllocation({ claim, allocationRef });

      await expect(
        authority.beginProvisioning(makeBeginProvisioningInput(attempt.executionAttemptId, 'exec-1')),
      ).resolves.toEqual({ kind: 'allocated', allocationRef });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Claim Lifecycle
  // ─────────────────────────────────────────────────────────

  describe('provider operation claim lifecycle', () => {
    it('renews a lease for the current token without changing generation or token', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const nextLease = leaseAt(120_000);

      const decision = await authority.renewProviderOperationClaim({ claim, leaseExpiresAt: nextLease });

      expect(decision).toEqual({
        kind: 'claimed',
        claim: { ...claim, leaseExpiresAt: nextLease },
      });
      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        generation: 1,
        token: claim.token,
        leaseExpiresAt: nextLease,
      });
    });

    it('refuses renewal for a superseded token', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(
        authority.renewProviderOperationClaim({
          claim: { ...claim, token: 'forged-token' },
          leaseExpiresAt: leaseAt(120_000),
        }),
      ).resolves.toEqual({ kind: 'stale' });
    });

    it('refuses takeover while the lease is still held', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        leaseExpiresAt: leaseAt(60_000),
      });

      await expect(
        authority.takeOverProviderOperation({
          executionAttemptId: attempt.executionAttemptId,
          ownerId: 'controller-incarnation-2',
          observedAt: new Date().toISOString(),
          leaseExpiresAt: leaseAt(60_000),
        }),
      ).resolves.toEqual({ kind: 'stale' });
    });

    it('allows takeover after expiry and issues a new generation and token', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const original = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        leaseExpiresAt: leaseAt(-1_000),
      });

      const decision = await authority.takeOverProviderOperation({
        executionAttemptId: attempt.executionAttemptId,
        ownerId: 'controller-incarnation-2',
        observedAt: new Date().toISOString(),
        leaseExpiresAt: leaseAt(60_000),
      });

      expect(decision.kind).toBe('claimed');
      if (decision.kind !== 'claimed') throw new Error('expected takeover to succeed');
      expect(decision.claim.generation).toBe(original.generation + 1);
      expect(decision.claim.token).not.toBe(original.token);
      expect(decision.claim.ownerId).toBe('controller-incarnation-2');
    });

    it('fences the previous claim immediately after takeover', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const original = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        leaseExpiresAt: leaseAt(-1_000),
      });
      await authority.takeOverProviderOperation({
        executionAttemptId: attempt.executionAttemptId,
        ownerId: 'controller-incarnation-2',
        observedAt: new Date().toISOString(),
        leaseExpiresAt: leaseAt(60_000),
      });

      await expect(
        authority.recordAllocation({ claim: original, allocationRef: makeAllocationRef() }),
      ).resolves.toEqual({ kind: 'stale' });
      expect(repository.attempts.get(attempt.executionAttemptId)?.allocationRef).toBeNull();
    });

    it('preserves generation and obligation on handoff while clearing ownership', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      await expect(authority.handoffProviderOperation({ claim })).resolves.toEqual({ kind: 'recorded' });

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        generation: claim.generation,
        obligation: 'allocation-control',
        ownerId: null,
        token: null,
        leaseExpiresAt: null,
      });
    });

    it('fences the handed-off claim and lets takeover claim immediately', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        leaseExpiresAt: leaseAt(600_000),
      });
      await authority.handoffProviderOperation({ claim });

      await expect(authority.recordProviderOperationUncertainty({ claim, evidence: makeEvidence() })).resolves.toEqual({
        kind: 'stale',
      });

      const decision = await authority.takeOverProviderOperation({
        executionAttemptId: attempt.executionAttemptId,
        ownerId: 'controller-incarnation-2',
        observedAt: new Date().toISOString(),
        leaseExpiresAt: leaseAt(60_000),
      });
      expect(decision.kind).toBe('claimed');
      if (decision.kind !== 'claimed') throw new Error('expected takeover to succeed');
      expect(decision.claim.generation).toBe(claim.generation + 1);
      expect(decision.claim.token).not.toBe(claim.token);
    });

    it('records handoff evidence durably without counting it as a failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const evidence = makeEvidence({ summary: 'controller shutting down', code: 'handoff' });

      await authority.handoffProviderOperation({ claim, evidence });

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        failureCount: 0,
        lastFailure: evidence,
      });
    });

    it('reports resolved for claim operations once the attempt has settled', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(makeCompletedResult('exec-1')),
      );
      authority.settleOutcome(attempt.executionAttemptId, decision);

      await expect(authority.renewProviderOperationClaim({ claim, leaseExpiresAt: leaseAt(60_000) })).resolves.toEqual({
        kind: 'resolved',
      });
      await expect(
        authority.takeOverProviderOperation({
          executionAttemptId: attempt.executionAttemptId,
          ownerId: 'controller-incarnation-2',
          observedAt: new Date().toISOString(),
          leaseExpiresAt: leaseAt(60_000),
        }),
      ).resolves.toEqual({ kind: 'resolved' });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Repository-Owned Obligation Transitions
  // ─────────────────────────────────────────────────────────

  describe('operation obligation transitions', () => {
    it('advances to allocation-control when an allocation is recorded', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        obligation: 'allocation-control',
      });
    });

    it('advances to terminal-convergence when a known allocation is confirmed terminated', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      const evidence = makeEvidence({ summary: 'allocation confirmed terminated', code: 'terminated' });

      await expect(authority.recordAllocationTerminated({ claim, evidence })).resolves.toEqual({ kind: 'recorded' });

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        obligation: 'terminal-convergence',
        failureCount: 0,
        lastFailure: evidence,
      });
      expect(repository.attempts.get(attempt.executionAttemptId)?.settlementKind).toBeNull();
    });

    it('reports a current claim with no allocation as not-allocated, not stale', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      // The claim is current; there is simply nothing to terminate. Saying
      // `stale` here would tell a caller its authority was gone and make it
      // re-read instead of proving absence.
      await expect(authority.recordAllocationTerminated({ claim, evidence: makeEvidence() })).resolves.toEqual({
        kind: 'not-allocated',
      });
      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        obligation: 'provisioning-resolution',
      });
    });

    it('retains the current obligation and increments failures on uncertainty', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const evidence = makeEvidence({ summary: 'provider request timed out', code: 'timeout' });

      await expect(authority.recordProviderOperationUncertainty({ claim, evidence })).resolves.toEqual({
        kind: 'recorded',
      });
      await authority.recordProviderOperationUncertainty({ claim, evidence });

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        obligation: 'provisioning-resolution',
        failureCount: 2,
        lastFailure: evidence,
      });
      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'provisioning',
        settlementKind: null,
      });
    });

    it('persists bounded evidence as a structured record rather than a message string', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const evidence = makeEvidence({ code: 'quota-exceeded' });

      await authority.recordProviderOperationUncertainty({ claim, evidence });

      const operation = await authority.getProviderOperation(attempt.executionAttemptId);
      expect(operation?.lastFailure).toEqual({
        source: evidence.source,
        summary: evidence.summary,
        observedAt: evidence.observedAt,
        code: 'quota-exceeded',
      });
    });

    it('rejects evidence that exceeds the bounded contract limits', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(
        authority.recordProviderOperationUncertainty({
          claim,
          evidence: makeEvidence({ summary: 'x'.repeat(513) }),
        }),
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────
  // Allocation Recording
  // ─────────────────────────────────────────────────────────

  describe('allocation recording', () => {
    it('records the allocation reference through the repository', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(authority.recordAllocation({ claim, allocationRef })).resolves.toEqual({ kind: 'recorded' });

      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored?.allocationRef).toEqual(allocationRef);
      expect(stored?.status).toBe('allocated');
      expect(stored?.claimable).toBe(true);
    });

    it('treats an identical re-record as a duplicate and a different one as a conflict', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef });

      await expect(authority.recordAllocation({ claim, allocationRef })).resolves.toEqual({
        kind: 'duplicate',
        allocationRef,
      });
      await expect(
        authority.recordAllocation({ claim, allocationRef: makeAllocationRef(TEST_PROVIDER_ID, { machineId: 'm2' }) }),
      ).resolves.toEqual({ kind: 'conflict', allocationRef });
    });

    it('reports not-found for a claim on an attempt that was never created', async () => {
      await expect(
        authority.recordAllocation({
          claim: {
            executionAttemptId: 'nonexistent-attempt',
            generation: 1,
            ownerId: TEST_OWNER_ID,
            token: 'token-1',
            leaseExpiresAt: leaseAt(60_000),
          },
          allocationRef: makeAllocationRef(),
        }),
      ).resolves.toEqual({ kind: 'not-found' });
    });

    it('cannot record an allocation after proven absence settles the attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiter = authority.waitForOutcome(attempt.executionAttemptId);
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(
        authority.recordProvisioningAbsent({ claim, executionId: 'exec-1', evidence: makeEvidence() }),
      ).resolves.toEqual({ kind: 'recorded' });
      await expect(waiter).rejects.toThrow('produced no allocation');
      await expect(authority.recordAllocation({ claim, allocationRef: makeAllocationRef() })).resolves.toEqual({
        kind: 'resolved',
        allocationRef: null,
      });
    });

    it('never makes a discovered allocation bootstrap-claimable', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const allocationRef = makeAllocationRef();

      await expect(authority.recordDiscoveredAllocation({ claim, allocationRef })).resolves.toEqual({
        kind: 'recorded',
      });

      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'allocated',
        allocationRef,
        claimable: false,
      });
      await expect(authority.getRecoverableAttempts('exec-1')).resolves.toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Proven Pre-Allocation Absence
  // ─────────────────────────────────────────────────────────

  describe('proven provisioning absence', () => {
    it('settles the attempt as abandoned and closes the operation with durable evidence', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiter = authority.waitForOutcome(attempt.executionAttemptId);
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const evidence = makeEvidence({ code: 'rejected-before-side-effect' });

      await authority.recordProvisioningAbsent({ claim, executionId: 'exec-1', evidence });
      await expect(waiter).rejects.toThrow('produced no allocation');

      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'settled',
        settlementKind: 'abandoned',
        claimable: false,
      });
      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        obligation: 'provisioning-resolution',
        ownerId: null,
        token: null,
        leaseExpiresAt: null,
        lastFailure: evidence,
      });
    });

    it('refuses to terminalize an attempt whose allocation won the race', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const allocationRef = makeAllocationRef();
      await authority.recordAllocation({ claim, allocationRef });

      await expect(
        authority.recordProvisioningAbsent({ claim, executionId: 'exec-1', evidence: makeEvidence() }),
      ).resolves.toEqual({ kind: 'allocated', allocationRef });
      expect(repository.attempts.get(attempt.executionAttemptId)?.settlementKind).toBeNull();
    });

    it('refuses a stale claim', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(
        authority.recordProvisioningAbsent({
          claim: { ...claim, generation: claim.generation + 1 },
          executionId: 'exec-1',
          evidence: makeEvidence(),
        }),
      ).resolves.toEqual({ kind: 'stale' });
      expect(repository.attempts.get(attempt.executionAttemptId)?.settlementKind).toBeNull();
    });
  });

  describe('dispatch terminalization', () => {
    it('durably abandons a pending attempt and removes its waiter', async () => {
      const attempt = await authority.createAttempt('exec-1');

      await expect(authority.abandonPendingAttempt(attempt.executionAttemptId, 'exec-1')).resolves.toEqual({
        kind: 'abandoned',
      });
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeUndefined();
      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'settled',
        settlementKind: 'abandoned',
      });
    });

    it('keeps an allocated attempt out of the pending abandonment transition', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      await expect(authority.abandonPendingAttempt(attempt.executionAttemptId, 'exec-1')).resolves.toEqual({
        kind: 'allocated',
      });
      expect(repository.attempts.get(attempt.executionAttemptId)?.status).toBe('allocated');
    });

    it('keeps a provisioning attempt out of the pending abandonment transition', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(authority.abandonPendingAttempt(attempt.executionAttemptId, 'exec-1')).resolves.toEqual({
        kind: 'provisioning',
      });
      expect(repository.attempts.get(attempt.executionAttemptId)?.status).toBe('provisioning');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Active Attempt Lookup
  // ─────────────────────────────────────────────────────────

  describe('active attempt lookup', () => {
    it('returns the active attempt when it is the latest for the execution', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const active = await authority.getActiveAttempt('exec-1', attempt.executionAttemptId);

      expect(active).toEqual(
        expect.objectContaining({
          executionAttemptId: attempt.executionAttemptId,
          executionId: 'exec-1',
        }),
      );
    });

    it('returns null when the attempt has been superseded', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      await authority.createAttempt('exec-1'); // supersedes attempt1

      const active = await authority.getActiveAttempt('exec-1', attempt1.executionAttemptId);
      expect(active).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // Accepted Outcome
  // ─────────────────────────────────────────────────────────

  describe('accepted outcome', () => {
    it('commits the result and returns an accepted decision without settling the waiter', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeCompletedResult('exec-1');

      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );

      expect(decision.kind).toBe('accepted');
      expect(decision).toEqual({
        kind: 'accepted',
        outcome: result,
        text: authority.canonicalizeOutcome(result).text,
      });

      // commitOutcome no longer settles the waiter for accepted outcomes —
      // the caller must invoke settleOutcome after convergence succeeds.
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeDefined();
    });

    it('resolves the waiter promise only after settleOutcome is called', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeCompletedResult('exec-1');

      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      expect(waiterPromise).toBeDefined();

      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );

      // Waiter is NOT resolved yet — convergence has not happened.
      // Settle it explicitly to simulate post-convergence settlement.
      authority.settleOutcome(attempt.executionAttemptId, decision);

      await expect(waiterPromise).resolves.toEqual(result);
    });

    it('accepts a failed result as a valid terminal outcome', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeFailedResult('exec-1');

      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );

      expect(decision).toEqual({
        kind: 'accepted',
        outcome: result,
        text: authority.canonicalizeOutcome(result).text,
      });
    });

    it('accepts a worker outcome regardless of who owns the provider operation', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        leaseExpiresAt: leaseAt(-1_000),
      });
      await authority.takeOverProviderOperation({
        executionAttemptId: attempt.executionAttemptId,
        ownerId: 'controller-incarnation-2',
        observedAt: new Date().toISOString(),
        leaseExpiresAt: leaseAt(60_000),
      });

      const result = makeCompletedResult('exec-1');
      await expect(
        authority.commitOutcome(attempt.executionAttemptId, 'exec-1', authority.canonicalizeOutcome(result)),
      ).resolves.toEqual({
        kind: 'accepted',
        outcome: result,
        text: authority.canonicalizeOutcome(result).text,
      });
    });

    it('closes the provider operation when the attempt settles', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(makeCompletedResult('exec-1')),
      );
      authority.settleOutcome(attempt.executionAttemptId, decision);

      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        ownerId: null,
        token: null,
        leaseExpiresAt: null,
      });
      await expect(authority.recordProviderOperationUncertainty({ claim, evidence: makeEvidence() })).resolves.toEqual({
        kind: 'resolved',
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Identical Replay (Duplicate)
  // ─────────────────────────────────────────────────────────

  describe('identical replay', () => {
    it('returns duplicate with the previously accepted outcome for exact replay', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeCompletedResult('exec-1');

      await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', authority.canonicalizeOutcome(result));

      // Replay the same outcome
      const replayDecision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );

      expect(replayDecision.kind).toBe('duplicate');
      // The text is the one the first commit stored, which the replay's own
      // rendering equals here because both render the same result.
      expect(replayDecision).toEqual({
        kind: 'duplicate',
        outcome: result,
        text: authority.canonicalizeOutcome(result).text,
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Conflict
  // ─────────────────────────────────────────────────────────

  describe('conflicting outcome', () => {
    it('returns conflict when a different outcome is submitted for the same attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');
      // Capture the waiter so its conflict rejection doesn't leak as unhandled.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      const result1 = makeCompletedResult('exec-1');
      const result2 = makeFailedResult('exec-1');

      await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', authority.canonicalizeOutcome(result1));

      const conflictDecision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result2),
      );

      expect(conflictDecision).toEqual({ kind: 'conflict' });
      // Drain the waiter rejection so it doesn't leak.
      await expect(waiterPromise).rejects.toThrow('conflict');
    });

    it('leaves the waiter pending after accepted commit and rejects on conflict', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      const result1 = makeCompletedResult('exec-1');
      await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', authority.canonicalizeOutcome(result1));

      // commitOutcome no longer settles the waiter for accepted outcomes.
      // A subsequent conflict commit rejects it.
      const result2 = makeFailedResult('exec-1');
      const conflictDecision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result2),
      );
      expect(conflictDecision).toEqual({ kind: 'conflict' });

      await expect(waiterPromise).rejects.toThrow('conflict');
    });

    it('returns conflict for an outcome that lost the terminal race to an infrastructure failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      await terminateAllocation(authority, claim);

      // Drain the waiter the infrastructure failure rejects.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'recorded',
      });
      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      // The late worker outcome lost; it may not rewrite the settlement.
      const lateDecision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(makeCompletedResult('exec-1')),
      );

      expect(lateDecision).toEqual({ kind: 'conflict' });
      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'settled',
        settlementKind: 'infrastructure-failure',
      });
      expect(repository.committedOutcomes.has(attempt.executionAttemptId)).toBe(false);
    });

    it('returns conflict for an outcome that lost the terminal race to proven absence', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      await expect(
        authority.recordProvisioningAbsent({ claim, executionId: 'exec-1', evidence: makeEvidence() }),
      ).resolves.toEqual({ kind: 'recorded' });
      await expect(waiterPromise).rejects.toThrow();

      const lateDecision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(makeCompletedResult('exec-1')),
      );

      expect(lateDecision).toEqual({ kind: 'conflict' });
      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'settled',
        settlementKind: 'abandoned',
      });
      expect(repository.committedOutcomes.has(attempt.executionAttemptId)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Fence
  // ─────────────────────────────────────────────────────────

  describe('fenced attempt', () => {
    it('returns fenced when the attempt is no longer active', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      const waiterPromise1 = authority.waitForOutcome(attempt1.executionAttemptId);

      // Create a second attempt, which supersedes the first
      await authority.createAttempt('exec-1');

      const result = makeCompletedResult('exec-1');
      const fencedDecision = await authority.commitOutcome(
        attempt1.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );

      expect(fencedDecision).toEqual({ kind: 'fenced' });

      // The waiter for the fenced attempt should be rejected
      await expect(waiterPromise1).rejects.toThrow('has been fenced');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Pause Settlement
  // ─────────────────────────────────────────────────────────

  describe('paused outcome', () => {
    it('commits the paused result and leaves the waiter pending until explicit settlement', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      const pausedResult = makePausedResult('exec-1');

      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(pausedResult),
      );

      expect(decision).toEqual({
        kind: 'accepted',
        outcome: pausedResult,
        text: authority.canonicalizeOutcome(pausedResult).text,
      });

      // The waiter is NOT resolved yet — convergence must happen first.
      // Settle it explicitly to simulate post-convergence settlement.
      authority.settleOutcome(attempt.executionAttemptId, decision);
      await expect(waiterPromise).resolves.toEqual(pausedResult);
    });

    it('allows a new attempt to be created after pause settlement', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      const pausedResult = makePausedResult('exec-1');

      await authority.commitOutcome(attempt1.executionAttemptId, 'exec-1', authority.canonicalizeOutcome(pausedResult));

      // Resume creates a new attempt
      const attempt2 = await authority.createAttempt('exec-1');

      expect(attempt2.executionAttemptId).not.toBe(attempt1.executionAttemptId);
      expect(attempt2.status).toBe('pending');

      // The new attempt should be the active one
      const active = await authority.getActiveAttempt('exec-1', attempt2.executionAttemptId);
      expect(active).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // Waiter Management
  // ─────────────────────────────────────────────────────────

  describe('waiter management', () => {
    it('returns undefined from waitForOutcome for unknown attempts', () => {
      const result = authority.waitForOutcome('nonexistent');
      expect(result).toBeUndefined();
    });

    it('discards a waiter without settling it', async () => {
      const attempt = await authority.createAttempt('exec-1');
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeDefined();

      authority.discardWaiter(attempt.executionAttemptId);

      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeUndefined();
    });

    it('rejects and discards a local waiter without changing durable state', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiter = authority.waitForOutcome(attempt.executionAttemptId);
      const localFailure = new Error('local cleanup needs recovery');

      authority.rejectAndDiscardWaiter(attempt.executionAttemptId, localFailure);

      await expect(waiter).rejects.toBe(localFailure);
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeUndefined();
      await expect(authority.getActiveAttempt('exec-1', attempt.executionAttemptId)).resolves.toMatchObject({
        status: 'pending',
      });
    });

    it('cleans up the waiter after explicit settlement via settleOutcome', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeCompletedResult('exec-1');

      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );
      // Waiter still exists after commit (not settled yet).
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeDefined();

      authority.settleOutcome(attempt.executionAttemptId, decision);
      // After explicit settlement the waiter is removed.
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeUndefined();
    });

    it('leaves the waiter pending on handoff and on uncertainty', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      const waiter = authority.waitForOutcome(attempt.executionAttemptId);

      await authority.recordProviderOperationUncertainty({ claim, evidence: makeEvidence() });
      await authority.handoffProviderOperation({ claim });

      expect(waiter).toBeDefined();
      let settled = false;
      void waiter?.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Create-Before-Dispatch Invariant
  // ─────────────────────────────────────────────────────────

  describe('create-before-dispatch invariant', () => {
    it('the repository records the attempt before any allocation can be recorded', async () => {
      const attempt = await authority.createAttempt('exec-1');

      // At this point the repository already has the attempt
      expect(repository.attempts.has(attempt.executionAttemptId)).toBe(true);

      // Only then can allocation be recorded
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef });

      expect(repository.attempts.get(attempt.executionAttemptId)?.allocationRef).toEqual(allocationRef);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Recovery Support Detection
  // ─────────────────────────────────────────────────────────

  describe('recovery support detection', () => {
    it('reports recovery support when repository implements all recovery operations', () => {
      // The InMemoryAttemptRepository implements all recovery ops.
      expect(authority.supportsRecovery).toBe(true);
    });

    it('reports no recovery support for a minimal repository', () => {
      const minimalAuthority = new ExecutionAttemptAuthority(createMinimalRepository());

      expect(minimalAuthority.supportsRecovery).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Allocation Lookup
  // ─────────────────────────────────────────────────────────

  describe('allocation lookup', () => {
    it('looks up an attempt with its allocation data by attempt ID', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef });

      const found = await authority.getAttemptWithAllocation(attempt.executionAttemptId);

      expect(found).not.toBeNull();
      expect(found!.executionAttemptId).toBe(attempt.executionAttemptId);
      expect(found!.allocationRef).toEqual(allocationRef);
      expect(found!.status).toBe('allocated');
    });

    it('returns null for a nonexistent attempt', async () => {
      const found = await authority.getAttemptWithAllocation('nonexistent');
      expect(found).toBeNull();
    });

    it('returns a settled attempt (unlike getActiveAttempt)', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      const result = makeCompletedResult('exec-1');
      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(attempt.executionAttemptId, decision);

      // getActiveAttempt would return null for a settled attempt that has
      // been superseded, but getAttemptWithAllocation always returns.
      const found = await authority.getAttemptWithAllocation(attempt.executionAttemptId);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('settled');
      expect(found!.settlementKind).toBe('outcome');
    });

    it('returns a superseded attempt', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt1.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef });

      // Supersede with a new attempt
      await authority.createAttempt('exec-1');

      // getActiveAttempt returns null for superseded
      const active = await authority.getActiveAttempt('exec-1', attempt1.executionAttemptId);
      expect(active).toBeNull();

      // getAttemptWithAllocation still returns the superseded attempt
      const found = await authority.getAttemptWithAllocation(attempt1.executionAttemptId);
      expect(found).not.toBeNull();
      expect(found!.allocationRef).toEqual(allocationRef);
    });

    it('returns a pending attempt with null allocation', async () => {
      const attempt = await authority.createAttempt('exec-1');

      const found = await authority.getAttemptWithAllocation(attempt.executionAttemptId);
      expect(found).not.toBeNull();
      expect(found!.allocationRef).toBeNull();
      expect(found!.status).toBe('pending');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Allocation Ref Evolution (Compare-And-Set)
  // ─────────────────────────────────────────────────────────

  describe('allocation ref evolution', () => {
    it('evolves the allocation ref when CAS check passes', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const initialRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: initialRef });

      const evolvedRef = makeCorrelatedAllocationRef();
      const decision = await authority.evolveAllocationRef({
        claim,
        executionId: 'exec-1',
        currentRef: initialRef,
        nextRef: evolvedRef,
      });

      expect(decision.kind).toBe('evolved');

      // Verify the stored ref was updated
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored!.allocationRef).toEqual(evolvedRef);
    });

    it('rejects evolution when currentRef does not match stored ref (stale)', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const initialRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: initialRef });

      const staleRef = makeAllocationRef(TEST_PROVIDER_ID, {
        machineId: 'wrong-machine',
      });

      const decision = await authority.evolveAllocationRef({
        claim,
        executionId: 'exec-1',
        currentRef: staleRef,
        nextRef: makeCorrelatedAllocationRef(),
      });

      expect(decision).toEqual({ kind: 'stale', storedRef: initialRef });

      // Verify the stored ref was NOT updated
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored!.allocationRef).toEqual(initialRef);
    });

    it('rejects evolution presented with a superseded claim', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        leaseExpiresAt: leaseAt(-1_000),
      });
      await authority.recordAllocation({ claim, allocationRef });
      await authority.takeOverProviderOperation({
        executionAttemptId: attempt.executionAttemptId,
        ownerId: 'controller-incarnation-2',
        observedAt: new Date().toISOString(),
        leaseExpiresAt: leaseAt(60_000),
      });

      const decision = await authority.evolveAllocationRef({
        claim,
        executionId: 'exec-1',
        currentRef: allocationRef,
        nextRef: makeCorrelatedAllocationRef(),
      });

      expect(decision).toEqual({ kind: 'stale', storedRef: allocationRef });
    });

    it('rejects evolution for an attempt without an allocation', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      const decision = await authority.evolveAllocationRef({
        claim,
        executionId: 'exec-1',
        currentRef: makeAllocationRef(),
        nextRef: makeCorrelatedAllocationRef(),
      });

      expect(decision.kind).toBe('not-allocated');
    });

    it('rejects evolution when provider identity changes', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const initialRef = makeAllocationRef('provider-a');
      // The attempt is bound to the provider its reference names: a
      // mismatched pair there is a caller bug of its own, and this test is
      // about the evolution rather than about the initial record.
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1', {
        providerId: 'provider-a',
      });
      await authority.recordAllocation({ claim, allocationRef: initialRef });

      // Try to evolve to a different provider — the Authority rejects
      // before delegating to the repository.
      await expect(
        authority.evolveAllocationRef({
          claim,
          executionId: 'exec-1',
          currentRef: initialRef,
          nextRef: makeAllocationRef('provider-b'),
        }),
      ).rejects.toThrow('Provider identity mismatch');
    });

    it('supports sequential evolutions (CAS chain)', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const ref1 = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: ref1 });

      // First evolution: dispatch -> run correlation
      const ref2 = makeCorrelatedAllocationRef(TEST_PROVIDER_ID, 'run-1', 'job-1');
      const d1 = await authority.evolveAllocationRef({
        claim,
        executionId: 'exec-1',
        currentRef: ref1,
        nextRef: ref2,
      });
      expect(d1.kind).toBe('evolved');

      // Second evolution: run -> full job correlation
      const ref3 = makeCorrelatedAllocationRef(TEST_PROVIDER_ID, 'run-1', 'job-2');
      const d2 = await authority.evolveAllocationRef({
        claim,
        executionId: 'exec-1',
        currentRef: ref2,
        nextRef: ref3,
      });
      expect(d2.kind).toBe('evolved');

      // Verify final state
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored!.allocationRef).toEqual(ref3);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Recoverable Active Attempts
  // ─────────────────────────────────────────────────────────

  describe('recoverable active attempts', () => {
    it('lists allocated non-settled attempts for an execution', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef });

      const recoverable = await authority.getRecoverableAttempts('exec-1');

      expect(recoverable).toHaveLength(1);
      expect(recoverable[0].executionAttemptId).toBe(attempt.executionAttemptId);
      expect(recoverable[0].allocationRef).toEqual(allocationRef);
      expect(recoverable[0].status).toBe('allocated');
      expect(recoverable[0].claimable).toBe(true);
      expect(recoverable[0].settlementKind).toBeNull();
      expect(recoverable[0].providerId).toBe(TEST_PROVIDER_ID);
      expect(recoverable[0].allocationLifetime).toBe('provider-managed');
      expect(recoverable[0].provisionerIncarnationId).toBe(TEST_PROVISIONER_INCARNATION_ID);
    });

    it('excludes pending attempts (no allocation)', async () => {
      await authority.createAttempt('exec-1');

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('excludes settled attempts (outcome committed)', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      const result = makeCompletedResult('exec-1');
      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(attempt.executionAttemptId, decision);

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('excludes attempts settled by infrastructure failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      await terminateAllocation(authority, claim);

      // Drain the waiter rejection from recordInfrastructureFailure.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      await authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' });

      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('excludes paused (settled) attempts', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      const pausedResult = makePausedResult('exec-1');
      const decision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(pausedResult),
      );
      authority.settleOutcome(attempt.executionAttemptId, decision);

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('returns empty for an execution with no attempts', async () => {
      const recoverable = await authority.getRecoverableAttempts('nonexistent');
      expect(recoverable).toHaveLength(0);
    });

    it('returns empty for a different execution', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      const recoverable = await authority.getRecoverableAttempts('exec-2');
      expect(recoverable).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Confirmed Infrastructure Failure
  // ─────────────────────────────────────────────────────────

  describe('confirmed infrastructure failure', () => {
    it('records an infrastructure failure for an allocated attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      await terminateAllocation(authority, claim);

      // Drain the waiter.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      const decision = await authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' });

      expect(decision.kind).toBe('recorded');
      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      // Verify the record was updated and the operation closed.
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored!.status).toBe('settled');
      expect(stored!.settlementKind).toBe('infrastructure-failure');
      expect(stored!.claimable).toBe(false);
      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        ownerId: null,
        token: null,
      });
    });

    it('returns resolved for a previously committed outcome', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      const result = makeCompletedResult('exec-1');
      const outcomeDecision = await authority.commitOutcome(
        attempt.executionAttemptId,
        'exec-1',
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(attempt.executionAttemptId, outcomeDecision);

      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'resolved',
      });
    });

    it('returns resolved for a previously recorded infrastructure failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      await terminateAllocation(authority, claim);

      // Drain the waiter from the first failure.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      await authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' });
      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      // Second call is idempotent
      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'resolved',
      });
    });

    it('keeps a superseded attempt remediable without reactivating it', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt1.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });
      await terminateAllocation(authority, claim);

      // Supersede
      const attempt2 = await authority.createAttempt('exec-1');

      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'recorded',
      });
      expect(repository.attempts.get(attempt1.executionAttemptId)).toMatchObject({
        status: 'settled',
        settlementKind: 'infrastructure-failure',
        claimable: false,
      });
      // The active-attempt pointer is untouched by remediation.
      expect(repository.activeAttempts.get('exec-1')).toBe(attempt2.executionAttemptId);
    });

    it('refuses to settle an allocation whose termination was never confirmed', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'not-terminated',
      });

      // A refused settlement changes nothing a runner could observe: the
      // attempt still owns its allocation and its waiter stays open.
      expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
        status: 'allocated',
        settlementKind: null,
      });
      await expect(authority.getProviderOperation(attempt.executionAttemptId)).resolves.toMatchObject({
        obligation: 'allocation-control',
        ownerId: TEST_OWNER_ID,
      });
    });

    it('returns not-allocated for an attempt that never received an allocation', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');

      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'not-allocated',
      });
    });

    it('returns not-found when the execution does not own the attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const claim = await beginTestProvisioning(authority, attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation({ claim, allocationRef: makeAllocationRef() });

      await expect(authority.recordInfrastructureFailure({ claim, executionId: 'exec-other' })).resolves.toEqual({
        kind: 'not-found',
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Recovery Operation Rejection Without Support
  // ─────────────────────────────────────────────────────────

  describe('recovery operation rejection without support', () => {
    let minimalAuthority: ExecutionAttemptAuthority<WorkflowRunResult>;
    const claim: ProviderOperationClaim = {
      executionAttemptId: 'attempt-1',
      generation: 1,
      ownerId: TEST_OWNER_ID,
      token: 'token-1',
      leaseExpiresAt: leaseAt(60_000),
    };

    beforeEach(() => {
      minimalAuthority = new ExecutionAttemptAuthority(createMinimalRepository());
    });

    it('throws on getAttemptWithAllocation', async () => {
      await expect(minimalAuthority.getAttemptWithAllocation('attempt-1')).rejects.toThrow('does not support recovery');
    });

    it('throws on recordDiscoveredAllocation', async () => {
      await expect(
        minimalAuthority.recordDiscoveredAllocation({ claim, allocationRef: makeAllocationRef() }),
      ).rejects.toThrow('does not support recovery');
    });

    it('throws on evolveAllocationRef', async () => {
      await expect(
        minimalAuthority.evolveAllocationRef({
          claim,
          executionId: 'exec-1',
          currentRef: makeAllocationRef(),
          nextRef: makeCorrelatedAllocationRef(),
        }),
      ).rejects.toThrow('does not support recovery');
    });

    it('throws on getRecoverableAttempts', async () => {
      await expect(minimalAuthority.getRecoverableAttempts('exec-1')).rejects.toThrow('does not support recovery');
    });

    it('uses infrastructure settlement without requiring recovery queries', async () => {
      await expect(minimalAuthority.recordInfrastructureFailure({ claim, executionId: 'exec-1' })).resolves.toEqual({
        kind: 'not-found',
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Construction Gates
// ─────────────────────────────────────────────────────────────

describe('construction gates', () => {
  it('framework-only/in-process boots without a repository', () => {
    // No executionAttemptRepository -> no authority, service still constructs
    const service = new WorkflowEngineService(MakaioBus);
    expect(service.executionAttemptAuthority).toBeUndefined();
  });

  it('service exposes the Authority when a repository is injected', () => {
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    const service = new WorkflowEngineService(MakaioBus, {
      executionAttemptRepository: repository,
    });
    expect(service.executionAttemptAuthority).toBeInstanceOf(ExecutionAttemptAuthority);
  });

  it('Piscina mode boots without a repository', () => {
    // Piscina mode does not require attempt tracking
    const service = new WorkflowEngineService(MakaioBus, {
      workflowRunner: undefined,
    });
    expect(service.executionAttemptAuthority).toBeUndefined();
  });
});
