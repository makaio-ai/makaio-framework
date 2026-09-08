import type { ExecutionAttemptInstruction, ExecutionAttemptBootstrapAwaitStartResponse } from '@makaio/contracts';
import { awaitBootstrapStart, type BootstrapStartAuthority, type BootstrapStartOptions } from './bootstrap-start.js';
import type {
  AdmitOperationInput,
  AllocationRecordingDecision,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationTerminationDecision,
  AttemptControlState,
  AttemptSettlementRead,
  BeginProvisioningInput,
  CompleteOperationInput,
  DiscoveredAllocationDecision,
  DurableOutcome,
  EnsureExecutionAttemptDecision,
  EnsureExecutionAttemptInput,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  ExecutionOwnerId,
  GetInstructionInput,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
  MarkRuntimeReadyInput,
  OperationAdmissionDecision,
  OperationCompletionDecision,
  OperationReportDecision,
  PendingAttemptAbandonmentDecision,
  ProvisionerIncarnationLossDecision,
  ProvisioningAbsenceDecision,
  ProvisioningClaimDecision,
  RecordAllocationInput,
  ReadBootstrapStartStateInput,
  ReadAttemptSettlementInput,
  RecordAllocationTerminatedInput,
  RecordInfrastructureFailureInput,
  RecordProviderOperationUncertaintyInput,
  RecordProvisionerIncarnationLostInput,
  RecordProvisioningAbsentInput,
  RecoverableAttemptRecord,
  RegisterRuntimeInput,
  ReportOperationInput,
  RenewProviderOperationClaimInput,
  RuntimeReadinessDecision,
  RuntimeOutcomeFence,
  RuntimeRegistrationDecision,
  TakeOverProviderOperationInput,
} from './execution-attempt-repository.js';
import {
  snapshotEnsureExecutionAttemptInput,
  snapshotReadAttemptSettlementInput,
} from './execution-attempt-owner-recovery.js';
import type {
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from './provider-operation.js';
import { buildDeferred, type Deferred } from './runtime/deferred.js';

// ─────────────────────────────────────────────────────────────
// Waiter Types
// ─────────────────────────────────────────────────────────────

/**
 * In-process waiter for a committed outcome.
 *
 * Built via {@link buildDeferred}. The Authority holds one waiter per active
 * attempt so callers (e.g. WorkerRunner) can `await` the durable outcome
 * without polling.
 *
 * Settlement lifecycle:
 * - `conflict` / `fenced`: rejected immediately by {@link commitOutcome}.
 * - `accepted` / `duplicate`: NOT settled by commitOutcome. The caller
 *   must invoke {@link settleOutcome} after owner-state convergence
 *   succeeds.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
type OutcomeWaiter<TOutcome> = Deferred<TOutcome, Error>;

// ─────────────────────────────────────────────────────────────
// Authority Service
// ─────────────────────────────────────────────────────────────

/**
 * Execution attempt Authority service.
 *
 * Owns:
 * - attempt ID generation (`crypto.randomUUID()`);
 * - current-process waiters so runners can `await` a committed outcome;
 * - idempotent owner-state convergence for both `accepted` and `duplicate`.
 *
 * Delegates:
 * - durable attempt creation, provider-operation ownership, allocation
 *   recording, and outcome commit decisions to the injected
 *   {@link ExecutionAttemptRepository}.
 *
 * The Authority never invents controller identity, lease policy, or fencing
 * tokens, and never chooses a provider operation's obligation. It passes the
 * host-owned claim context through and reports the repository's decision.
 *
 * **Waiter settlement invariant:** waiters settle only on converged
 * outcomes (via {@link settleOutcome}) or on definitive rejection
 * (`conflict`, `fenced`, infrastructure failure). A committed-but-unconverged
 * outcome leaves the waiter pending so retries can converge and settle it.
 * Recovery of committed-but-unconverged outcomes across process restarts
 * is the host recovery coordinator's concern via the exported recovery
 * operations.
 *
 * This service is stateless across process restarts. In-process waiters
 * are lost on crash; the host recovery coordinator owns recovery decisions.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export class ExecutionAttemptAuthority<TOutcome> implements BootstrapStartAuthority {
  private readonly repository: ExecutionAttemptRepository<TOutcome>;
  private readonly bootstrapTimeoutMs: number;

  /**
   * In-process waiters keyed by `executionAttemptId`.
   *
   * A waiter is created in {@link createAttempt} and settled via
   * {@link settleOutcome} after convergence. Callers use
   * {@link waitForOutcome} to obtain the promise.
   */
  private readonly waiters = new Map<string, OutcomeWaiter<TOutcome>>();

  /**
   * @param repository - Injected durable attempt persistence port.
   * @param options - Explicit host-owned bootstrap budget frozen when each attempt is created.
   */
  public constructor(
    repository: ExecutionAttemptRepository<TOutcome>,
    options: { readonly bootstrapTimeoutMs: number },
  ) {
    if (!Number.isSafeInteger(options?.bootstrapTimeoutMs) || options.bootstrapTimeoutMs <= 0) {
      throw new Error('ExecutionAttemptAuthority requires an explicit positive safe-integer bootstrapTimeoutMs');
    }
    this.repository = repository;
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs;
  }

  /**
   * Wait for durable allocation without registering or admitting a Runtime.
   * @param identity - Trusted owner and attempt identity.
   * @param options - Request cancellation and absolute deadline.
   * @returns A bounded, renewable start decision.
   */
  public awaitBootstrapStart(
    identity: ReadBootstrapStartStateInput,
    options: BootstrapStartOptions,
  ): Promise<ExecutionAttemptBootstrapAwaitStartResponse> {
    return awaitBootstrapStart(this.repository, identity, options);
  }

  /**
   * Create a new execution attempt with an Authority-generated ID.
   *
   * Persists the attempt through the repository and installs an in-process
   * waiter for the committed outcome. Must be called before dispatch.
   * @param executionId - Owner identifier the attempt belongs to.
   * @param instruction - Portable immutable assignment to snapshot before dispatch.
   * @returns The persisted attempt record.
   */
  public async createAttempt(
    executionId: ExecutionOwnerId,
    instruction: ExecutionAttemptInstruction,
  ): Promise<ExecutionAttemptRecord> {
    const executionAttemptId = crypto.randomUUID();
    const record = await this.repository.createAttempt({
      executionAttemptId,
      executionId,
      instruction,
      bootstrapTimeoutMs: this.bootstrapTimeoutMs,
    });

    // Install the in-process waiter before returning so that waitForOutcome
    // is immediately available to the caller.
    this.installWaiter(executionAttemptId);

    return record;
  }

  /**
   * Establish or recover one durable owner-request association without creating a waiter.
   * Unlike fresh creation, even first acceptance has no process-local dispatch side effects.
   * Replay preserves the original attempt and never replaces an existing legacy waiter.
   * @param input - Stable owner request and immutable portable assignment.
   * @returns Repository creation, historical replay or instruction conflict decision.
   */
  public async ensureAttempt(input: EnsureExecutionAttemptInput): Promise<EnsureExecutionAttemptDecision> {
    const request = snapshotEnsureExecutionAttemptInput(input);
    return this.repository.ensureAttempt({
      ...request,
      executionAttemptId: crypto.randomUUID(),
      bootstrapTimeoutMs: this.bootstrapTimeoutMs,
    });
  }

  /**
   * Read durable settlement evidence without installing, replacing or settling any waiter.
   * @param input - Trusted owner and exact attempt, including historical attempts.
   * @returns Coherent repository evidence; current-pointer identity is not authorization.
   */
  public async readAttemptSettlement(input: ReadAttemptSettlementInput): Promise<AttemptSettlementRead<TOutcome>> {
    return this.repository.readAttemptSettlement(snapshotReadAttemptSettlementInput(input));
  }

  /**
   * Read this attempt's frozen assignment through the owner-scoped repository port.
   * @param input - Attempt and trusted owner identity.
   * @returns The stored assignment, or null for an owner mismatch or missing attempt.
   */
  public async getInstruction(input: GetInstructionInput): Promise<ExecutionAttemptInstruction | null> {
    return this.repository.getInstruction(input);
  }

  /**
   * Accept successful Preparation without settling the attempt's outcome waiter.
   * @param input - Preparation result, operation correlation and trusted owner identity.
   * @returns The repository's durable acceptance, replay or refusal.
   */
  public async reportOperation(input: ReportOperationInput): Promise<OperationReportDecision> {
    return this.repository.reportOperation(input);
  }

  /**
   * Claim durable ownership of provider provisioning for an active attempt.
   *
   * Delegates directly to the repository immediately before a provider call.
   * A `started` decision is the sole authorization for that call, and it
   * carries the claim every subsequent provider-side record must present.
   * @param input - Attempt identity, immutable provider binding, and initial claim context.
   * @returns The durable provisioning ownership decision.
   */
  public async beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision> {
    return this.repository.beginProvisioning(input);
  }

  /**
   * Read the current provider operation for an attempt.
   * @param executionAttemptId - Attempt whose operation to read.
   * @returns The ownership record, or `null` when provisioning never began.
   */
  public async getProviderOperation(executionAttemptId: string): Promise<ProviderOperationOwnershipRecord | null> {
    return this.repository.getProviderOperation(executionAttemptId);
  }

  /**
   * Extend the lease of a currently held provider operation.
   * @param input - Current claim and the new lease deadline.
   * @returns The durable claim decision.
   */
  public async renewProviderOperationClaim(
    input: RenewProviderOperationClaimInput,
  ): Promise<ProviderOperationClaimDecision> {
    return this.repository.renewProviderOperationClaim(input);
  }

  /**
   * Take ownership of an unowned or lease-expired provider operation.
   * @param input - Attempt identity, requesting owner, observation time, and lease deadline.
   * @returns The durable claim decision.
   */
  public async takeOverProviderOperation(
    input: TakeOverProviderOperationInput,
  ): Promise<ProviderOperationClaimDecision> {
    return this.repository.takeOverProviderOperation(input);
  }

  /**
   * Release a held provider operation without resolving it.
   *
   * The attempt keeps its durable state and stays remediable, so the local
   * waiter is left untouched: handoff transfers control, it does not answer
   * the owner.
   * @param input - Claim being released and optional bounded release evidence.
   * @returns The durable mutation decision.
   */
  public async handoffProviderOperation(
    input: HandoffProviderOperationInput,
  ): Promise<ProviderOperationMutationDecision> {
    return this.repository.handoffProviderOperation(input);
  }

  /**
   * Record that a provider observation stayed inconclusive.
   *
   * Non-terminal by construction: the waiter stays pending because the
   * attempt still has no canonical answer.
   * @param input - Claim and bounded evidence describing the retained uncertainty.
   * @returns The durable mutation decision.
   */
  public async recordProviderOperationUncertainty(
    input: RecordProviderOperationUncertaintyInput,
  ): Promise<ProviderOperationMutationDecision> {
    return this.repository.recordProviderOperationUncertainty(input);
  }

  /**
   * Record the provider allocation reference for a claimed operation.
   * @param input - Claim and the validated allocation reference.
   * @returns The durable allocation ownership decision.
   */
  public async recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision> {
    return this.repository.recordAllocation(input);
  }

  /**
   * Record positively proven absence of any allocation for the attempt.
   *
   * A recorded absence settles the attempt as `abandoned`, so its waiter is
   * rejected and removed. The bounded evidence is durable in the operation
   * record; the local error only mirrors it for the in-process caller.
   * @param input - Claim, owning execution, and bounded absence evidence.
   * @returns The durable absence decision.
   */
  public async recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision> {
    const decision = await this.repository.recordProvisioningAbsent(input);
    if (decision.kind === 'recorded') {
      this.rejectWaiterWith(
        input.claim.executionAttemptId,
        () =>
          new Error(
            `Attempt '${input.claim.executionAttemptId}' provisioning produced no allocation: ` +
              `${input.evidence.source} reported '${input.evidence.summary}'`,
          ),
      );
    }
    return decision;
  }

  /**
   * Close pre-allocation debt on proof that a provisioner incarnation is gone.
   *
   * A recorded loss settles the attempt as `abandoned`, so its waiter is
   * rejected and removed. The bounded proof evidence is durable in the
   * operation record; the local error only mirrors it for the in-process
   * caller.
   * @param input - Claim, owning execution, and the provisioner loss proof.
   * @returns The durable provisioner-loss decision.
   */
  public async recordProvisionerIncarnationLost(
    input: RecordProvisionerIncarnationLostInput,
  ): Promise<ProvisionerIncarnationLossDecision> {
    const decision = await this.repository.recordProvisionerIncarnationLost(input);
    if (decision.kind === 'recorded') {
      const { evidence, provisionerIncarnationId } = input.proof;
      this.rejectWaiterWith(
        input.claim.executionAttemptId,
        () =>
          new Error(
            `Attempt '${input.claim.executionAttemptId}' lost the provisioner incarnation ` +
              `'${provisionerIncarnationId}' its allocation was bound to: ` +
              `${evidence.source} reported '${evidence.summary}'`,
          ),
      );
    }
    return decision;
  }

  /**
   * Record that a known allocation was confirmed terminated.
   *
   * Advances the operation to terminal convergence without settling the
   * attempt, so the waiter stays pending until a canonical answer exists.
   * @param input - Claim and bounded evidence supporting the termination.
   * @returns The durable termination decision.
   */
  public async recordAllocationTerminated(
    input: RecordAllocationTerminatedInput,
  ): Promise<AllocationTerminationDecision> {
    return this.repository.recordAllocationTerminated(input);
  }

  /**
   * Register a runtime incarnation as an attempt's endpoint.
   *
   * Delegates directly to the repository, which allocates the generation. No
   * waiter changes: registering an endpoint says nothing about the attempt's
   * canonical answer, and a refusal is a statement about the runtime rather
   * than about the outcome anybody is waiting for.
   * @param input - Attempt identity, owning execution, and the runtime incarnation.
   * @returns The durable registration decision.
   */
  public async registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRegistrationDecision> {
    return this.repository.registerRuntime(input);
  }

  /**
   * Admit one operation through an attempt's start gate.
   *
   * Delegates directly to the repository, which mints the operation identifier
   * and enforces the at-most-one guard.
   * @param input - Attempt identity, owning execution, kind, idempotency key, and fence.
   * @returns The durable admission decision.
   */
  public async admitOperation(input: AdmitOperationInput): Promise<OperationAdmissionDecision> {
    return this.repository.admitOperation(input);
  }

  /**
   * Release the attempt's active operation.
   *
   * Delegates directly to the repository. A completed operation is not a
   * canonical answer, so the waiter stays pending: what settles an attempt is
   * a committed outcome or a terminal transition, never a freed slot.
   * @param input - Attempt identity, the operation being completed, and its fence.
   * @returns The durable completion decision.
   */
  public async completeOperation(input: CompleteOperationInput): Promise<OperationCompletionDecision> {
    return this.repository.completeOperation(input);
  }

  /**
   * Record that a registered runtime proved itself ready.
   *
   * Delegates directly to the repository.
   * @param input - Attempt identity, the generation the proof belongs to, and when it was observed.
   * @returns The durable readiness decision.
   */
  public async markRuntimeReady(input: MarkRuntimeReadyInput): Promise<RuntimeReadinessDecision> {
    return this.repository.markRuntimeReady(input);
  }

  /**
   * Read an attempt's runtime and operation control state.
   *
   * Delegates directly to the repository. Unfenced and regardless of status,
   * because a process recovering its view of an attempt needs exactly the
   * superseded and settled ones too.
   * @param executionAttemptId - Attempt whose control state to read.
   * @returns The control state, or `null` when no such attempt exists.
   */
  public async getAttemptControlState(executionAttemptId: string): Promise<AttemptControlState | null> {
    return this.repository.getAttemptControlState(executionAttemptId);
  }

  /**
   * Retrieve the active attempt for a given execution.
   *
   * Delegates directly to the repository.
   * @param executionId - Owner identifier the attempt belongs to.
   * @param executionAttemptId - Attempt identifier to look up.
   * @returns The attempt record if active, or `null`.
   */
  public async getActiveAttempt(
    executionId: ExecutionOwnerId,
    executionAttemptId: string,
  ): Promise<ExecutionAttemptRecord | null> {
    return this.repository.getActiveAttempt(executionId, executionAttemptId);
  }

  /**
   * Render a submission as the durable fact a commit of it would write.
   *
   * Delegates to the repository, which owns the codec and therefore the
   * durable form. An owner boundary calls this once, before its own
   * validation, so it inspects the value the attempt will actually hold
   * rather than the copy the submitter offered — and then hands the same
   * rendering to {@link commitOutcome}, which is what makes the committed
   * outcome necessarily the validated one.
   * @param outcome - Outcome a caller is about to submit.
   * @returns The text a commit would persist and the outcome that text yields.
   * @throws When the codec rejects the outcome or its own durable text.
   */
  public canonicalizeOutcome(outcome: TOutcome): DurableOutcome<TOutcome> {
    return this.repository.canonicalizeOutcome(outcome);
  }

  /**
   * Read a committed durable text back as the outcome it holds.
   *
   * Delegates to the repository, which owns the codec and therefore the
   * durable form. An owner boundary uses it to obtain a copy of the committed
   * outcome that no earlier step of its own can have touched: the value it
   * handed to its validation and to convergence has been in other hands since,
   * and a mutable outcome one of them changed must not be what a waiter
   * observes. The text it decodes is the one the attempt stored.
   * @param text - Durable text an attempt committed.
   * @returns The outcome that text holds, held by nobody else.
   * @throws When the text is not JSON, or not JSON the codec accepts.
   */
  public decodeOutcome(text: string): TOutcome {
    return this.repository.decodeOutcome(text);
  }

  /**
   * Commit a terminal outcome for an attempt.
   *
   * Delegates the durable decision to the repository. For `conflict` and
   * `fenced` decisions, the in-process waiter is rejected immediately because
   * no convergence step follows. For `accepted` and `duplicate` decisions, the
   * waiter is NOT settled here — the caller must invoke {@link settleOutcome}
   * after owner-state convergence succeeds.
   * @param executionAttemptId - The attempt submitting the outcome.
   * @param executionId - Owner identifier the attempt belongs to.
   * @param result - The rendering to commit, from {@link canonicalizeOutcome}.
   * @param runtimeFence - Runtime slot that must remain current for a fresh commit.
   * @returns The durable decision with the canonical outcome when applicable.
   */
  public async commitOutcome(
    executionAttemptId: string,
    executionId: ExecutionOwnerId,
    result: DurableOutcome<TOutcome>,
    runtimeFence?: RuntimeOutcomeFence,
  ): Promise<ExecutionAttemptOutcomeDecision<TOutcome>> {
    const decision = await this.repository.commitOutcome({
      executionAttemptId,
      executionId,
      result,
      ...(runtimeFence === undefined ? {} : { runtimeFence }),
    });

    // Conflict and fenced decisions have no convergence step —
    // reject the waiter immediately so runners observe the rejection
    // without waiting for a convergence that will never happen.
    if (decision.kind === 'conflict' || decision.kind === 'fenced') {
      this.settleWaiterInternal(executionAttemptId, decision);
    }

    return decision;
  }

  /**
   * Obtain the in-process promise for a committed outcome.
   *
   * Returns `undefined` when no waiter exists for the given attempt
   * (e.g. after a process restart or for attempts created by other hosts).
   * @param executionAttemptId - The attempt to wait for.
   * @returns Promise that resolves with the canonical outcome, or `undefined`.
   */
  public waitForOutcome(executionAttemptId: string): Promise<TOutcome> | undefined {
    return this.waiters.get(executionAttemptId)?.promise;
  }

  /**
   * Settle the in-process waiter after owner-state convergence succeeds.
   *
   * Called by the outcome-submission handler only after the durable owner
   * transition has completed. This ensures runners observe the committed
   * outcome only when canonical owner state is consistent.
   * @param executionAttemptId - The attempt whose waiter to settle.
   * @param decision - The durable outcome decision (must be accepted or duplicate).
   */
  public settleOutcome(executionAttemptId: string, decision: ExecutionAttemptOutcomeDecision<TOutcome>): void {
    this.settleWaiterInternal(executionAttemptId, decision);
  }

  /**
   * Remove an in-process waiter without settling it.
   *
   * Used when the caller no longer needs to wait (e.g. cancellation before
   * outcome submission).
   * @param executionAttemptId - The attempt whose waiter should be removed.
   */
  public discardWaiter(executionAttemptId: string): void {
    this.waiters.delete(executionAttemptId);
  }

  /**
   * Reject and remove an in-process waiter without making a durable attempt claim.
   *
   * Use only when local dispatch ownership cannot safely await canonical
   * terminalization, such as an unconfirmed provider cleanup. The durable
   * attempt remains unchanged for recovery or operator remediation.
   * @param executionAttemptId - Attempt whose local waiter must be rejected.
   * @param error - Local failure delivered to the current-process waiter.
   */
  public rejectAndDiscardWaiter(executionAttemptId: string, error: Error): void {
    this.rejectWaiterWith(executionAttemptId, () => error);
  }

  /**
   * Reject and remove a waiter with an error built only if one is waiting.
   *
   * Every durable transition that rejects a waiter is also the transition a
   * remediating process runs after a restart, where by definition no waiter
   * from the original dispatch survives. Building the `Error` — and capturing
   * a stack for it — before looking would make that the common case, and it is
   * the case where the error is never delivered to anyone.
   * @param executionAttemptId - Attempt whose local waiter must be rejected.
   * @param describeFailure - Builds the failure, called only when a waiter exists.
   */
  private rejectWaiterWith(executionAttemptId: string, describeFailure: () => Error): void {
    const waiter = this.waiters.get(executionAttemptId);
    if (waiter === undefined) return;
    void waiter.promise.catch(() => undefined);
    waiter.reject(describeFailure());
    this.waiters.delete(executionAttemptId);
  }

  // ─────────────────────────────────────────────────────────
  // Recovery Operations
  // ─────────────────────────────────────────────────────────

  /**
   * Whether the injected repository supports recovery operations.
   *
   * Recovery is one indivisible capability on the port, so this is one
   * presence check rather than four: a repository either carries the
   * {@link ExecutionAttemptRecoveryOperations} object or it does not.
   * @returns `true` when the repository exposes its recovery operations.
   */
  public get supportsRecovery(): boolean {
    return this.repository.recovery !== undefined;
  }

  /**
   * Look up an attempt by its identifier, regardless of active status.
   *
   * Delegates to the repository's `getAttemptWithAllocation` operation.
   * Throws when the repository does not support recovery.
   * @param executionAttemptId - The attempt to look up.
   * @returns The attempt record, or `null` if no such attempt exists.
   */
  public async getAttemptWithAllocation(executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
    return this.requireRecovery('getAttemptWithAllocation').getAttemptWithAllocation(executionAttemptId);
  }

  /**
   * Record an allocation that provider discovery found for the attempt.
   *
   * Delegates to the repository's `recordDiscoveredAllocation` operation.
   * Throws when the repository does not support recovery.
   * @param input - Claim and the discovered allocation reference.
   * @returns The durable discovered-allocation decision.
   */
  public async recordDiscoveredAllocation(input: RecordAllocationInput): Promise<DiscoveredAllocationDecision> {
    return this.requireRecovery('recordDiscoveredAllocation').recordDiscoveredAllocation(input);
  }

  /**
   * Compare-and-set update of the allocation reference for a claimed attempt.
   *
   * Validates that `currentRef` and `nextRef` share the same `providerId`
   * before delegating to the repository. Provider identity must not change
   * during correlation — only the opaque `providerData` evolves.
   * @param input - CAS evolution input with current and next references.
   * @returns The evolution decision.
   */
  public async evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision> {
    const recovery = this.requireRecovery('evolveAllocationRef');

    if (input.currentRef.providerId !== input.nextRef.providerId) {
      throw new Error(
        `Provider identity mismatch in allocation ref evolution: ` +
          `currentRef.providerId '${input.currentRef.providerId}' !== ` +
          `nextRef.providerId '${input.nextRef.providerId}'. ` +
          `Provider identity must not change during correlation.`,
      );
    }

    return recovery.evolveAllocationRef(input);
  }

  /**
   * List all recoverable (allocated, non-settled) attempts for an execution.
   *
   * Delegates to the repository's `getRecoverableAttempts` operation.
   * Throws when the repository does not support recovery.
   * @param executionId - Owner identifier the attempts belong to.
   * @returns Allocated, non-settled attempts eligible for recovery, oldest first.
   */
  public async getRecoverableAttempts(executionId: ExecutionOwnerId): Promise<readonly RecoverableAttemptRecord[]> {
    return this.requireRecovery('getRecoverableAttempts').getRecoverableAttempts(executionId);
  }

  /**
   * Record a confirmed infrastructure failure for an allocated attempt.
   *
   * Delegates the durable decision to the repository. When the failure is
   * recorded, rejects the in-process waiter (if any) so runners observe
   * the infrastructure failure immediately.
   * @param input - Claim and the owning execution.
   * @returns The infrastructure failure decision.
   */
  public async recordInfrastructureFailure(
    input: RecordInfrastructureFailureInput,
  ): Promise<InfrastructureFailureDecision> {
    const decision = await this.repository.recordInfrastructureFailure(input);

    if (decision.kind === 'recorded') {
      this.rejectWaiterWith(
        input.claim.executionAttemptId,
        () =>
          new Error(
            `Attempt '${input.claim.executionAttemptId}' suffered infrastructure failure: ` +
              `the provider allocation terminated without an acknowledged outcome`,
          ),
      );
    }

    return decision;
  }

  /**
   * Durably abandon a dispatch attempt that did not receive an allocation.
   *
   * The repository refuses to use this transition for allocated attempts so a
   * dispatcher cannot silently strand live infrastructure.
   * @param executionAttemptId - Attempt whose pre-allocation dispatch ended.
   * @param executionId - Owner identifier the attempt belongs to.
   * @returns The durable abandonment decision.
   */
  public async abandonPendingAttempt(
    executionAttemptId: string,
    executionId: ExecutionOwnerId,
  ): Promise<PendingAttemptAbandonmentDecision> {
    const decision = await this.repository.abandonPendingAttempt(executionAttemptId, executionId);
    if (decision.kind === 'abandoned' || decision.kind === 'already-abandoned') {
      this.waiters.delete(executionAttemptId);
    }
    return decision;
  }

  // ─────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────

  /**
   * Obtain the repository's recovery operations, or refuse the call.
   * @param operation - The recovery operation being attempted.
   * @returns The repository's recovery operations.
   * @throws When the repository does not implement recovery operations.
   */
  private requireRecovery(operation: string): ExecutionAttemptRecoveryOperations {
    const { recovery } = this.repository;
    if (recovery === undefined) {
      throw new Error(
        `Recovery operation '${operation}' requires a repository that exposes ` +
          `recovery operations. The injected repository does not support recovery.`,
      );
    }
    return recovery;
  }

  /**
   * Install an in-process waiter for the given attempt.
   * @param executionAttemptId - Attempt to install a waiter for.
   */
  private installWaiter(executionAttemptId: string): void {
    this.waiters.set(executionAttemptId, buildDeferred<TOutcome, Error>());
  }

  /**
   * Settle the in-process waiter based on a repository decision.
   *
   * For accepted/duplicate, resolves with the canonical outcome.
   * For conflict/fenced, rejects with a descriptive error.
   * @param executionAttemptId - Attempt whose waiter to settle.
   * @param decision - The durable outcome decision from the repository.
   */
  private settleWaiterInternal(executionAttemptId: string, decision: ExecutionAttemptOutcomeDecision<TOutcome>): void {
    const waiter = this.waiters.get(executionAttemptId);
    if (!waiter) {
      return;
    }

    switch (decision.kind) {
      case 'accepted':
      case 'duplicate':
        waiter.resolve(decision.outcome);
        break;
      case 'conflict':
        waiter.reject(
          new Error(
            `Outcome conflict for attempt '${executionAttemptId}': ` + `a different outcome was already committed`,
          ),
        );
        break;
      case 'fenced':
        waiter.reject(
          new Error(
            `Attempt '${executionAttemptId}' has been fenced: ` +
              `it is no longer the active attempt for this execution`,
          ),
        );
        break;
    }

    this.waiters.delete(executionAttemptId);
  }
}
