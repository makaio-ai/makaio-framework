import { describe, expect, it, beforeEach } from 'vitest';
import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import { PROVIDER_ALLOCATION_REF_VERSION } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowEngineService } from '../workflow-engine-service.js';
import type { ExecutionAttemptRepository } from '../execution-attempt-repository.js';
import {
  createInMemoryAttemptRepository,
  type InMemoryAttemptRepository,
} from './fixtures/in-memory-attempt-repository.js';

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
  providerId: string = 'test-provider',
  data: Record<string, unknown> = { machineId: 'machine-1' },
): ProviderAllocationRef {
  return {
    version: PROVIDER_ALLOCATION_REF_VERSION,
    providerId,
    providerData: data,
  };
}

/**
 * Create a "correlated" allocation ref with additional run/job identity,
 * simulating GitHub Actions run correlation after dispatch.
 * @param providerId - Provider identifier.
 * @param runId - Correlated run identifier.
 * @param jobId - Correlated job identifier.
 * @returns Evolved allocation reference with correlation data.
 */
function makeCorrelatedAllocationRef(
  providerId: string = 'test-provider',
  runId: string = 'run-123',
  jobId: string = 'job-456',
): ProviderAllocationRef {
  return {
    version: PROVIDER_ALLOCATION_REF_VERSION,
    providerId,
    providerData: { machineId: 'machine-1', runId, jobId },
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('ExecutionAttemptAuthority', () => {
  let repository: InMemoryAttemptRepository;
  let authority: ExecutionAttemptAuthority;

  beforeEach(() => {
    repository = createInMemoryAttemptRepository();
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

    it('returns a record with status pending and no allocation', async () => {
      const attempt = await authority.createAttempt('exec-1');

      expect(attempt.status).toBe('pending');
      expect(attempt.allocationRef).toBeNull();
      expect(attempt.createdAt).toBeTruthy();
    });

    it('installs an in-process waiter that can be awaited', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      expect(waiterPromise).toBeInstanceOf(Promise);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Allocation Recording
  // ─────────────────────────────────────────────────────────

  describe('allocation recording', () => {
    it('records the allocation reference through the repository', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();

      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored?.allocationRef).toEqual(allocationRef);
      expect(stored?.status).toBe('allocated');
    });

    it('cannot record an allocation after provisioning failure settles the attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiter = authority.waitForOutcome(attempt.executionAttemptId);
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');

      await expect(authority.recordProvisioningFailure(attempt.executionAttemptId, 'exec-1')).resolves.toEqual({
        kind: 'recorded',
      });
      await expect(waiter).rejects.toThrow('provider provisioning failed');
      await expect(authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef())).resolves.toEqual({
        kind: 'already-settled',
        allocationRef: null,
      });
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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef());

      await expect(authority.abandonPendingAttempt(attempt.executionAttemptId, 'exec-1')).resolves.toEqual({
        kind: 'allocated',
      });
      expect(repository.attempts.get(attempt.executionAttemptId)?.status).toBe('allocated');
    });

    it('keeps a provisioning attempt out of the pending abandonment transition', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');

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

      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);

      expect(decision.kind).toBe('accepted');
      expect(decision).toEqual({ kind: 'accepted', outcome: result });

      // commitOutcome no longer settles the waiter for accepted outcomes —
      // the caller must invoke settleOutcome after convergence succeeds.
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeDefined();
    });

    it('resolves the waiter promise only after settleOutcome is called', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeCompletedResult('exec-1');

      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      expect(waiterPromise).toBeDefined();

      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);

      // Waiter is NOT resolved yet — convergence has not happened.
      // Settle it explicitly to simulate post-convergence settlement.
      authority.settleOutcome(attempt.executionAttemptId, decision);

      await expect(waiterPromise).resolves.toEqual(result);
    });

    it('accepts a failed result as a valid terminal outcome', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeFailedResult('exec-1');

      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);

      expect(decision).toEqual({ kind: 'accepted', outcome: result });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Identical Replay (Duplicate)
  // ─────────────────────────────────────────────────────────

  describe('identical replay', () => {
    it('returns duplicate with the previously accepted outcome for exact replay', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const result = makeCompletedResult('exec-1');

      await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);

      // Replay the same outcome
      const replayDecision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);

      expect(replayDecision.kind).toBe('duplicate');
      expect(replayDecision).toEqual({ kind: 'duplicate', outcome: result });
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

      await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result1);

      const conflictDecision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result2);

      expect(conflictDecision).toEqual({ kind: 'conflict' });
      // Drain the waiter rejection so it doesn't leak.
      await expect(waiterPromise).rejects.toThrow('conflict');
    });

    it('leaves the waiter pending after accepted commit and rejects on conflict', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      const result1 = makeCompletedResult('exec-1');
      await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result1);

      // commitOutcome no longer settles the waiter for accepted outcomes.
      // A subsequent conflict commit rejects it.
      const result2 = makeFailedResult('exec-1');
      const conflictDecision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result2);
      expect(conflictDecision).toEqual({ kind: 'conflict' });

      await expect(waiterPromise).rejects.toThrow('conflict');
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
      const fencedDecision = await authority.commitOutcome(attempt1.executionAttemptId, 'exec-1', result);

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

      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', pausedResult);

      expect(decision).toEqual({ kind: 'accepted', outcome: pausedResult });

      // The waiter is NOT resolved yet — convergence must happen first.
      // Settle it explicitly to simulate post-convergence settlement.
      authority.settleOutcome(attempt.executionAttemptId, decision);
      await expect(waiterPromise).resolves.toEqual(pausedResult);
    });

    it('allows a new attempt to be created after pause settlement', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      const pausedResult = makePausedResult('exec-1');

      await authority.commitOutcome(attempt1.executionAttemptId, 'exec-1', pausedResult);

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

      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);
      // Waiter still exists after commit (not settled yet).
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeDefined();

      authority.settleOutcome(attempt.executionAttemptId, decision);
      // After explicit settlement the waiter is removed.
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeUndefined();
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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      expect(repository.attempts.get(attempt.executionAttemptId)?.allocationRef).toEqual(allocationRef);
    });

    it('allocation recording fails for an attempt that was never created', async () => {
      const allocationRef = makeAllocationRef();

      await expect(authority.recordAllocation('nonexistent-attempt', allocationRef)).resolves.toEqual({
        kind: 'fenced',
        allocationRef: null,
      });
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
      const minimalRepo: ExecutionAttemptRepository = {
        createAttempt: async (input) => ({
          executionAttemptId: input.executionAttemptId,
          executionId: input.executionId,
          status: 'pending' as const,
          allocationRef: null,
          createdAt: new Date().toISOString(),
        }),
        beginProvisioning: async () => ({ kind: 'started' as const }),
        recordAllocation: async () => ({ kind: 'recorded' as const }),
        recordProvisioningFailure: async () => ({ kind: 'recorded' as const }),
        getActiveAttempt: async () => null,
        commitOutcome: async () => ({ kind: 'fenced' as const }),
        abandonPendingAttempt: async () => ({ kind: 'fenced' as const }),
        recordInfrastructureFailure: async () => ({ kind: 'fenced' as const }),
      };
      const minimalAuthority = new ExecutionAttemptAuthority(minimalRepo);

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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

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
      const allocationRef = makeAllocationRef();
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);
      const result = makeCompletedResult('exec-1');
      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);
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
      await authority.beginProvisioning(attempt1.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt1.executionAttemptId, allocationRef);

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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, initialRef);

      const evolvedRef = makeCorrelatedAllocationRef();
      const decision = await authority.evolveAllocationRef({
        executionAttemptId: attempt.executionAttemptId,
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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, initialRef);

      const staleRef = makeAllocationRef('test-provider', {
        machineId: 'wrong-machine',
      });
      const evolvedRef = makeCorrelatedAllocationRef();

      const decision = await authority.evolveAllocationRef({
        executionAttemptId: attempt.executionAttemptId,
        executionId: 'exec-1',
        currentRef: staleRef,
        nextRef: evolvedRef,
      });

      expect(decision.kind).toBe('stale');
      if (decision.kind === 'stale') {
        expect(decision.storedRef).toEqual(initialRef);
      }

      // Verify the stored ref was NOT updated
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored!.allocationRef).toEqual(initialRef);
    });

    it('rejects evolution for a fenced attempt', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      await authority.beginProvisioning(attempt1.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt1.executionAttemptId, allocationRef);

      // Supersede with a new attempt
      await authority.createAttempt('exec-1');

      const decision = await authority.evolveAllocationRef({
        executionAttemptId: attempt1.executionAttemptId,
        executionId: 'exec-1',
        currentRef: allocationRef,
        nextRef: makeCorrelatedAllocationRef(),
      });

      expect(decision.kind).toBe('fenced');
    });

    it('rejects evolution for an attempt without an allocation', async () => {
      const attempt = await authority.createAttempt('exec-1');

      const decision = await authority.evolveAllocationRef({
        executionAttemptId: attempt.executionAttemptId,
        executionId: 'exec-1',
        currentRef: makeAllocationRef(),
        nextRef: makeCorrelatedAllocationRef(),
      });

      expect(decision.kind).toBe('not-allocated');
    });

    it('rejects evolution when provider identity changes', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const initialRef = makeAllocationRef('provider-a');
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, initialRef);

      // Try to evolve to a different provider — the Authority rejects
      // before delegating to the repository.
      await expect(
        authority.evolveAllocationRef({
          executionAttemptId: attempt.executionAttemptId,
          executionId: 'exec-1',
          currentRef: initialRef,
          nextRef: makeAllocationRef('provider-b'),
        }),
      ).rejects.toThrow('Provider identity mismatch');
    });

    it('supports sequential evolutions (CAS chain)', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const ref1 = makeAllocationRef();
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, ref1);

      // First evolution: dispatch -> run correlation
      const ref2 = makeCorrelatedAllocationRef('test-provider', 'run-1', 'job-1');
      const d1 = await authority.evolveAllocationRef({
        executionAttemptId: attempt.executionAttemptId,
        executionId: 'exec-1',
        currentRef: ref1,
        nextRef: ref2,
      });
      expect(d1.kind).toBe('evolved');

      // Second evolution: run -> full job correlation
      const ref3 = makeCorrelatedAllocationRef('test-provider', 'run-1', 'job-2');
      const d2 = await authority.evolveAllocationRef({
        executionAttemptId: attempt.executionAttemptId,
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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      const recoverable = await authority.getRecoverableAttempts('exec-1');

      expect(recoverable).toHaveLength(1);
      expect(recoverable[0].executionAttemptId).toBe(attempt.executionAttemptId);
      expect(recoverable[0].allocationRef).toEqual(allocationRef);
      expect(recoverable[0].status).toBe('allocated');
      expect(recoverable[0].claimable).toBe(true);
      expect(recoverable[0].settlementKind).toBeNull();
    });

    it('excludes pending attempts (no allocation)', async () => {
      await authority.createAttempt('exec-1');

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('excludes settled attempts (outcome committed)', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      const result = makeCompletedResult('exec-1');
      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);
      authority.settleOutcome(attempt.executionAttemptId, decision);

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('excludes attempts settled by infrastructure failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      // Drain the waiter rejection from recordInfrastructureFailure.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');

      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      const recoverable = await authority.getRecoverableAttempts('exec-1');
      expect(recoverable).toHaveLength(0);
    });

    it('excludes paused (settled) attempts', async () => {
      const attempt = await authority.createAttempt('exec-1');
      const allocationRef = makeAllocationRef();
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      const pausedResult = makePausedResult('exec-1');
      const decision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', pausedResult);
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
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef());

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
      const allocationRef = makeAllocationRef();
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, allocationRef);

      // Drain the waiter.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      const decision = await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');

      expect(decision.kind).toBe('recorded');
      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      // Verify the record was updated
      const stored = repository.attempts.get(attempt.executionAttemptId);
      expect(stored!.status).toBe('settled');
      expect(stored!.settlementKind).toBe('infrastructure-failure');
      expect(stored!.claimable).toBe(false);
    });

    it('rejects the in-process waiter on infrastructure failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef());

      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);
      expect(waiterPromise).toBeDefined();

      await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');

      await expect(waiterPromise).rejects.toThrow('provider allocation terminated');

      // Waiter should be cleaned up
      expect(authority.waitForOutcome(attempt.executionAttemptId)).toBeUndefined();
    });

    it('returns already-settled for a previously committed outcome', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef());

      const result = makeCompletedResult('exec-1');
      const outcomeDecision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);
      authority.settleOutcome(attempt.executionAttemptId, outcomeDecision);

      const failureDecision = await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');

      expect(failureDecision.kind).toBe('already-settled');
    });

    it('returns already-settled for a previously recorded infrastructure failure', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef());

      // Drain the waiter from the first failure.
      const waiterPromise = authority.waitForOutcome(attempt.executionAttemptId);

      await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');
      await expect(waiterPromise).rejects.toThrow('infrastructure failure');

      // Second call is idempotent
      const decision = await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');
      expect(decision.kind).toBe('already-settled');
    });

    it('returns fenced for a superseded attempt', async () => {
      const attempt1 = await authority.createAttempt('exec-1');
      await authority.beginProvisioning(attempt1.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt1.executionAttemptId, makeAllocationRef());

      // Supersede
      await authority.createAttempt('exec-1');

      const decision = await authority.recordInfrastructureFailure(attempt1.executionAttemptId, 'exec-1');

      expect(decision.kind).toBe('fenced');
    });

    it('returns not-allocated for a pending attempt', async () => {
      const attempt = await authority.createAttempt('exec-1');

      const decision = await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');

      expect(decision.kind).toBe('not-allocated');
    });

    it('does not reject waiter when decision is not recorded', async () => {
      const attempt = await authority.createAttempt('exec-1');
      await authority.beginProvisioning(attempt.executionAttemptId, 'exec-1');
      await authority.recordAllocation(attempt.executionAttemptId, makeAllocationRef());

      const result = makeCompletedResult('exec-1');
      const outcomeDecision = await authority.commitOutcome(attempt.executionAttemptId, 'exec-1', result);
      authority.settleOutcome(attempt.executionAttemptId, outcomeDecision);

      // Waiter already settled. Infrastructure failure returns
      // already-settled but does not try to reject a missing waiter.
      const decision = await authority.recordInfrastructureFailure(attempt.executionAttemptId, 'exec-1');
      expect(decision.kind).toBe('already-settled');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Recovery Operation Rejection Without Support
  // ─────────────────────────────────────────────────────────

  describe('recovery operation rejection without support', () => {
    let minimalAuthority: ExecutionAttemptAuthority;

    beforeEach(() => {
      const minimalRepo: ExecutionAttemptRepository = {
        createAttempt: async (input) => ({
          executionAttemptId: input.executionAttemptId,
          executionId: input.executionId,
          status: 'pending' as const,
          allocationRef: null,
          createdAt: new Date().toISOString(),
        }),
        beginProvisioning: async () => ({ kind: 'started' as const }),
        recordAllocation: async () => ({ kind: 'recorded' as const }),
        recordProvisioningFailure: async () => ({ kind: 'recorded' as const }),
        getActiveAttempt: async () => null,
        commitOutcome: async () => ({ kind: 'fenced' as const }),
        abandonPendingAttempt: async () => ({ kind: 'fenced' as const }),
        recordInfrastructureFailure: async () => ({ kind: 'fenced' as const }),
      };
      minimalAuthority = new ExecutionAttemptAuthority(minimalRepo);
    });

    it('throws on getAttemptWithAllocation', async () => {
      await expect(minimalAuthority.getAttemptWithAllocation('attempt-1')).rejects.toThrow('does not support recovery');
    });

    it('throws on evolveAllocationRef', async () => {
      await expect(
        minimalAuthority.evolveAllocationRef({
          executionAttemptId: 'attempt-1',
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
      await expect(minimalAuthority.recordInfrastructureFailure('attempt-1', 'exec-1')).resolves.toEqual({
        kind: 'fenced',
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
    const repository = createInMemoryAttemptRepository();
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
