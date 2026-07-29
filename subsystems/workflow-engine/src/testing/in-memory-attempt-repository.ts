import type { WorkflowRunResult } from '@makaio/contracts';
import { BoundedRecoveryEvidenceSchema } from '@makaio/contracts';
import {
  DuplicateExecutionAttemptError,
  sameAllocationRef,
  sameWorkflowResult,
} from '../execution-attempt-repository.js';
import type {
  AllocationRecordingDecision,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationTerminationDecision,
  BeginProvisioningInput,
  DiscoveredAllocationDecision,
  ExecutionAttemptCreate,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
  PendingAttemptAbandonmentDecision,
  ProvisionerIncarnationLossDecision,
  ProvisioningAbsenceDecision,
  ProvisioningClaimDecision,
  RecordAllocationInput,
  RecordAllocationTerminatedInput,
  RecordInfrastructureFailureInput,
  RecordProviderOperationUncertaintyInput,
  RecordProvisionerIncarnationLostInput,
  RecordProvisioningAbsentInput,
  RecoverableAttemptRecord,
  RenewProviderOperationClaimInput,
  TakeOverProviderOperationInput,
} from '../execution-attempt-repository.js';
import type {
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from '../provider-operation.js';
import {
  compareRecoveryOrder,
  instantOf,
  normalizeInstant,
  parseAllocationLifetime,
  parseAllocationRef,
  parseAllocationRefEvolution,
  parseWorkflowResult,
  requireAllocationRefProvider,
  toRecoverableAttempt,
} from './attempt-record-codec.js';

/**
 * Durable state the in-memory realization keeps.
 *
 * The four maps mirror the four durable facts the port owns: canonical attempt
 * state, fenced provider-operation ownership, committed workflow outcomes, and
 * which attempt is currently active for an execution. They are exposed so a
 * test can seed state before the first call and assert against it afterwards.
 */
export interface InMemoryAttemptRepositoryState {
  /** Attempt records keyed by `executionAttemptId`. */
  readonly attempts: Map<string, ExecutionAttemptRecord>;
  /** Provider operation records keyed by `executionAttemptId`. */
  readonly operations: Map<string, ProviderOperationOwnershipRecord>;
  /** Committed canonical outcomes keyed by `executionAttemptId`. */
  readonly committedOutcomes: Map<string, WorkflowRunResult>;
  /** Active attempt per `executionId`, the fence every bootstrap path reads. */
  readonly activeAttempts: Map<string, string>;
}

/**
 * The in-memory realization together with the state backing it.
 *
 * The recovery capability is present, so a test may call the full surface
 * without narrowing. The value is a plain object: spreading it yields a
 * working repository with one operation replaced, which is how a test injects
 * a single failing durable write without losing the rest of the state machine.
 * Replacing a recovery operation means spreading `recovery` too, which is the
 * port's own rule that recovery is offered whole or not at all.
 */
export interface InMemoryAttemptRepository
  extends Required<ExecutionAttemptRepository>,
    InMemoryAttemptRepositoryState {}

/**
 * Result of authorizing a claim against durable operation state.
 *
 * `authorized` narrows both records so callers never re-read them, and the
 * three refusal kinds map straight onto the shared decision vocabulary.
 */
type ClaimAuthorization =
  | {
      readonly kind: 'authorized';
      readonly attempt: ExecutionAttemptRecord;
      readonly operation: ProviderOperationOwnershipRecord;
    }
  | { readonly kind: 'stale'; readonly attempt: ExecutionAttemptRecord }
  | { readonly kind: 'resolved'; readonly attempt: ExecutionAttemptRecord }
  | { readonly kind: 'not-found' };

/**
 * Create the in-memory reference realization of {@link ExecutionAttemptRepository}.
 *
 * It is the canonical realization of the repository-owned state machine: the
 * attempt record holds canonical workflow state, a separate operation record
 * holds fenced ownership and monotonic remediation debt, and no caller can
 * choose an obligation or bypass a claim.
 *
 * Every value crossing into durable state is parsed through the public
 * contract schema that owns it, on the way in and before the first mutation.
 * That is what keeps this realization and a durable one from disagreeing: a
 * value the contract forbids is refused at the same point by both, and a
 * caller that mutates its own object afterwards changes nothing here.
 *
 * Each transition's guard and its write are one synchronous block, so the
 * two can never be separated. A durable realization has no such guarantee and
 * must instead repeat every guard inside the predicate of its own write —
 * see `createSqliteAttemptRepository` for what that looks like.
 *
 * NOT a production implementation — it holds everything in memory and does not
 * model transaction isolation. Use it wherever a test needs the port's
 * decisions without a database, and `createSqliteAttemptRepository` when the
 * test needs real transactional fencing between two independent connections.
 * @param seed - Pre-existing state to build on, shared with the caller.
 * @returns A repository exposing the full port surface, plus its backing state.
 */
export function createInMemoryAttemptRepository(
  seed: Partial<InMemoryAttemptRepositoryState> = {},
): InMemoryAttemptRepository {
  const attempts = seed.attempts ?? new Map<string, ExecutionAttemptRecord>();
  const operations = seed.operations ?? new Map<string, ProviderOperationOwnershipRecord>();
  const committedOutcomes = seed.committedOutcomes ?? new Map<string, WorkflowRunResult>();
  const activeAttempts = seed.activeAttempts ?? new Map<string, string>();

  /**
   * Authorize a claim against the durable operation record.
   *
   * Lease expiry is deliberately not part of authorization: an expired lease
   * only enables takeover, and takeover is what actually fences the previous
   * owner by advancing the generation and reissuing the token.
   * @param claim - Claim presented by the caller.
   * @returns The narrowed records, or the refusal to report.
   */
  const authorize = (claim: ProviderOperationClaim): ClaimAuthorization => {
    const attempt = attempts.get(claim.executionAttemptId);
    const operation = operations.get(claim.executionAttemptId);
    if (!attempt || !operation) return { kind: 'not-found' };
    if (attempt.settlementKind != null) return { kind: 'resolved', attempt };
    if (
      operation.token === null ||
      operation.token !== claim.token ||
      operation.generation !== claim.generation ||
      operation.ownerId !== claim.ownerId
    ) {
      return { kind: 'stale', attempt };
    }
    return { kind: 'authorized', attempt, operation };
  };

  /**
   * Close an operation whose attempt has reached a terminal settlement.
   *
   * Ownership is cleared so no claim can mutate a resolved operation, while
   * the generation, obligation, and accumulated evidence stay readable.
   * @param operation - Operation record to close.
   * @param lastFailure - Bounded evidence to retain on the closed record.
   */
  const closeOperation = (
    operation: ProviderOperationOwnershipRecord,
    lastFailure: ProviderOperationOwnershipRecord['lastFailure'],
  ): void => {
    operations.set(operation.executionAttemptId, {
      ...operation,
      ownerId: null,
      token: null,
      leaseExpiresAt: null,
      lastFailure,
    });
  };

  /**
   * Record an allocation reference against a claimed operation.
   *
   * Both the initial-provisioning path and the discovery path converge here;
   * they differ only in whether the attempt may become bootstrap-claimable.
   * An attempt that is no longer the active attempt for its execution never
   * becomes claimable on either path.
   * @param input - Claim and the allocation reference to store.
   * @param bootstrapClaimable - Whether this path may mark the attempt bootstrap-claimable.
   * @returns The durable allocation decision.
   * @throws When the reference names a provider other than the attempt's own.
   */
  const applyAllocation = (input: RecordAllocationInput, bootstrapClaimable: boolean): AllocationRecordingDecision => {
    const allocationRef = parseAllocationRef(input.allocationRef);
    const authorization = authorize(input.claim);
    // The binding is a fact about the attempt, so it is judged as soon as the
    // attempt is known and before any decision about the caller is reported.
    if (authorization.kind !== 'not-found') requireAllocationRefProvider(authorization.attempt, allocationRef);
    if (authorization.kind === 'resolved') {
      return { kind: 'resolved', allocationRef: authorization.attempt.allocationRef };
    }
    if (authorization.kind !== 'authorized') return { kind: authorization.kind };
    const { attempt, operation } = authorization;

    if (attempt.allocationRef !== null) {
      return sameAllocationRef(attempt.allocationRef, allocationRef)
        ? { kind: 'duplicate', allocationRef: attempt.allocationRef }
        : { kind: 'conflict', allocationRef: attempt.allocationRef };
    }

    const isActiveAttempt = activeAttempts.get(attempt.executionId) === attempt.executionAttemptId;
    attempts.set(attempt.executionAttemptId, {
      ...attempt,
      status: 'allocated',
      allocationRef,
      claimable: bootstrapClaimable && isActiveAttempt,
    });
    operations.set(operation.executionAttemptId, { ...operation, obligation: 'allocation-control' });
    return { kind: 'recorded' };
  };

  /**
   * The coherent recovery capability, implemented in full.
   *
   * It is one object rather than four members so a test that replaces a single
   * recovery operation has to spread this one and say what it replaced,
   * exactly as the port requires of any repository that offers recovery at all.
   */
  const recovery: ExecutionAttemptRecoveryOperations = {
    async getAttemptWithAllocation(executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
      return attempts.get(executionAttemptId) ?? null;
    },

    async recordDiscoveredAllocation(input: RecordAllocationInput): Promise<DiscoveredAllocationDecision> {
      return applyAllocation(input, false);
    },

    async evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision> {
      const { currentRef, nextRef } = parseAllocationRefEvolution(input);
      const authorization = authorize(input.claim);
      if (authorization.kind === 'stale') {
        return { kind: 'stale', storedRef: authorization.attempt.allocationRef };
      }
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };
      const { attempt } = authorization;
      if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
      if (attempt.allocationRef === null) return { kind: 'not-allocated' };
      if (!sameAllocationRef(attempt.allocationRef, currentRef)) {
        return { kind: 'stale', storedRef: attempt.allocationRef };
      }

      attempts.set(attempt.executionAttemptId, { ...attempt, allocationRef: nextRef });
      return { kind: 'evolved' };
    },

    async getRecoverableAttempts(executionId: string): Promise<readonly RecoverableAttemptRecord[]> {
      const nowInstant = instantOf(new Date().toISOString());
      const results: RecoverableAttemptRecord[] = [];

      for (const record of attempts.values()) {
        if (record.executionId !== executionId) continue;
        if (record.status !== 'allocated') continue;
        if (record.allocationRef === null) continue;
        if (record.claimable !== true) continue;
        if (record.settlementKind != null) continue;
        if (record.claimExpiresAt != null && instantOf(record.claimExpiresAt) < nowInstant) continue;
        // The immutable provider binding is written together with the
        // allocation, so a selected attempt that lacks it is an inconsistent
        // record. Narrowing throws rather than dropping it: an attempt
        // silently omitted from recovery is one whose live infrastructure
        // nobody reclaims.
        results.push(toRecoverableAttempt(record));
      }

      // A durable realization pushes the same rule into its query; here the
      // insertion order of a Map is not the port's order, so it is applied
      // explicitly.
      return results.sort(compareRecoveryOrder);
    },
  };

  const repository: Omit<ExecutionAttemptRepository, 'recovery'> = {
    async createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord> {
      // A reused identifier would resurrect a possibly settled attempt with a
      // fresh pending record, orphan its operation, and leave any committed
      // outcome behind. The port makes it a caller bug so no realization ever
      // has to make that trade.
      if (attempts.has(input.executionAttemptId)) {
        throw new DuplicateExecutionAttemptError(input.executionAttemptId);
      }
      const record: ExecutionAttemptRecord = {
        executionAttemptId: input.executionAttemptId,
        executionId: input.executionId,
        status: 'pending',
        allocationRef: null,
        createdAt: new Date().toISOString(),
        providerId: null,
        allocationLifetime: null,
        provisionerIncarnationId: null,
        settlementKind: null,
        claimable: false,
        claimExpiresAt: null,
      };
      const activeAttemptId = activeAttempts.get(input.executionId);
      const activeAttempt = activeAttemptId === undefined ? undefined : attempts.get(activeAttemptId);
      if (activeAttempt?.status === 'allocated') {
        // Replacement fences bootstrap claims without changing the host-owned
        // expiry window recorded on the allocation.
        attempts.set(activeAttempt.executionAttemptId, { ...activeAttempt, claimable: false });
      }
      attempts.set(input.executionAttemptId, record);
      activeAttempts.set(input.executionId, input.executionAttemptId);
      return record;
    },

    async beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision> {
      const allocationLifetime = parseAllocationLifetime(input.allocationLifetime);
      const attempt = attempts.get(input.executionAttemptId);
      if (!attempt || attempt.executionId !== input.executionId) return { kind: 'not-found' };
      if (activeAttempts.get(input.executionId) !== input.executionAttemptId) return { kind: 'fenced' };
      if (attempt.settlementKind != null) return { kind: 'resolved', allocationRef: attempt.allocationRef };
      if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
      if (attempt.status !== 'pending') return { kind: 'already-provisioning' };

      // One transaction: bind the provider immutably and open the operation.
      attempts.set(input.executionAttemptId, {
        ...attempt,
        status: 'provisioning',
        providerId: input.providerId,
        allocationLifetime,
        provisionerIncarnationId: input.provisionerIncarnationId,
      });
      const claim: ProviderOperationClaim = {
        executionAttemptId: input.executionAttemptId,
        generation: 1,
        ownerId: input.ownerId,
        token: crypto.randomUUID(),
        leaseExpiresAt: normalizeInstant(input.leaseExpiresAt),
      };
      operations.set(input.executionAttemptId, {
        executionAttemptId: input.executionAttemptId,
        generation: claim.generation,
        ownerId: claim.ownerId,
        token: claim.token,
        leaseExpiresAt: claim.leaseExpiresAt,
        obligation: 'provisioning-resolution',
        failureCount: 0,
        lastFailure: null,
      });
      return { kind: 'started', claim };
    },

    async getProviderOperation(executionAttemptId: string): Promise<ProviderOperationOwnershipRecord | null> {
      return operations.get(executionAttemptId) ?? null;
    },

    async renewProviderOperationClaim(
      input: RenewProviderOperationClaimInput,
    ): Promise<ProviderOperationClaimDecision> {
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };

      // Renewal keeps generation and token: extending a lease fences nobody.
      const leaseExpiresAt = normalizeInstant(input.leaseExpiresAt);
      operations.set(input.claim.executionAttemptId, { ...authorization.operation, leaseExpiresAt });
      return { kind: 'claimed', claim: { ...input.claim, leaseExpiresAt } };
    },

    async takeOverProviderOperation(input: TakeOverProviderOperationInput): Promise<ProviderOperationClaimDecision> {
      const attempt = attempts.get(input.executionAttemptId);
      const operation = operations.get(input.executionAttemptId);
      if (!attempt || !operation) return { kind: 'not-found' };
      if (attempt.settlementKind != null) return { kind: 'resolved' };
      const held =
        operation.ownerId !== null &&
        operation.leaseExpiresAt !== null &&
        instantOf(operation.leaseExpiresAt) > instantOf(input.observedAt);
      if (held) return { kind: 'stale' };

      const claim: ProviderOperationClaim = {
        executionAttemptId: input.executionAttemptId,
        generation: operation.generation + 1,
        ownerId: input.ownerId,
        token: crypto.randomUUID(),
        leaseExpiresAt: normalizeInstant(input.leaseExpiresAt),
      };
      operations.set(input.executionAttemptId, {
        ...operation,
        generation: claim.generation,
        ownerId: claim.ownerId,
        token: claim.token,
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      return { kind: 'claimed', claim };
    },

    async handoffProviderOperation(input: HandoffProviderOperationInput): Promise<ProviderOperationMutationDecision> {
      const evidence = input.evidence === undefined ? undefined : BoundedRecoveryEvidenceSchema.parse(input.evidence);
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };

      // Generation and obligation survive; clearing the token fences the
      // released claim immediately so takeover need not await the old lease.
      operations.set(input.claim.executionAttemptId, {
        ...authorization.operation,
        ownerId: null,
        token: null,
        leaseExpiresAt: null,
        lastFailure: evidence ?? authorization.operation.lastFailure,
      });
      return { kind: 'recorded' };
    },

    async recordProviderOperationUncertainty(
      input: RecordProviderOperationUncertaintyInput,
    ): Promise<ProviderOperationMutationDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };

      operations.set(input.claim.executionAttemptId, {
        ...authorization.operation,
        failureCount: authorization.operation.failureCount + 1,
        lastFailure: evidence,
      });
      return { kind: 'recorded' };
    },

    async recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision> {
      return applyAllocation(input, true);
    },

    async recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };
      const { attempt, operation } = authorization;
      if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
      if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };

      attempts.set(attempt.executionAttemptId, {
        ...attempt,
        status: 'settled',
        settlementKind: 'abandoned',
        claimable: false,
      });
      closeOperation(operation, evidence);
      return { kind: 'recorded' };
    },

    async recordProvisionerIncarnationLost(
      input: RecordProvisionerIncarnationLostInput,
    ): Promise<ProvisionerIncarnationLossDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.proof.evidence);
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };
      const { attempt, operation } = authorization;
      if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
      // Applicability first, ownership second: whether the proof says anything
      // about this attempt at all is decided by the two immutable facts
      // `beginProvisioning` bound, and only an applicable proof then has to
      // answer for a recorded allocation.
      if (attempt.allocationLifetime !== 'provisioner-process-bound') {
        return { kind: 'not-process-bound', allocationLifetime: attempt.allocationLifetime };
      }
      if (
        attempt.provisionerIncarnationId === null ||
        attempt.provisionerIncarnationId !== input.proof.provisionerIncarnationId
      ) {
        return { kind: 'incarnation-mismatch', provisionerIncarnationId: attempt.provisionerIncarnationId };
      }
      if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };

      attempts.set(attempt.executionAttemptId, {
        ...attempt,
        status: 'settled',
        settlementKind: 'abandoned',
        claimable: false,
      });
      closeOperation(operation, evidence);
      return { kind: 'recorded' };
    },

    async recordAllocationTerminated(input: RecordAllocationTerminatedInput): Promise<AllocationTerminationDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };
      const { attempt, operation } = authorization;
      // Termination is only meaningful for a known allocation. Reporting that
      // distinctly is what keeps a fenced controller distinguishable from a
      // current one that simply has nothing to terminate.
      if (attempt.allocationRef === null) return { kind: 'not-allocated' };

      operations.set(operation.executionAttemptId, {
        ...operation,
        obligation: 'terminal-convergence',
        lastFailure: evidence,
      });
      return { kind: 'recorded' };
    },

    async recordInfrastructureFailure(input: RecordInfrastructureFailureInput): Promise<InfrastructureFailureDecision> {
      const authorization = authorize(input.claim);
      if (authorization.kind !== 'authorized') return { kind: authorization.kind };
      const { attempt, operation } = authorization;
      if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
      if (attempt.allocationRef === null) return { kind: 'not-allocated' };
      // Terminal settlement is irreversible, so it may only follow the durable
      // evidence that the allocation actually ended. An operation still owing
      // allocation control has not recorded that evidence yet.
      if (operation.obligation !== 'terminal-convergence') return { kind: 'not-terminated' };

      attempts.set(attempt.executionAttemptId, {
        ...attempt,
        status: 'settled',
        settlementKind: 'infrastructure-failure',
        claimable: false,
      });
      closeOperation(operation, operation.lastFailure);
      return { kind: 'recorded' };
    },

    async getActiveAttempt(executionId: string, executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
      // Settled is not superseded: a settled attempt is still the active
      // attempt for its execution until a newer one replaces it.
      if (activeAttempts.get(executionId) !== executionAttemptId) return null;
      return attempts.get(executionAttemptId) ?? null;
    },

    async commitOutcome(input: ExecutionAttemptOutcomeCommit): Promise<ExecutionAttemptOutcomeDecision> {
      const result = parseWorkflowResult(input.result);
      // Deliberately claim-independent: a worker's answer is never fenced by
      // provider-operation ownership. The precedence below is the one the port
      // mandates — fence, then committed outcome, then competing settlement.
      if (activeAttempts.get(input.executionId) !== input.executionAttemptId) return { kind: 'fenced' };

      const attempt = attempts.get(input.executionAttemptId);
      // The pointer names an attempt that does not exist, so there is nothing
      // to settle and no canonical answer to own. Accepting the outcome here
      // would leave it behind with no attempt to attach it to.
      if (attempt === undefined) return { kind: 'fenced' };

      const prior = committedOutcomes.get(input.executionAttemptId);
      if (prior) {
        return sameWorkflowResult(prior, result) ? { kind: 'duplicate', outcome: prior } : { kind: 'conflict' };
      }

      // A settlement without a committed outcome means a competing terminal
      // transition won the CAS. It keeps its settlement kind: the loser of a
      // terminal race never rewrites the winner's answer.
      if (attempt.settlementKind != null) return { kind: 'conflict' };

      committedOutcomes.set(input.executionAttemptId, result);
      attempts.set(input.executionAttemptId, {
        ...attempt,
        status: 'settled',
        settlementKind: 'outcome',
        claimable: false,
      });
      const operation = operations.get(input.executionAttemptId);
      if (operation) closeOperation(operation, operation.lastFailure);
      return { kind: 'accepted', outcome: result };
    },

    async abandonPendingAttempt(
      executionAttemptId: string,
      executionId: string,
    ): Promise<PendingAttemptAbandonmentDecision> {
      if (activeAttempts.get(executionId) !== executionAttemptId) return { kind: 'fenced' };
      const attempt = attempts.get(executionAttemptId);
      if (!attempt) return { kind: 'fenced' };
      if (attempt.status === 'allocated') return { kind: 'allocated' };
      if (attempt.status === 'provisioning') return { kind: 'provisioning' };
      if (attempt.status === 'settled') {
        return { kind: attempt.settlementKind === 'abandoned' ? 'already-abandoned' : 'already-settled' };
      }
      attempts.set(executionAttemptId, {
        ...attempt,
        status: 'settled',
        settlementKind: 'abandoned',
        claimable: false,
      });
      return { kind: 'abandoned' };
    },
  };

  return { ...repository, recovery, attempts, operations, committedOutcomes, activeAttempts };
}
