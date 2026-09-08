import { BoundedRecoveryEvidenceSchema, type ExecutionAttemptInstruction } from '@makaio/contracts';
import {
  DuplicateExecutionAttemptError,
  decodeDurableOutcome,
  durableOutcome,
  evaluateAttemptReachability,
  evaluateRuntimeRegistration,
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluateRuntimeReadiness,
  evaluatePreparationReport,
  evaluateProvisionerIncarnationLoss,
  assertRuntimeOutcomeFence,
  sameAllocationRef,
  sameDurableOutcome,
} from '../execution-attempt-repository.js';
import {
  snapshotEnsureExecutionAttemptPersistenceInput,
  snapshotReadAttemptSettlementInput,
  replayEnsuredAttempt,
  readAttemptSettlementSnapshot,
} from '../execution-attempt-owner-recovery.js';
import type {
  AdmitOperationInput,
  AllocationRecordingDecision,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationTerminationDecision,
  AttemptControlState,
  AttemptReachabilityDecision,
  AttemptSettlementRead,
  BeginProvisioningInput,
  CompleteOperationInput,
  DiscoveredAllocationDecision,
  DurableOutcome,
  ExecutionAttemptCreate,
  EnsureExecutionAttemptDecision,
  EnsureExecutionAttemptPersistenceInput,
  BootstrapStartState,
  ReadBootstrapStartStateInput,
  ReadAttemptSettlementInput,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  GetInstructionInput,
  ReportOperationInput,
  OperationReportDecision,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
  MarkRuntimeReadyInput,
  OperationAdmissionDecision,
  OperationCompletionDecision,
  OutcomeCodec,
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
  RegisterRuntimeInput,
  RenewProviderOperationClaimInput,
  RuntimeReadinessDecision,
  RuntimeRegistrationDecision,
  TakeOverProviderOperationInput,
} from '../execution-attempt-repository.js';
import type {
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from '../provider-operation.js';
import {
  INITIAL_ATTEMPT_CONTROL_STATE,
  createAttemptTiming,
  compareRecoveryOrder,
  instantOf,
  normalizeInstant,
  parsePreparationResult,
  parsePreparationReceipts,
  parseAllocationLifetime,
  parseAllocationRef,
  parseAllocationRefEvolution,
  requireAllocationRefProvider,
  toAttemptControlState,
  toRecoverableAttempt,
} from './attempt-record-codec.js';
import { parseInstruction } from '../attempt-value-snapshot.js';

/**
 * Durable state the in-memory realization keeps.
 *
 * The maps mirror the durable facts the port owns: canonical attempt
 * state, fenced provider-operation ownership, committed outcomes, and which
 * attempt is currently active for an owner, plus replayable request bindings.
 * They are exposed so a test can seed state before the first call and assert
 * against it afterwards.
 *
 * Not generic over the outcome type: the committed outcomes are held as the
 * codec's durable text, the same representation a store's column holds, so
 * none of the maps carries an outcome-typed value.
 */
export interface InMemoryAttemptRepositoryState {
  /** Attempt records keyed by `executionAttemptId`. */
  readonly attempts: Map<string, ExecutionAttemptRecord>;
  /** Provider operation records keyed by `executionAttemptId`. */
  readonly operations: Map<string, ProviderOperationOwnershipRecord>;
  /**
   * Committed outcome texts keyed by `executionAttemptId`.
   *
   * The codec text and nothing else, exactly the `workflow_result` column a
   * durable realization keeps: it is what a retry is compared against, and
   * every outcome the port reports is a fresh decode of it. Keeping the
   * decoded value here instead would hand every reader one shared instance,
   * and a codec may reconstruct a mutable object — a `URL`, say — that no
   * freeze can protect.
   */
  readonly committedOutcomes: Map<string, string>;
  /** Active attempt per `executionId`, the fence every bootstrap path reads. */
  readonly activeAttempts: Map<string, string>;
  /** Request-to-attempt bindings, nested by owner and then opaque request key. */
  readonly requestBindings: Map<string, Map<string, string>>;
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
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface InMemoryAttemptRepository<TOutcome>
  extends Required<ExecutionAttemptRepository<TOutcome>>,
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
 * Settle an attempt, closing its start gate in the same write.
 *
 * A settled attempt never starts work again. The active operation is
 * deliberately left in place, so a completion that arrives after this reads
 * `resolved` rather than `not-active`. Every terminal path goes through here so
 * no realization branch can settle without closing the gate — the SQLite
 * realization has the same rule in its one shared settle statement.
 * @param attempt - Attempt record being settled.
 * @param settlementKind - How the attempt settled.
 * @returns The settled record.
 */
function settleAttempt(
  attempt: ExecutionAttemptRecord,
  settlementKind: NonNullable<ExecutionAttemptRecord['settlementKind']>,
): ExecutionAttemptRecord {
  return { ...attempt, status: 'settled', settlementKind, claimable: false, operationStartGate: 'closed' };
}

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
 * @param codec - Owner-injected codec that validates every submitted outcome.
 * @param seed - Pre-existing state to build on, shared with the caller.
 * @returns A repository exposing the full port surface, plus its backing state.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export function createInMemoryAttemptRepository<TOutcome>(
  codec: OutcomeCodec<TOutcome>,
  seed: Partial<InMemoryAttemptRepositoryState> = {},
): InMemoryAttemptRepository<TOutcome> {
  const attempts = seed.attempts ?? new Map<string, ExecutionAttemptRecord>();
  const operations = seed.operations ?? new Map<string, ProviderOperationOwnershipRecord>();

  /**
   * Whether the attempt's allocation is durably confirmed to have ended.
   *
   * Termination is recorded on the operation row before the attempt settles,
   * so between those two writes the attempt still carries its allocation
   * reference while nothing can run on it anymore. Registration and admission
   * read the obligation for that reason: an allocation owing terminal
   * convergence is not one to run on.
   * @param executionAttemptId - Attempt whose operation to inspect.
   * @returns True when the allocation's termination was recorded.
   */
  const allocationTerminated = (executionAttemptId: string): boolean =>
    operations.get(executionAttemptId)?.obligation === 'terminal-convergence';
  const committedOutcomes = seed.committedOutcomes ?? new Map<string, string>();
  const activeAttempts = seed.activeAttempts ?? new Map<string, string>();
  const requestBindings = seed.requestBindings ?? new Map<string, Map<string, string>>();

  /**
   * Read runtime reachability without touching the control-state decoder.
   * @param attempt - Existing attempt already matched to the requested owner.
   * @returns The first common refusal, or null to evaluate operation control.
   */
  const runtimeReachability = (attempt: ExecutionAttemptRecord): AttemptReachabilityDecision | null => {
    const settled = attempt.settlementKind != null;
    const active = !settled && activeAttempts.get(attempt.executionId) === attempt.executionAttemptId;
    return evaluateAttemptReachability({
      matchesExecution: true,
      settled,
      active,
      allocated: active && attempt.allocationRef !== null && !allocationTerminated(attempt.executionAttemptId),
    });
  };

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

  /**
   * Insert a fresh attempt and fence its predecessor in one synchronous mutation.
   * Both creation paths share this primitive; request association joins the same
   * block without awaiting another public operation.
   * @param input - Validated, snapshotted assignment, candidate identity and creation budget.
   * @returns The new stored record.
   */
  const insertAttempt = (input: ExecutionAttemptCreate): ExecutionAttemptRecord => {
    const timing = createAttemptTiming(input.bootstrapTimeoutMs);
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
      instruction: input.instruction,
      preparationReceipts: Object.freeze([]),
      status: 'pending',
      allocationRef: null,
      ...timing,
      providerId: null,
      allocationLifetime: null,
      provisionerIncarnationId: null,
      settlementKind: null,
      claimable: false,
      claimExpiresAt: null,
      ...INITIAL_ATTEMPT_CONTROL_STATE,
    };
    const activeAttemptId = activeAttempts.get(input.executionId);
    const activeAttempt = activeAttemptId === undefined ? undefined : attempts.get(activeAttemptId);
    if (activeAttempt !== undefined) {
      // Replacement fences bootstrap claims without changing the host-owned
      // expiry window recorded on the allocation, and closes the superseded
      // attempt's start gate: an attempt nobody addresses any more must not
      // be able to admit an operation between here and any later cleanup.
      attempts.set(activeAttempt.executionAttemptId, {
        ...activeAttempt,
        claimable: activeAttempt.status === 'allocated' ? false : activeAttempt.claimable,
        operationStartGate: 'closed',
      });
    }
    attempts.set(input.executionAttemptId, record);
    activeAttempts.set(input.executionId, input.executionAttemptId);
    return record;
  };

  const repository: Omit<ExecutionAttemptRepository<TOutcome>, 'recovery'> = {
    async createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord> {
      return insertAttempt({ ...input, instruction: parseInstruction(input.instruction) });
    },

    async ensureAttempt(input: EnsureExecutionAttemptPersistenceInput): Promise<EnsureExecutionAttemptDecision> {
      const snapshot = snapshotEnsureExecutionAttemptPersistenceInput(input);
      const ownerBindings = requestBindings.get(snapshot.executionId);
      const boundAttemptId = ownerBindings?.get(snapshot.requestKey);
      if (boundAttemptId !== undefined) {
        return replayEnsuredAttempt(snapshot, attempts.get(boundAttemptId) ?? null);
      }

      // Nothing below yields: failed creation leaves the key available, while
      // successful creation and its association become visible together.
      const attempt = insertAttempt(snapshot);
      const bindings = ownerBindings ?? new Map<string, string>();
      bindings.set(snapshot.requestKey, attempt.executionAttemptId);
      requestBindings.set(snapshot.executionId, bindings);
      return { kind: 'created', attempt: structuredClone(attempt) };
    },

    async readAttemptSettlement(input: ReadAttemptSettlementInput): Promise<AttemptSettlementRead<TOutcome>> {
      const snapshot = snapshotReadAttemptSettlementInput(input);
      return readAttemptSettlementSnapshot(
        snapshot,
        {
          attempt: attempts.get(snapshot.executionAttemptId) ?? null,
          activeAttemptId: activeAttempts.get(snapshot.executionId) ?? null,
          outcomeText: committedOutcomes.get(snapshot.executionAttemptId) ?? null,
        },
        codec,
      );
    },

    async readBootstrapStartState(input: ReadBootstrapStartStateInput): Promise<BootstrapStartState | null> {
      const attempt = attempts.get(input.executionAttemptId);
      if (!attempt || attempt.executionId !== input.executionId) return null;
      return {
        settled: attempt.settlementKind != null,
        active: activeAttempts.get(input.executionId) === input.executionAttemptId,
        allocated: attempt.allocationRef !== null,
        allocationTerminated: allocationTerminated(input.executionAttemptId),
        operationStartGate: attempt.operationStartGate,
        bootstrapDeadlineAt: attempt.bootstrapDeadlineAt ?? null,
      };
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

      attempts.set(attempt.executionAttemptId, settleAttempt(attempt, 'abandoned'));
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
      const refusal = evaluateProvisionerIncarnationLoss(attempt, input);
      if (refusal !== null) return refusal;

      attempts.set(attempt.executionAttemptId, settleAttempt(attempt, 'abandoned'));
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

      attempts.set(attempt.executionAttemptId, settleAttempt(attempt, 'infrastructure-failure'));
      closeOperation(operation, operation.lastFailure);
      return { kind: 'recorded' };
    },

    async registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRegistrationDecision> {
      const attempt = attempts.get(input.executionAttemptId);
      if (attempt === undefined || attempt.executionId !== input.executionId) return { kind: 'not-found' };
      const refusal = runtimeReachability(attempt) ?? evaluateRuntimeRegistration(attempt, input);
      if (refusal !== null) return refusal;

      // The generation is allocated here and never proposed by the caller.
      // Readiness is cleared with it: it was proven by the incarnation this one
      // replaces, and says nothing about the new one. An orphaned probe is
      // cleared in the same write, all five members at once.
      const runtimeGeneration = attempt.runtimeGeneration + 1;
      attempts.set(attempt.executionAttemptId, {
        ...attempt,
        runtimeGeneration,
        runtimeIncarnationId: input.runtimeIncarnationId,
        runtimeReadyAt: null,
        activeOperationId: null,
        activeOperationKind: null,
        activeOperationKey: null,
        activeOperationGeneration: null,
        activeOperationAdmittedAt: null,
      });
      return { kind: 'registered', runtimeGeneration };
    },

    async admitOperation(input: AdmitOperationInput): Promise<OperationAdmissionDecision> {
      const attempt = attempts.get(input.executionAttemptId);
      if (attempt === undefined || attempt.executionId !== input.executionId) return { kind: 'not-found' };
      const unreachable = runtimeReachability(attempt);
      if (unreachable !== null) return unreachable;
      // Preserve the clock boundary: only a duplicate lacking its stored
      // instant needs a fallback before the guarded mutation is considered.
      const fallbackAdmittedAt =
        attempt.activeOperationId !== null &&
        attempt.activeOperationKey === input.admissionKey &&
        attempt.activeOperationAdmittedAt === null
          ? normalizeInstant(new Date().toISOString())
          : '';
      const refusal = evaluateOperationAdmission(attempt, input, fallbackAdmittedAt, attempt);
      if (refusal !== null) return refusal;

      const operationId = crypto.randomUUID();
      const admittedAt = normalizeInstant(new Date().toISOString());
      attempts.set(attempt.executionAttemptId, {
        ...attempt,
        activeOperationId: operationId,
        activeOperationKind: input.operationKind,
        activeOperationKey: input.admissionKey,
        activeOperationGeneration: attempt.runtimeGeneration,
        activeOperationAdmittedAt: admittedAt,
      });
      return { kind: 'admitted', operationId, runtimeGeneration: attempt.runtimeGeneration, admittedAt };
    },

    async getInstruction(input: GetInstructionInput): Promise<ExecutionAttemptInstruction | null> {
      const attempt = attempts.get(input.executionAttemptId);
      return attempt?.executionId === input.executionId ? attempt.instruction : null;
    },

    async reportOperation(input: ReportOperationInput): Promise<OperationReportDecision> {
      const result = parsePreparationResult(input.result);
      const attempt = attempts.get(input.executionAttemptId);
      if (attempt === undefined || attempt.executionId !== input.executionId) return { kind: 'not-found' };
      const refusal = evaluatePreparationReport(
        {
          matchesExecution: true,
          settled: attempt.settlementKind != null,
          active: activeAttempts.get(input.executionId) === input.executionAttemptId,
          allocated: attempt.allocationRef !== null && !allocationTerminated(input.executionAttemptId),
        },
        attempt,
        attempt,
        { ...input, result },
      );
      if (refusal !== null) return refusal;
      const preparationReceipts = parsePreparationReceipts([
        ...attempt.preparationReceipts,
        {
          operationId: input.operationId,
          runtimeGeneration: input.runtimeGeneration,
          result,
        },
      ]);
      attempts.set(input.executionAttemptId, {
        ...attempt,
        preparationReceipts,
        activeOperationId: null,
        activeOperationKind: null,
        activeOperationKey: null,
        activeOperationGeneration: null,
        activeOperationAdmittedAt: null,
        lastCompletedOperationId: input.operationId,
      });
      return { kind: 'accepted', binding: result.binding };
    },

    async completeOperation(input: CompleteOperationInput): Promise<OperationCompletionDecision> {
      const attempt = attempts.get(input.executionAttemptId);
      if (attempt === undefined) return { kind: 'not-found' };
      // A terminal settlement leaves the active operation in place, so a late
      // completion learns that the attempt resolved rather than that its
      // operation was never active.
      if (attempt.settlementKind != null) return { kind: 'resolved' };
      const refusal = evaluateOperationCompletion(attempt, input);
      if (refusal !== null) return refusal;

      // One write clears all five members: a half-released operation would be
      // neither active nor absent.
      attempts.set(attempt.executionAttemptId, {
        ...attempt,
        activeOperationId: null,
        activeOperationKind: null,
        activeOperationKey: null,
        activeOperationGeneration: null,
        activeOperationAdmittedAt: null,
        lastCompletedOperationId: input.operationId,
      });
      return { kind: 'completed' };
    },

    async markRuntimeReady(input: MarkRuntimeReadyInput): Promise<RuntimeReadinessDecision> {
      const acceptedAt = normalizeInstant(input.readyAt);
      const attempt = attempts.get(input.executionAttemptId);
      if (attempt === undefined || attempt.executionId !== input.executionId) return { kind: 'not-found' };
      const refusal = runtimeReachability(attempt) ?? evaluateRuntimeReadiness(attempt, input);
      if (refusal !== null) return refusal;

      attempts.set(attempt.executionAttemptId, { ...attempt, runtimeReadyAt: acceptedAt });
      return { kind: 'ready', acceptedAt };
    },

    async getAttemptControlState(executionAttemptId: string): Promise<AttemptControlState | null> {
      const attempt = attempts.get(executionAttemptId);
      return attempt === undefined ? null : toAttemptControlState(attempt);
    },

    async getActiveAttempt(executionId: string, executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
      // Settled is not superseded: a settled attempt is still the active
      // attempt for its execution until a newer one replaces it.
      if (activeAttempts.get(executionId) !== executionAttemptId) return null;
      return attempts.get(executionAttemptId) ?? null;
    },

    canonicalizeOutcome(outcome: TOutcome): DurableOutcome<TOutcome> {
      return durableOutcome(codec, outcome);
    },

    decodeOutcome(text: string): TOutcome {
      return decodeDurableOutcome(codec, text);
    },

    async commitOutcome(
      input: ExecutionAttemptOutcomeCommit<TOutcome>,
    ): Promise<ExecutionAttemptOutcomeDecision<TOutcome>> {
      // Already rendered by `canonicalizeOutcome`, and deliberately not
      // rendered again: this is the exact text and value the owner validated.
      const submission = input.result;
      // Deliberately claim-independent: a worker's answer is never fenced by
      // provider-operation ownership. The precedence below is the one the port
      // mandates — fence, then committed outcome, then competing settlement.
      if (activeAttempts.get(input.executionId) !== input.executionAttemptId) return { kind: 'fenced' };

      const attempt = attempts.get(input.executionAttemptId);
      // The pointer names an attempt that does not exist, so there is nothing
      // to settle and no canonical answer to own. Accepting the outcome here
      // would leave it behind with no attempt to attach it to.
      if (attempt === undefined) return { kind: 'fenced' };

      // Presence, not truthiness: `0`, `''`, and `false` are committed
      // outcomes, and a replay of one owes `duplicate` rather than a second
      // `accepted`. The port keeps nullish outcomes outside itself precisely
      // so that the absence of a stored value can mean "nothing committed".
      const storedText = committedOutcomes.get(input.executionAttemptId);
      if (storedText !== undefined) {
        // Decoded before the decision, not only on the duplicate branch: a
        // stored text the codec rejects is broken durable state, and
        // answering `conflict` for it would hide that behind an ordinary
        // caller conflict. The decode is also what makes every read of a
        // committed outcome a fresh value rather than one shared instance.
        const committed = decodeDurableOutcome(codec, storedText);
        // The stored text travels with the decision, not the retry's own:
        // the two are the same outcome under `sameDurableOutcome` without
        // being the same text, and what a caller decodes for a waiter must
        // be the representation the attempt holds.
        return sameDurableOutcome(storedText, submission.text)
          ? { kind: 'duplicate', outcome: committed, text: storedText }
          : { kind: 'conflict' };
      }

      // A settlement without a committed outcome means a competing terminal
      // transition won the CAS. It keeps its settlement kind: the loser of a
      // terminal race never rewrites the winner's answer.
      if (attempt.settlementKind != null) return { kind: 'conflict' };

      assertRuntimeOutcomeFence(attempt, input.runtimeFence);

      // What this realization keeps is the codec text and nothing else, the
      // column a durable realization holds. Keeping the submitter's copy
      // instead would let an owner converge on a value no reload ever yields.
      committedOutcomes.set(input.executionAttemptId, submission.text);
      attempts.set(input.executionAttemptId, settleAttempt(attempt, 'outcome'));
      const operation = operations.get(input.executionAttemptId);
      if (operation) closeOperation(operation, operation.lastFailure);
      // Decoded from the text that was just stored, not taken from
      // `submission.outcome`: the caller has held that value since before its
      // own validation, and a mutable outcome it changed there would be
      // reported back as the committed one — a value no later read yields.
      return { kind: 'accepted', outcome: decodeDurableOutcome(codec, submission.text), text: submission.text };
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
      attempts.set(executionAttemptId, settleAttempt(attempt, 'abandoned'));
      return { kind: 'abandoned' };
    },
  };

  return { ...repository, recovery, attempts, operations, committedOutcomes, activeAttempts, requestBindings };
}
