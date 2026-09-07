import {
  type ExecutionAttemptOperationKind,
  type WorkflowRunResult,
  type WorkspaceRequirement,
} from '@makaio/contracts';
import {
  type ReportOperationInput,
  type BeginProvisioningInput,
  type ExecutionAttemptRepository,
} from '../../execution-attempt-repository.js';
import type { ProviderOperationClaim } from '../../provider-operation.js';
import {
  makeTestInstruction,
  makeBeginProvisioningInput,
  makeTestAllocationRef,
  type ProvisioningClaimGrantor,
} from '../attempt-fixtures.js';

let sequence = 0;

/** Test-only bootstrap budget supplied by every ordinary conformance attempt. */
export const TEST_BOOTSTRAP_TIMEOUT_MS = 60_000;

/**
 * Allocate a fresh execution and attempt identifier pair.
 * @returns Unique execution and attempt identifiers.
 */
export function nextIds(): { readonly executionId: string; readonly executionAttemptId: string } {
  sequence += 1;
  return { executionId: `parity-exec-${sequence}`, executionAttemptId: `parity-attempt-${sequence}` };
}

/**
 * Create an attempt and win its provisioning claim.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param overrides - Begin-provisioning fields to replace, such as the lifetime.
 * @returns The claim the winning begin issued.
 * @throws When provisioning does not start.
 */
export async function startAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  overrides: Partial<BeginProvisioningInput> = {},
): Promise<ProviderOperationClaim> {
  await repository.createAttempt({
    ...ids,
    instruction: makeTestInstruction(),
    bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
  });
  const grantor: ProvisioningClaimGrantor = repository;
  const decision = await grantor.beginProvisioning(
    makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId, overrides),
  );
  if (decision.kind !== 'started') throw new Error(`Expected provisioning to start, got '${decision.kind}'`);
  return decision.claim;
}

/** Runtime incarnation the control-state cases register unless they need a second one. */
export const RUNTIME_INCARNATION_ID = 'runtime-incarnation-1';

/**
 * Create a ready scratch attempt with a required Preparation operation.
 * @param repository - Real repository under test.
 * @param requestedSourceRoots - Source roots the instruction requires and the report binds.
 * @returns Successful report input for its admitted Preparation.
 */
export async function preparationAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  requestedSourceRoots: WorkspaceRequirement['sourceRoots'] = [],
): Promise<ReportOperationInput> {
  const ids = nextIds();
  await repository.createAttempt({
    ...ids,
    instruction: makeTestInstruction({
      workspace: { provisioning: 'create', custody: 'disposable', sourceRoots: requestedSourceRoots, setup: [] },
    }),
    bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
  });
  const provisioning = await repository.beginProvisioning(
    makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
  );
  if (provisioning.kind !== 'started') throw new Error('Expected provisioning');
  await repository.recordAllocation({ claim: provisioning.claim, allocationRef: makeTestAllocationRef() });
  const runtimeGeneration = await registerTestRuntime(repository, ids);
  await proveTestReadiness(repository, ids, runtimeGeneration);
  const operationId = await admitTestOperation(repository, ids, runtimeGeneration, 'workspace-preparation', 'prepare');
  return {
    ...ids,
    operationId,
    runtimeGeneration,
    result: {
      kind: 'workspace-prepared',
      binding: {
        workspaceRoot: '/scratch/first',
        sourceRoots: requestedSourceRoots.map((root) => ({ id: root.id, path: `/scratch/first/${root.path}` })),
      },
    },
  };
}

/**
 * Create an attempt, win its provisioning claim, and record an allocation.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @returns The claim the winning begin issued.
 * @throws When provisioning does not start or the allocation is not recorded.
 */
export async function allocateAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
): Promise<ProviderOperationClaim> {
  const claim = await startAttempt(repository, ids);
  const decision = await repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
  if (decision.kind !== 'recorded') throw new Error(`Expected the allocation to be recorded, got '${decision.kind}'`);
  return claim;
}

/**
 * Register a runtime incarnation as the attempt's endpoint.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param runtimeIncarnationId - Incarnation to register.
 * @returns The generation the repository allocated.
 * @throws When the registration is refused.
 */
export async function registerTestRuntime(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  runtimeIncarnationId: string = RUNTIME_INCARNATION_ID,
): Promise<number> {
  const decision = await repository.registerRuntime({ ...ids, runtimeIncarnationId });
  if (decision.kind !== 'registered') throw new Error(`Expected the runtime to register, got '${decision.kind}'`);
  return decision.runtimeGeneration;
}

/**
 * Prove readiness for a registered generation.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param runtimeGeneration - Generation the proof belongs to.
 * @returns The instant the repository accepted.
 * @throws When readiness is refused.
 */
export async function proveTestReadiness(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  runtimeGeneration: number,
): Promise<string> {
  const decision = await repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() });
  if (decision.kind !== 'ready') throw new Error(`Expected readiness to be accepted, got '${decision.kind}'`);
  return decision.acceptedAt;
}

/**
 * Admit one operation through the attempt's start gate.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param runtimeGeneration - Generation the admission is fenced against.
 * @param operationKind - Kind of operation to admit.
 * @param admissionKey - Idempotency key for the admission.
 * @returns The identifier the repository minted.
 * @throws When the admission is refused.
 */
export async function admitTestOperation(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  runtimeGeneration: number,
  operationKind: ExecutionAttemptOperationKind,
  admissionKey: string,
): Promise<string> {
  const decision = await repository.admitOperation({ ...ids, operationKind, admissionKey, runtimeGeneration });
  if (decision.kind !== 'admitted') throw new Error(`Expected the operation to be admitted, got '${decision.kind}'`);
  return decision.operationId;
}

/**
 * Bring an attempt all the way to a proven runtime endpoint.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @returns The generation the proven runtime holds.
 * @throws When any step of the handshake is refused.
 */
export async function readyAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
): Promise<number> {
  await allocateAttempt(repository, ids);
  const runtimeGeneration = await registerTestRuntime(repository, ids);
  await proveTestReadiness(repository, ids, runtimeGeneration);
  return runtimeGeneration;
}
