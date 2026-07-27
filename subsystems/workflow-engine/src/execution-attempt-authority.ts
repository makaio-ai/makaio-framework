import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import type {
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRepository,
  InfrastructureFailureDecision,
  AllocationRecordingDecision,
  PendingAttemptAbandonmentDecision,
  ProvisioningClaimDecision,
  ProvisioningFailureDecision,
  RecoverableAttemptRecord,
} from './execution-attempt-repository.js';
import { buildDeferred, type Deferred } from './runtime/deferred.js';

// ─────────────────────────────────────────────────────────────
// Waiter Types
// ─────────────────────────────────────────────────────────────

/**
 * In-process waiter for a committed outcome.
 *
 * Built via {@link buildDeferred}. The Authority holds one waiter per active
 * attempt so callers (e.g. WorkerNodeRunner) can `await` the durable outcome
 * without polling.
 *
 * Settlement lifecycle:
 * - `conflict` / `fenced`: rejected immediately by {@link commitOutcome}.
 * - `accepted` / `duplicate`: NOT settled by commitOutcome. The caller
 *   must invoke {@link settleOutcome} after workflow-state convergence
 *   succeeds.
 */
type OutcomeWaiter = Deferred<WorkflowRunResult, Error>;

// ─────────────────────────────────────────────────────────────
// Authority Service
// ─────────────────────────────────────────────────────────────

/**
 * Execution attempt Authority service.
 *
 * Owns:
 * - attempt ID generation (`crypto.randomUUID()`);
 * - current-process waiters so runners can `await` a committed outcome;
 * - idempotent workflow-state convergence for both `accepted` and `duplicate`.
 *
 * Delegates:
 * - durable attempt creation, allocation recording, and outcome commit
 *   decisions to the injected {@link ExecutionAttemptRepository}.
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
 */
export class ExecutionAttemptAuthority {
  private readonly repository: ExecutionAttemptRepository;

  /**
   * In-process waiters keyed by `executionAttemptId`.
   *
   * A waiter is created in {@link createAttempt} and settled via
   * {@link settleOutcome} after convergence. Callers use
   * {@link waitForOutcome} to obtain the promise.
   */
  private readonly waiters = new Map<string, OutcomeWaiter>();

  /**
   * @param repository - Injected durable attempt persistence port.
   */
  public constructor(repository: ExecutionAttemptRepository) {
    this.repository = repository;
  }

  /**
   * Create a new execution attempt with an Authority-generated ID.
   *
   * Persists the attempt through the repository and installs an in-process
   * waiter for the committed outcome. Must be called before dispatch.
   * @param executionId - Workflow execution identifier.
   * @returns The persisted attempt record.
   */
  public async createAttempt(executionId: string): Promise<ExecutionAttemptRecord> {
    const executionAttemptId = crypto.randomUUID();
    const record = await this.repository.createAttempt({
      executionAttemptId,
      executionId,
    });

    // Install the in-process waiter before returning so that waitForOutcome
    // is immediately available to the caller.
    this.installWaiter(executionAttemptId);

    return record;
  }

  /**
   * Claim durable ownership of provider provisioning for an active attempt.
   *
   * Delegates directly to the repository immediately before a provider call.
   * @param executionAttemptId - The attempt about to start provisioning.
   * @param executionId - Workflow execution identifier for fence checking.
   * @returns The durable provisioning ownership decision.
   */
  public async beginProvisioning(executionAttemptId: string, executionId: string): Promise<ProvisioningClaimDecision> {
    return this.repository.beginProvisioning(executionAttemptId, executionId);
  }

  /**
   * Record the provider allocation reference for an active provisioning attempt.
   * @param executionAttemptId - The attempt that received the allocation.
   * @param allocationRef - Validated, JSON-safe provider allocation reference.
   * @returns The durable allocation ownership decision.
   */
  public async recordAllocation(
    executionAttemptId: string,
    allocationRef: ProviderAllocationRef,
  ): Promise<AllocationRecordingDecision> {
    return this.repository.recordAllocation(executionAttemptId, allocationRef);
  }

  /**
   * Record a provider failure that occurred while provisioning an attempt.
   *
   * A recorded failure is terminal, so its waiter is rejected and removed.
   * @param executionAttemptId - Provisioning attempt whose provider call failed.
   * @param executionId - Workflow execution identifier.
   * @returns The durable provisioning-failure decision.
   */
  public async recordProvisioningFailure(
    executionAttemptId: string,
    executionId: string,
  ): Promise<ProvisioningFailureDecision> {
    const decision = await this.repository.recordProvisioningFailure(executionAttemptId, executionId);
    if (decision.kind === 'recorded') {
      this.rejectAndDiscardWaiter(
        executionAttemptId,
        new Error(`Attempt '${executionAttemptId}' provider provisioning failed before allocation was recorded`),
      );
    }
    return decision;
  }

  /**
   * Retrieve the active attempt for a given execution.
   *
   * Delegates directly to the repository.
   * @param executionId - Workflow execution identifier.
   * @param executionAttemptId - Attempt identifier to look up.
   * @returns The attempt record if active, or `null`.
   */
  public async getActiveAttempt(
    executionId: string,
    executionAttemptId: string,
  ): Promise<ExecutionAttemptRecord | null> {
    return this.repository.getActiveAttempt(executionId, executionAttemptId);
  }

  /**
   * Commit a terminal outcome for an attempt.
   *
   * Delegates the durable decision to the repository. For `conflict` and
   * `fenced` decisions, the in-process waiter is rejected immediately because
   * no convergence step follows. For `accepted` and `duplicate` decisions, the
   * waiter is NOT settled here — the caller must invoke {@link settleOutcome}
   * after workflow-state convergence succeeds.
   * @param executionAttemptId - The attempt submitting the outcome.
   * @param executionId - Workflow execution identifier.
   * @param result - Terminal workflow result to commit.
   * @returns The durable decision with the canonical outcome when applicable.
   */
  public async commitOutcome(
    executionAttemptId: string,
    executionId: string,
    result: WorkflowRunResult,
  ): Promise<ExecutionAttemptOutcomeDecision> {
    const decision = await this.repository.commitOutcome({
      executionAttemptId,
      executionId,
      result,
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
   * @returns Promise that resolves with the canonical workflow result, or `undefined`.
   */
  public waitForOutcome(executionAttemptId: string): Promise<WorkflowRunResult> | undefined {
    return this.waiters.get(executionAttemptId)?.promise;
  }

  /**
   * Settle the in-process waiter after workflow-state convergence succeeds.
   *
   * Called by the outcome-submission handler only after the durable workflow
   * transition has completed. This ensures runners observe the committed
   * outcome only when canonical workflow state is consistent.
   * @param executionAttemptId - The attempt whose waiter to settle.
   * @param decision - The durable outcome decision (must be accepted or duplicate).
   */
  public settleOutcome(executionAttemptId: string, decision: ExecutionAttemptOutcomeDecision): void {
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
    const waiter = this.waiters.get(executionAttemptId);
    if (waiter === undefined) return;
    void waiter.promise.catch(() => undefined);
    waiter.reject(error);
    this.waiters.delete(executionAttemptId);
  }

  // ─────────────────────────────────────────────────────────
  // Recovery Operations
  // ─────────────────────────────────────────────────────────

  /**
   * Whether the injected repository supports recovery operations.
   *
   * Returns `true` when the repository implements `getAttemptWithAllocation`,
   * `evolveAllocationRef`, and `getRecoverableAttempts`. Callers should check this before invoking
   * recovery methods.
   * @returns `true` when the repository implements all recovery operations.
   */
  public get supportsRecovery(): boolean {
    return (
      typeof this.repository.getAttemptWithAllocation === 'function' &&
      typeof this.repository.evolveAllocationRef === 'function' &&
      typeof this.repository.getRecoverableAttempts === 'function'
    );
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
    this.assertRecoverySupport('getAttemptWithAllocation');
    return this.repository.getAttemptWithAllocation!(executionAttemptId);
  }

  /**
   * Compare-and-set update of the allocation reference for an active attempt.
   *
   * Validates that `currentRef` and `nextRef` share the same `providerId`
   * before delegating to the repository. Provider identity must not change
   * during correlation — only the opaque `providerData` evolves.
   * @param input - CAS evolution input with current and next references.
   * @returns The evolution decision.
   */
  public async evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision> {
    this.assertRecoverySupport('evolveAllocationRef');

    if (input.currentRef.providerId !== input.nextRef.providerId) {
      throw new Error(
        `Provider identity mismatch in allocation ref evolution: ` +
          `currentRef.providerId '${input.currentRef.providerId}' !== ` +
          `nextRef.providerId '${input.nextRef.providerId}'. ` +
          `Provider identity must not change during correlation.`,
      );
    }

    return this.repository.evolveAllocationRef!(input);
  }

  /**
   * List all recoverable (allocated, non-settled) attempts for an execution.
   *
   * Delegates to the repository's `getRecoverableAttempts` operation.
   * Throws when the repository does not support recovery.
   * @param executionId - Workflow execution identifier.
   * @returns Allocated, non-settled attempts eligible for recovery.
   */
  public async getRecoverableAttempts(executionId: string): Promise<readonly RecoverableAttemptRecord[]> {
    this.assertRecoverySupport('getRecoverableAttempts');
    return this.repository.getRecoverableAttempts!(executionId);
  }

  /**
   * Record a confirmed infrastructure failure for an allocated attempt.
   *
   * Delegates the durable decision to the repository. When the failure is
   * recorded, rejects the in-process waiter (if any) so runners observe
   * the infrastructure failure immediately.
   * @param executionAttemptId - The attempt that suffered infrastructure failure.
   * @param executionId - Workflow execution identifier.
   * @returns The infrastructure failure decision.
   */
  public async recordInfrastructureFailure(
    executionAttemptId: string,
    executionId: string,
  ): Promise<InfrastructureFailureDecision> {
    const decision = await this.repository.recordInfrastructureFailure(executionAttemptId, executionId);

    if (decision.kind === 'recorded') {
      this.rejectAndDiscardWaiter(
        executionAttemptId,
        new Error(
          `Attempt '${executionAttemptId}' suffered infrastructure failure: ` +
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
   * @param executionId - Workflow execution identifier.
   * @returns The durable abandonment decision.
   */
  public async abandonPendingAttempt(
    executionAttemptId: string,
    executionId: string,
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
   * Assert that the injected repository supports recovery operations.
   * @param operation - The recovery operation being attempted.
   * @throws When the repository does not implement recovery operations.
   */
  private assertRecoverySupport(operation: string): void {
    if (!this.supportsRecovery) {
      throw new Error(
        `Recovery operation '${operation}' requires a repository that ` +
          `implements recovery operations (getAttemptWithAllocation, ` +
          `evolveAllocationRef, getRecoverableAttempts). The injected repository does not support recovery.`,
      );
    }
  }

  /**
   * Install an in-process waiter for the given attempt.
   * @param executionAttemptId - Attempt to install a waiter for.
   */
  private installWaiter(executionAttemptId: string): void {
    this.waiters.set(executionAttemptId, buildDeferred<WorkflowRunResult, Error>());
  }

  /**
   * Settle the in-process waiter based on a repository decision.
   *
   * For accepted/duplicate, resolves with the canonical outcome.
   * For conflict/fenced, rejects with a descriptive error.
   * @param executionAttemptId - Attempt whose waiter to settle.
   * @param decision - The durable outcome decision from the repository.
   */
  private settleWaiterInternal(executionAttemptId: string, decision: ExecutionAttemptOutcomeDecision): void {
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
