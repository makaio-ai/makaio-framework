import { BusAbortError, isRequestCancellation, type IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
  JsonValueSchema,
  type ExecutionAttemptInstruction,
  type ExecutionAttemptOutcome,
  type ExecutionAttemptWorkspaceBinding,
  type JsonValue,
  type OutcomeAckDecision,
  type WorkspaceRequirement,
} from '@makaio/contracts';
import { bindLocalWorkspace, type LocalWorkspaceHandle } from '../workspace-preparation/workspace-preparation.js';
import {
  requestAuthorityWithRetry,
  submitAttemptOutcomeWithAck,
  type OutcomeReconnect,
  type OutcomeSubmitRetryConfig,
} from './outcome-submission.js';

/** One installed, versioned local executor for an opaque workload instruction. */
export interface InstalledWorkloadAdapter {
  /** Workload kind this adapter accepts. */
  readonly kind: string;
  /** Exact frozen input version this adapter accepts. */
  readonly version: string;
  /**
   * Bind workload-local control before any mutating operation is admitted.
   *
   * The returned signal may combine caller cancellation with workload-specific
   * control. Its release stays live through terminal acknowledgement so a
   * cancellation cannot race a locally detached subscription.
   * @param input - Frozen instruction and outer Runtime cancellation signal.
   * @returns Effective work signal and a release operation for local control state.
   */
  bindControl?(input: {
    readonly instruction: ExecutionAttemptInstruction;
    readonly signal?: AbortSignal;
  }): Promise<WorkloadControlBinding>;
  /**
   * Execute only after Invocation admission.
   *
   * An adapter may acquire and load its own executable artifact here. That is
   * workload execution, not Workspace Preparation.
   * @param input - Frozen instruction, accepted optional Workspace binding and cancellation.
   * @returns Opaque JSON result interpreted by the owner-side adapter.
   */
  invoke(input: {
    readonly instruction: ExecutionAttemptInstruction;
    readonly workspace?: ExecutionAttemptWorkspaceBinding;
    readonly signal?: AbortSignal;
  }): Promise<JsonValue>;
}

/** Workload-local control subscription retained through the terminal outcome acknowledgement. */
export interface WorkloadControlBinding {
  /** Effective signal for local setup and workload execution. */
  readonly signal: AbortSignal;
  /** Detach local control state after the terminal outcome is acknowledged. */
  release(): void;
}

/** Runtime-local dependencies for realizing one optional Workspace requirement. */
export interface WorkloadInvocationPreparation {
  /** Bind/create and retain one local Workspace until explicit release. */
  prepare(input: {
    readonly requirement: WorkspaceRequirement;
    readonly workspaceRoot: string;
  }): Promise<LocalWorkspaceHandle>;
}

/** Inputs for the fixed Preparation → Invocation sequence of an already registered Runtime. */
export interface RunWorkloadInvocationOptions {
  /** Authority-created Attempt identity. */
  readonly executionAttemptId: string;
  /** Generation accepted during Runtime registration. */
  readonly runtimeGeneration: number;
  /** Explicit host-selected local root, required only by a declared Workspace. */
  readonly workspaceRoot?: string;
  /** Private host environment for setup subprocesses; never included in the portable instruction or receipts. */
  readonly setupEnv?: Readonly<NodeJS.ProcessEnv>;
  /** Installed workload adapters available in this Runtime. */
  readonly adapters: readonly InstalledWorkloadAdapter[];
  /** Cancellation signal forwarded to local setup and workload execution. */
  readonly signal?: AbortSignal;
  /** Reconnect hook reused for terminal outcome acknowledgement. */
  readonly reconnect?: OutcomeReconnect;
  /** Bounded retry policy reused for terminal outcome acknowledgement. */
  readonly retry?: OutcomeSubmitRetryConfig;
  /** Local Workspace realization seam; defaults to the Node bind/create helper. */
  readonly preparation?: WorkloadInvocationPreparation;
}

/** Durable result visible after generic terminal-outcome acknowledgement. */
export interface WorkloadInvocationResult {
  /** Exact technical failure or opaque workload result committed by the Authority. */
  readonly outcome: ExecutionAttemptOutcome;
  /** Authority acknowledgement after canonical owner convergence. */
  readonly decision: OutcomeAckDecision;
}

/** Result shape returned by the local Workspace setup handle. */
type LocalSetupStatus = Awaited<ReturnType<LocalWorkspaceHandle['runSetup']>>;

/**
 * Read the frozen Attempt instruction through the Runtime's authenticated bus.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param executionAttemptId - Authority-created Attempt identity.
 * @param runtimeGeneration - Registered Runtime generation fence.
 * @param signal - Optional caller cancellation signal for this read-only request.
 * @returns The immutable instruction bound to the Attempt.
 */
async function getInstruction(
  bus: IMakaioBus,
  executionAttemptId: string,
  runtimeGeneration: number,
  signal: AbortSignal | undefined,
): Promise<ExecutionAttemptInstruction> {
  const response = ExecutionAttemptSchemas['instruction.get'].response.parse(
    await bus.request(ExecutionAttemptSubjects.instruction.get, { executionAttemptId, runtimeGeneration }, { signal }),
  );
  if (response.decision === 'found') return response.instruction;
  throw new Error(`Attempt instruction read refused: ${response.refusalReason}`);
}

/**
 * Ask the Attempt Authority to admit one fixed local operation.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param options - Fenced Attempt identity and optional cancellation.
 * @param operationKind - Fixed operation requested by this Runtime.
 * @param admissionKey - Replay-stable key for the operation admission.
 * @returns The Authority-created admitted operation identity.
 */
async function admitOperation(
  bus: IMakaioBus,
  options: RunWorkloadInvocationOptions,
  operationKind: 'workspace-preparation' | 'workload-invocation',
  admissionKey: string,
): Promise<string> {
  const { executionAttemptId, runtimeGeneration } = options;
  // Admission can durably occupy the Attempt before its RPC receipt returns.
  // Never abort this replay-safe request: recover its receipt, then correlate
  // any cancellation with the admitted operation instead of starting new work.
  const response = ExecutionAttemptSchemas['operation.admit'].response.parse(
    await requestAuthorityWithRetry(
      async (timeout) =>
        await bus.request(
          ExecutionAttemptSubjects.operation.admit,
          { executionAttemptId, runtimeGeneration, operationKind, admissionKey },
          { timeout },
        ),
      { retry: options.retry, reconnect: options.reconnect },
    ),
  );
  if (response.decision === 'refused' || response.operationId === undefined) {
    throw new Error(`Attempt ${operationKind} admission refused: ${response.refusalReason ?? 'missing-operation-id'}`);
  }
  return response.operationId;
}

/**
 * Convert an unknown local failure to bounded non-secret diagnostics.
 * @param error - Local exception or rejected value.
 * @returns Bounded diagnostic text safe for the technical outcome.
 */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 8_192) || 'Local execution failed without a diagnostic message';
}

/**
 * Select exactly the installed adapter named by the frozen instruction.
 * @param adapters - Runtime-local installed adapters.
 * @param instruction - Frozen owner assignment.
 * @returns The matching installed adapter, if any.
 */
function findAdapter(
  adapters: readonly InstalledWorkloadAdapter[],
  instruction: ExecutionAttemptInstruction,
): InstalledWorkloadAdapter | undefined {
  return adapters.find(
    (adapter) => adapter.kind === instruction.workload.kind && adapter.version === instruction.workload.version,
  );
}

/**
 * Build a no-op control binding when an adapter has no workload-local control subject.
 * @param signal - Outer Runtime cancellation signal, if supplied.
 * @returns Binding that forwards the outer signal and needs no cleanup.
 */
function unboundControl(signal: AbortSignal | undefined): WorkloadControlBinding {
  return { signal: signal ?? new AbortController().signal, release: () => {} };
}

/**
 * Return whether an exception represents cancellation of the supplied signal.
 * @param error - Exception raised by the local operation.
 * @param signal - Cancellation signal supplied to the operation.
 * @returns Whether the exception represents cooperative cancellation.
 */
function isCooperativeCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  // Bus wrappers retain provenance; the local DOM convention must not accept a foreign cause.
  if (error instanceof BusAbortError) return isRequestCancellation(error, signal);
  // Custom reasons thrown by throwIfAborted retain their identity. An aborted
  // signal alone must not hide an unrelated invocation or shutdown failure.
  return (
    signal?.aborted === true &&
    (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'))
  );
}

/**
 * Submit a terminal result, then release scratch only after its Authority acknowledgement.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param options - Fenced Attempt and retry inputs.
 * @param instruction - Frozen preservation requirements, if the read completed.
 * @param outcome - Terminal technical failure or workload result.
 * @param operationId - Correlated admitted operation when one exists.
 * @param workspace - Locally retained Workspace handle, if preparation ran.
 * @returns Acknowledged terminal result.
 */
async function acknowledgeOutcome(
  bus: IMakaioBus,
  options: RunWorkloadInvocationOptions,
  instruction: ExecutionAttemptInstruction | undefined,
  outcome: ExecutionAttemptOutcome,
  operationId: string | undefined,
  workspace: LocalWorkspaceHandle | undefined,
): Promise<WorkloadInvocationResult> {
  const decision = await submitAttemptOutcomeWithAck(
    bus,
    {
      executionAttemptId: options.executionAttemptId,
      runtimeGeneration: options.runtimeGeneration,
      ...(operationId === undefined ? {} : { operationId }),
      outcome,
    },
    { retry: options.retry, reconnect: options.reconnect },
  );
  if (
    workspace !== undefined &&
    instruction !== undefined &&
    outcome.kind === 'workload-result' &&
    instruction.preservation.required.length === 0
  ) {
    try {
      await workspace.release();
    } catch {
      // The Authority already acknowledged the canonical outcome. Cleanup is best effort.
      console.warn('[makaio-worker] Acknowledged workspace cleanup failed.');
    }
  }
  return { outcome, decision };
}

/**
 * Report successful setup using the same replay-safe delivery policy as admission.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param options - Fenced Attempt and bounded retry inputs.
 * @param operationId - Preparation operation accepted by the Authority.
 * @param handle - Local realization whose binding is being accepted.
 * @returns Accepted binding, or undefined when the Authority refuses the report.
 */
async function reportPreparedWorkspace(
  bus: IMakaioBus,
  options: RunWorkloadInvocationOptions,
  operationId: string,
  handle: LocalWorkspaceHandle,
): Promise<ExecutionAttemptWorkspaceBinding | undefined> {
  const response = ExecutionAttemptSchemas['operation.report'].response.parse(
    await requestAuthorityWithRetry(
      async (timeout) =>
        await bus.request(
          ExecutionAttemptSubjects.operation.report,
          {
            executionAttemptId: options.executionAttemptId,
            runtimeGeneration: options.runtimeGeneration,
            operationId,
            result: { kind: 'workspace-prepared', binding: handle.binding },
          },
          { timeout },
        ),
      { retry: options.retry, reconnect: options.reconnect },
    ),
  );
  return response.decision === 'refused' ? undefined : response.binding;
}

/**
 * Classify a completed local setup attempt without making any Authority call.
 * @param status - Local command completion status from the Workspace handle.
 * @returns Terminal outcome when setup cannot continue, otherwise undefined.
 */
function setupFailureOutcome(status: LocalSetupStatus): ExecutionAttemptOutcome | undefined {
  if (status.status === 'completed') return undefined;
  if (status.status === 'cancelled') return { kind: 'cancelled' };
  if (status.status === 'stop-failed') {
    return { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Workspace setup stop-failed' };
  }
  return {
    kind: 'technical-failure',
    stage: 'workspace-preparation',
    message: `Workspace setup ${status.status}`,
  };
}

/**
 * Run declared local setup and report its accepted binding to the Authority.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param options - Fenced Attempt, local root and retry inputs.
 * @param instruction - Frozen instruction declaring the Workspace requirement.
 * @param signal - Workload-local cancellation signal.
 * @returns Accepted binding and retained handle, or an acknowledged technical failure.
 */
async function prepareWorkspace(
  bus: IMakaioBus,
  options: RunWorkloadInvocationOptions,
  instruction: ExecutionAttemptInstruction,
  signal: AbortSignal,
): Promise<
  | { readonly handle: LocalWorkspaceHandle; readonly binding: ExecutionAttemptWorkspaceBinding }
  | WorkloadInvocationResult
> {
  if (signal.aborted) {
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, undefined, undefined);
  }
  const operationId = await admitOperation(
    bus,
    options,
    'workspace-preparation',
    `workspace-preparation:${instruction.id}:${options.runtimeGeneration}`,
  );
  if (signal.aborted) {
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, operationId, undefined);
  }
  let handle: LocalWorkspaceHandle | undefined;
  let setupStatus: LocalSetupStatus;
  try {
    if (options.workspaceRoot === undefined) throw new Error('Workspace preparation requires an explicit local root');
    const boundHandle = await (options.preparation ?? { prepare: bindLocalWorkspace }).prepare({
      requirement: instruction.workspace!,
      workspaceRoot: options.workspaceRoot,
    });
    handle = boundHandle;
    setupStatus = await boundHandle.runSetup({ signal, env: options.setupEnv });
  } catch (error) {
    return await acknowledgeOutcome(
      bus,
      options,
      instruction,
      isCooperativeCancellation(error, signal)
        ? { kind: 'cancelled' }
        : { kind: 'technical-failure', stage: 'workspace-preparation', message: errorMessage(error) },
      operationId,
      handle,
    );
  }
  const setupOutcome = setupFailureOutcome(setupStatus);
  if (setupOutcome !== undefined)
    return await acknowledgeOutcome(bus, options, instruction, setupOutcome, operationId, handle);
  if (signal.aborted) {
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, operationId, handle);
  }
  const binding = await reportPreparedWorkspace(bus, options, operationId, handle);
  if (binding === undefined) {
    return await acknowledgeOutcome(
      bus,
      options,
      instruction,
      {
        kind: 'technical-failure',
        stage: 'workspace-preparation',
        message: 'Workspace preparation report refused by the Authority',
      },
      operationId,
      handle,
    );
  }
  if (signal.aborted) {
    // Accepted Preparation completed its operation; cancellation now belongs
    // to the empty slot between Preparation and Invocation.
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, undefined, handle);
  }
  return { handle, binding };
}

/**
 * Run preparation and admitted workload execution once control is bound.
 * @param bus - Runtime bus authenticated as the Attempt peer.
 * @param options - Fenced Attempt, retry and local-root inputs.
 * @param instruction - Frozen assignment selected by the execution owner.
 * @param adapter - Installed local workload executor.
 * @param control - Retained workload-local cancellation binding.
 * @returns Acknowledged terminal outcome.
 */
async function runBoundWorkloadInvocation(
  bus: IMakaioBus,
  options: RunWorkloadInvocationOptions,
  instruction: ExecutionAttemptInstruction,
  adapter: InstalledWorkloadAdapter,
  control: WorkloadControlBinding,
): Promise<WorkloadInvocationResult> {
  if (control.signal.aborted) {
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, undefined, undefined);
  }
  let workspace: LocalWorkspaceHandle | undefined;
  let binding: ExecutionAttemptWorkspaceBinding | undefined;
  if (instruction.workspace !== undefined) {
    const prepared = await prepareWorkspace(bus, options, instruction, control.signal);
    if ('outcome' in prepared) return prepared;
    workspace = prepared.handle;
    binding = prepared.binding;
  }
  if (control.signal.aborted) {
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, undefined, workspace);
  }
  const operationId = await admitOperation(
    bus,
    options,
    'workload-invocation',
    `workload-invocation:${instruction.id}:${options.runtimeGeneration}`,
  );
  if (control.signal.aborted) {
    return await acknowledgeOutcome(bus, options, instruction, { kind: 'cancelled' }, operationId, workspace);
  }
  let outcome: ExecutionAttemptOutcome;
  try {
    const result = JsonValueSchema.parse(
      await adapter.invoke({
        instruction,
        ...(binding === undefined ? {} : { workspace: binding }),
        signal: control.signal,
      }),
    );
    outcome = { kind: 'workload-result', result };
  } catch (error) {
    outcome = isCooperativeCancellation(error, control.signal)
      ? { kind: 'cancelled' }
      : { kind: 'technical-failure', stage: 'workload-invocation', message: errorMessage(error) };
  }
  return await acknowledgeOutcome(bus, options, instruction, outcome, operationId, workspace);
}

/**
 * Execute the fixed generic workload sequence for an already registered Runtime.
 *
 * No Workspace is synthesized for workspace-less instructions. Source
 * acquisition remains unsupported by the local Preparation helper; workload
 * executable acquisition stays inside the admitted adapter invocation.
 * @param bus - Runtime bus authenticated as this Attempt.
 * @param options - Registered Attempt, installed adapters and optional local Workspace locator.
 * @returns The terminal outcome after canonical Authority acknowledgement.
 * @throws AuthorityRequestDeliveryError When admission or Preparation acknowledgement exceeds its delivery deadline.
 */
export async function runWorkloadInvocation(
  bus: IMakaioBus,
  options: RunWorkloadInvocationOptions,
): Promise<WorkloadInvocationResult> {
  let instruction: ExecutionAttemptInstruction;
  try {
    instruction = await getInstruction(bus, options.executionAttemptId, options.runtimeGeneration, options.signal);
  } catch (error) {
    if (isRequestCancellation(error, options.signal)) {
      return await acknowledgeOutcome(bus, options, undefined, { kind: 'cancelled' }, undefined, undefined);
    }
    throw error;
  }
  const adapter = findAdapter(options.adapters, instruction);
  if (adapter === undefined) {
    return await acknowledgeOutcome(
      bus,
      options,
      instruction,
      {
        kind: 'technical-failure',
        stage: 'startup',
        message: `Required adapter '${instruction.workload.kind}' version '${instruction.workload.version}' is unavailable`,
      },
      undefined,
      undefined,
    );
  }
  let control: WorkloadControlBinding;
  try {
    control = await (adapter.bindControl?.({ instruction, signal: options.signal }) ?? unboundControl(options.signal));
  } catch (error) {
    const outcome: ExecutionAttemptOutcome = isCooperativeCancellation(error, options.signal)
      ? { kind: 'cancelled' }
      : { kind: 'technical-failure', stage: 'startup', message: errorMessage(error) };
    return await acknowledgeOutcome(bus, options, instruction, outcome, undefined, undefined);
  }
  try {
    return await runBoundWorkloadInvocation(bus, options, instruction, adapter, control);
  } finally {
    try {
      control.release();
    } catch {
      console.warn('[makaio-worker] Workload control release failed.');
    }
  }
}
