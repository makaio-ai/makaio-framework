import type { BoundedRecoveryEvidence, ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import { PROVIDER_ALLOCATION_REF_VERSION, WorkflowRunResultSchema } from '@makaio/contracts';
import type {
  AllocationRecordingDecision,
  BeginProvisioningInput,
  ExecutionAttemptRecord,
  ExecutionOwnerId,
  OutcomeCodec,
  ProvisioningClaimDecision,
  RecordAllocationInput,
} from '../execution-attempt-repository.js';
import type { ProcessBoundProvisionerLossProof, ProviderOperationClaim } from '../provider-operation.js';

/** Controller process incarnation used by tests that need one fixed owner. */
export const TEST_OWNER_ID = 'controller-incarnation-1';

/** Provisioner process incarnation used by tests that need one fixed provisioner. */
export const TEST_PROVISIONER_INCARNATION_ID = 'provisioner-incarnation-1';

/** Provider identifier bound by the default begin-provisioning fixture. */
export const TEST_PROVIDER_ID = 'test-provider';

/**
 * The single operation every provisioning-claim holder needs.
 *
 * The durable repository and the Authority that wraps it expose it with the
 * same signature, so a fixture written against this shape drives either one
 * without knowing which layer it was handed.
 */
export interface ProvisioningClaimGrantor {
  /**
   * Claim the durable provisioning phase for one attempt.
   * @param input - Attempt identity, provider binding, and initial claim context.
   * @returns The durable provisioning ownership decision.
   */
  beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision>;
}

/**
 * Build an ISO-8601 timestamp offset from now.
 *
 * Tests use explicit offsets so lease expiry is asserted against real
 * comparisons rather than a hidden default duration.
 * @param offsetMs - Milliseconds to add to the current time (may be negative).
 * @returns The offset timestamp in ISO-8601 form.
 */
export function leaseAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Build a begin-provisioning input with explicit, overridable identity.
 * @param executionAttemptId - Attempt about to start provisioning.
 * @param executionId - Workflow execution the attempt belongs to.
 * @param overrides - Fields to replace on the default input.
 * @returns A complete begin-provisioning input.
 */
export function makeBeginProvisioningInput(
  executionAttemptId: string,
  executionId: string,
  overrides: Partial<BeginProvisioningInput> = {},
): BeginProvisioningInput {
  return {
    executionAttemptId,
    executionId,
    providerId: TEST_PROVIDER_ID,
    allocationLifetime: 'provider-managed',
    provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
    ownerId: TEST_OWNER_ID,
    leaseExpiresAt: leaseAt(60_000),
    ...overrides,
  };
}

/**
 * Begin provisioning and return the issued claim.
 *
 * Fails loudly on any decision other than `started`, so a test that depends
 * on holding the operation cannot silently continue without a claim.
 * @param grantor - Repository or Authority that issues the claim.
 * @param executionAttemptId - Attempt about to start provisioning.
 * @param executionId - Workflow execution the attempt belongs to.
 * @param overrides - Fields to replace on the default begin input.
 * @returns The claim issued by the successful begin.
 */
export async function beginTestProvisioning(
  grantor: ProvisioningClaimGrantor,
  executionAttemptId: string,
  executionId: string,
  overrides: Partial<BeginProvisioningInput> = {},
): Promise<ProviderOperationClaim> {
  const decision = await grantor.beginProvisioning(
    makeBeginProvisioningInput(executionAttemptId, executionId, overrides),
  );
  if (decision.kind !== 'started') {
    throw new Error(`Expected provisioning to start, got '${decision.kind}'`);
  }
  return decision.claim;
}

/**
 * Build bounded recovery evidence that satisfies the contract schema.
 * @param overrides - Fields to replace on the default evidence.
 * @returns Bounded, durable, non-secret evidence.
 */
export function makeEvidence(overrides: Partial<BoundedRecoveryEvidence> = {}): BoundedRecoveryEvidence {
  return {
    source: TEST_PROVIDER_ID,
    summary: 'provider rejected the request before creating anything',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build positive proof that a provisioner process incarnation is gone.
 *
 * The incarnation defaults to the one {@link makeBeginProvisioningInput} binds,
 * so a test that wants a proof about a *different* process states that
 * difference explicitly rather than relying on a fixture default.
 * @param provisionerIncarnationId - Incarnation the proof is about.
 * @param evidence - Bounded evidence supporting the loss claim.
 * @returns A loss proof satisfying the contract's bounds.
 */
export function makeProcessLossProof(
  provisionerIncarnationId: string = TEST_PROVISIONER_INCARNATION_ID,
  evidence: BoundedRecoveryEvidence = makeEvidence({ summary: 'supervisor observed the provisioner process exit' }),
): ProcessBoundProvisionerLossProof {
  return { kind: 'provisioner-incarnation-lost', provisionerIncarnationId, evidence };
}

/**
 * Build a valid allocation reference.
 * @param providerId - Provider that owns the reference.
 * @param providerData - Opaque provider-specific correlation data.
 * @returns A versioned allocation reference.
 */
export function makeTestAllocationRef(
  providerId: string = TEST_PROVIDER_ID,
  providerData: Record<string, unknown> = { runId: 1 },
): ProviderAllocationRef {
  return { version: PROVIDER_ALLOCATION_REF_VERSION, providerId, providerData };
}

/**
 * Outcome codec for the workflow adapter: validates through
 * {@link WorkflowRunResultSchema} and persists the canonical JSON text.
 */
export const workflowRunResultOutcomeCodec: OutcomeCodec<WorkflowRunResult> = {
  parse: (input) => WorkflowRunResultSchema.parse(input),
  serialize: (outcome) => JSON.stringify(outcome),
};

/**
 * Build a terminal workflow result the port can commit.
 * @param executionId - Execution the result belongs to.
 * @param status - Terminal status to report.
 * @returns A canonical workflow run result.
 */
export function makeTestWorkflowResult(
  executionId: string,
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunResult {
  const base = { executionId, workflowId: 'contract-workflow' } as const;
  return status === 'completed'
    ? { ...base, status: 'completed' }
    : { ...base, status: 'failed', error: 'contract failure' };
}

// ─────────────────────────────────────────────────────────────
// Allocation driver
// ─────────────────────────────────────────────────────────────

/**
 * The operations that bring an attempt from creation to `allocated`.
 *
 * The durable repository and the Authority expose all three with the same
 * shapes, so one driver serves harnesses at either layer.
 */
export interface AttemptAllocationDriver extends ProvisioningClaimGrantor {
  /**
   * Persist a new attempt for its owner.
   * @param executionId - Owner identifier the attempt belongs to.
   * @returns The persisted attempt record.
   */
  createAttempt(executionId: ExecutionOwnerId): Promise<ExecutionAttemptRecord>;
  /**
   * Record the allocation the provider returned for the claimed attempt.
   * @param input - The claim and the allocation reference to record.
   * @returns The durable allocation recording decision.
   */
  recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision>;
}

/**
 * Drive an existing attempt to `allocated`, the state a runtime may register against.
 *
 * A created attempt answers `not-allocated` to every registration, so a
 * harness that lets a runtime register owes these two moves. They are the
 * test-side stand-in for the provisioner a real dispatch would run.
 * @param driver - Repository or Authority owning the attempt.
 * @param executionAttemptId - Attempt to provision and allocate.
 * @param executionId - Owner the attempt belongs to.
 * @throws When provisioning does not start or the allocation is not recorded.
 */
export async function driveTestAttemptToAllocated(
  driver: Pick<AttemptAllocationDriver, 'beginProvisioning' | 'recordAllocation'>,
  executionAttemptId: string,
  executionId: ExecutionOwnerId,
): Promise<void> {
  const claim = await driver.beginProvisioning(makeBeginProvisioningInput(executionAttemptId, executionId));
  if (claim.kind !== 'started') throw new Error(`Expected provisioning to start, got '${claim.kind}'`);
  const allocation = await driver.recordAllocation({ claim: claim.claim, allocationRef: makeTestAllocationRef() });
  if (allocation.kind !== 'recorded') {
    throw new Error(`Expected the allocation to be recorded, got '${allocation.kind}'`);
  }
}

/**
 * Create one attempt through the Authority and drive it to `allocated`.
 * @param driver - Authority owning the attempt; it mints the attempt identifier.
 * @param executionId - Owner the attempt belongs to.
 * @returns The allocated attempt's identifier.
 * @throws When provisioning does not start or the allocation is not recorded.
 */
export async function allocateTestAttempt(
  driver: AttemptAllocationDriver,
  executionId: ExecutionOwnerId,
): Promise<string> {
  const { executionAttemptId } = await driver.createAttempt(executionId);
  await driveTestAttemptToAllocated(driver, executionAttemptId, executionId);
  return executionAttemptId;
}
