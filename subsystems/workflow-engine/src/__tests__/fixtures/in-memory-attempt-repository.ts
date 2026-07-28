import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import type {
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  ExecutionAttemptCreate,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRepository,
  ExecutionAttemptSettlementKind,
  ExecutionAttemptStatus,
  InfrastructureFailureDecision,
  AllocationRecordingDecision,
  PendingAttemptAbandonmentDecision,
  ProvisioningClaimDecision,
  ProvisioningFailureDecision,
  RecoverableAttemptRecord,
} from '../../execution-attempt-repository.js';

/**
 * Deterministic in-memory implementation of {@link ExecutionAttemptRepository}.
 *
 * Provides predictable durable decisions so tests can assert Authority and
 * submission handler behavior without database infrastructure. Supports the
 * full recovery surface (compare-and-set allocation evolution, infrastructure
 * failure recording, recoverable attempt queries).
 *
 * NOT a production implementation — it is intentionally simple and stateless
 * across tests (each test creates a fresh instance via
 * {@link createInMemoryAttemptRepository}).
 */
export class InMemoryAttemptRepository implements ExecutionAttemptRepository {
  /** All persisted attempt records, keyed by executionAttemptId. */
  public readonly attempts = new Map<string, ExecutionAttemptRecord>();

  /** Committed outcomes, keyed by executionAttemptId. */
  public readonly committedOutcomes = new Map<string, WorkflowRunResult>();

  /** Track the latest active attempt per executionId for fence decisions. */
  public readonly activeAttempts = new Map<string, string>();

  public async createAttempt(
    input: ExecutionAttemptCreate,
  ): Promise<ExecutionAttemptRecord> {
    const record: ExecutionAttemptRecord = {
      executionAttemptId: input.executionAttemptId,
      executionId: input.executionId,
      status: 'pending',
      allocationRef: null,
      createdAt: new Date().toISOString(),
      settlementKind: null,
      claimable: false,
      claimExpiresAt: null,
    };
    this.attempts.set(input.executionAttemptId, record);
    this.activeAttempts.set(input.executionId, input.executionAttemptId);
    return record;
  }

  public async beginProvisioning(
    executionAttemptId: string,
    executionId: string,
  ): Promise<ProvisioningClaimDecision> {
    if (this.activeAttempts.get(executionId) !== executionAttemptId) return { kind: 'fenced' };
    const record = this.attempts.get(executionAttemptId);
    if (!record) return { kind: 'fenced' };
    if (record.status === 'pending') {
      this.attempts.set(executionAttemptId, { ...record, status: 'provisioning' });
      return { kind: 'started' };
    }
    if (record.status === 'provisioning') return { kind: 'already-provisioning' };
    if (record.status === 'allocated') return { kind: 'allocated', allocationRef: record.allocationRef! };
    return { kind: 'already-settled', allocationRef: record.allocationRef };
  }

  public async recordAllocation(
    executionAttemptId: string,
    allocationRef: ProviderAllocationRef,
  ): Promise<AllocationRecordingDecision> {
    const record = this.attempts.get(executionAttemptId);
    if (!record) {
      return { kind: 'fenced', allocationRef: null };
    }
    if (this.activeAttempts.get(record.executionId) !== executionAttemptId) return { kind: 'fenced', allocationRef: record.allocationRef };
    if (record.status === 'allocated') {
      return JSON.stringify(record.allocationRef) === JSON.stringify(allocationRef)
        ? { kind: 'duplicate', allocationRef: record.allocationRef! }
        : { kind: 'conflict', allocationRef: record.allocationRef! };
    }
    if (record.status === 'settled') return { kind: 'already-settled', allocationRef: record.allocationRef };
    if (record.status !== 'provisioning') return { kind: 'fenced', allocationRef: record.allocationRef };
    this.attempts.set(executionAttemptId, {
      ...record,
      status: 'allocated' as ExecutionAttemptStatus,
      allocationRef,
      claimable: true,
    });
    return { kind: 'recorded' };
  }

  public async recordProvisioningFailure(
    executionAttemptId: string,
    executionId: string,
  ): Promise<ProvisioningFailureDecision> {
    if (this.activeAttempts.get(executionId) !== executionAttemptId) return { kind: 'fenced' };
    const record = this.attempts.get(executionAttemptId);
    if (!record) return { kind: 'fenced' };
    if (record.status === 'provisioning') {
      this.attempts.set(executionAttemptId, { ...record, status: 'settled', settlementKind: 'abandoned', claimable: false });
      return { kind: 'recorded' };
    }
    if (record.status === 'allocated') return { kind: 'allocated', allocationRef: record.allocationRef! };
    if (record.status === 'settled') return { kind: 'already-settled', allocationRef: record.allocationRef };
    return { kind: 'not-provisioning' };
  }

  public async getActiveAttempt(
    executionId: string,
    executionAttemptId: string,
  ): Promise<ExecutionAttemptRecord | null> {
    const activeId = this.activeAttempts.get(executionId);
    if (activeId !== executionAttemptId) {
      return null;
    }
    return this.attempts.get(executionAttemptId) ?? null;
  }

  public async commitOutcome(
    input: ExecutionAttemptOutcomeCommit,
  ): Promise<ExecutionAttemptOutcomeDecision> {
    // Fence check: is this attempt still the active one?
    const activeId = this.activeAttempts.get(input.executionId);
    if (activeId !== input.executionAttemptId) {
      return { kind: 'fenced' };
    }

    // Check for prior committed outcome
    const prior = this.committedOutcomes.get(input.executionAttemptId);
    if (prior) {
      // Deep equality for duplicate detection
      if (JSON.stringify(prior) === JSON.stringify(input.result)) {
        return { kind: 'duplicate', outcome: prior };
      }
      return { kind: 'conflict' };
    }

    // First commit: accept
    this.committedOutcomes.set(input.executionAttemptId, input.result);
    const record = this.attempts.get(input.executionAttemptId);
    if (record) {
      this.attempts.set(input.executionAttemptId, {
        ...record,
        status: 'settled',
        settlementKind: 'outcome' as ExecutionAttemptSettlementKind,
        claimable: false,
      });
    }
    return { kind: 'accepted', outcome: input.result };
  }

  // ─────────────────────────────────────────────────────────
  // Recovery Operations
  // ─────────────────────────────────────────────────────────

  public async getAttemptWithAllocation(
    executionAttemptId: string,
  ): Promise<ExecutionAttemptRecord | null> {
    return this.attempts.get(executionAttemptId) ?? null;
  }

  public async evolveAllocationRef(
    input: AllocationRefEvolution,
  ): Promise<AllocationRefEvolutionDecision> {
    // Fence check
    const activeId = this.activeAttempts.get(input.executionId);
    if (activeId !== input.executionAttemptId) {
      return { kind: 'fenced' };
    }

    const record = this.attempts.get(input.executionAttemptId);
    if (!record?.allocationRef) {
      return { kind: 'not-allocated' };
    }

    // CAS check: does currentRef match the stored ref?
    if (
      JSON.stringify(record.allocationRef) !==
      JSON.stringify(input.currentRef)
    ) {
      return {
        kind: 'stale',
        storedRef: record.allocationRef,
      };
    }

    // Apply the evolution
    this.attempts.set(input.executionAttemptId, {
      ...record,
      allocationRef: input.nextRef,
    });
    return { kind: 'evolved' };
  }

  public async getRecoverableAttempts(
    executionId: string,
  ): Promise<readonly RecoverableAttemptRecord[]> {
    const now = new Date().toISOString();
    const results: RecoverableAttemptRecord[] = [];

    for (const record of this.attempts.values()) {
      if (
        record.executionId === executionId &&
        record.status === 'allocated' &&
        record.allocationRef !== null &&
        record.claimable === true &&
        record.settlementKind === null
      ) {
        // Exclude expired claims
        if (record.claimExpiresAt && record.claimExpiresAt < now) {
          continue;
        }
        results.push(record as RecoverableAttemptRecord);
      }
    }

    return results;
  }

  public async recordInfrastructureFailure(
    executionAttemptId: string,
    executionId: string,
  ): Promise<InfrastructureFailureDecision> {
    // Fence check
    const activeId = this.activeAttempts.get(executionId);
    if (activeId !== executionAttemptId) {
      return { kind: 'fenced' };
    }

    const record = this.attempts.get(executionAttemptId);
    if (!record) {
      return { kind: 'fenced' };
    }

    if (!record.allocationRef) {
      return { kind: 'not-allocated' };
    }

    if (record.status === 'settled') {
      return { kind: 'already-settled' };
    }

    this.attempts.set(executionAttemptId, {
      ...record,
      status: 'settled',
      settlementKind:
        'infrastructure-failure' as ExecutionAttemptSettlementKind,
      claimable: false,
    });

    return { kind: 'recorded' };
  }

  public async abandonPendingAttempt(
    executionAttemptId: string,
    executionId: string,
  ): Promise<PendingAttemptAbandonmentDecision> {
    if (this.activeAttempts.get(executionId) !== executionAttemptId) {
      return { kind: 'fenced' };
    }
    const record = this.attempts.get(executionAttemptId);
    if (!record) return { kind: 'fenced' };
    if (record.status === 'allocated') return { kind: 'allocated' };
    if (record.status === 'provisioning') return { kind: 'provisioning' };
    if (record.status === 'settled') {
      return { kind: record.settlementKind === 'abandoned' ? 'already-abandoned' : 'already-settled' };
    }
    this.attempts.set(executionAttemptId, {
      ...record,
      status: 'settled',
      settlementKind: 'abandoned',
      claimable: false,
    });
    return { kind: 'abandoned' };
  }
}

/**
 * Create a fresh in-memory {@link ExecutionAttemptRepository} fixture.
 *
 * The returned repository implements the full recovery surface and is
 * suitable for Authority, outcome submission, and dispatch runner tests.
 * @returns A new {@link InMemoryAttemptRepository} instance.
 */
export function createInMemoryAttemptRepository(): InMemoryAttemptRepository {
  return new InMemoryAttemptRepository();
}
