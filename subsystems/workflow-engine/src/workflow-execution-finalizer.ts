import type { RunCancellationHook } from './workflow-runner-selector.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import {
  createStepCancelSubject,
  createWorkflowFinalizerNamespace,
  type IStepRunner,
  type WorkflowExecution,
  type WorkflowFinalizationClaim,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type { ActiveExecution, ActiveRunnerStep } from './types.js';
import { persistExecutionUpdate } from './workflow-execution-persistence.js';

/**
 * Stable dependencies shared by all finalizer functions.
 *
 * Bundles the invariant params that every finalizer function needs,
 * avoiding parameter sprawl at each call site.
 */
export interface FinalizerDeps {
  /** Bus instance used for storage and event operations. */
  bus: IMakaioBus;
  /** Active execution map used to deregister finalized executions. */
  activeExecutions: Map<string, ActiveExecution>;
  /** Shell step abort controllers keyed by `{executionId}:{stepId}`. */
  shellAbortControllers: Map<string, AbortController>;
  /** Active runner step entries keyed by `{executionId}:{stepId}` for cancellation tracking. */
  activeRunnerSteps: Map<string, ActiveRunnerStep>;
  /** Step runner instance (used for forceKill on hard cancel). */
  stepRunner?: IStepRunner;
  /** Grace period in ms before forceKill is issued after cooperative abort. */
  cancelTimeoutMs?: number;
  /** Persist owner-authorized cancellation before aborting or notifying workers. */
  recordCancellationIntent?: RunCancellationHook;
  /**
   * Best-effort fast-path delivery after an initiating cancellation commits.
   * @param call - Call context of the cancellation being delivered.
   * @param executionId - Owner whose cancellation request committed.
   * @param reason - Optional cancellation explanation.
   */
  notifyRunCancellation?(call: CallContext, executionId: string, reason?: string): Promise<void>;
  /** Registered success-finalizer subjects keyed by their stable identity. */
  successFinalizers?: ReadonlyMap<string, WorkflowSuccessFinalizer>;
  /** Execution whose finalization is being replayed by the current result submission. */
  replayingExecutionId?: string;
  /** Resolve the immutable workflow-selected success finalizer for one execution. */
  resolveSuccessFinalizerId?(executionId: string): string | undefined;
  /** Per-execution tails serializing durable lifecycle transitions. */
  durableLifecycleTransitions: Map<string, Promise<void>>;
  /** Per-execution tails preserving lifecycle event publication order. */
  lifecyclePublications: Map<string, Promise<void>>;
  /** Executions currently invoking externally extensible lifecycle handlers. */
  publishingLifecycleExecutions: Set<string>;
}

/**
 * Determine whether durable state is compatible with an accepted runner result.
 * @param durableStatus - Current durable execution status.
 * @param resultStatus - Terminal status delivered by the runner.
 * @returns Whether the result has been durably accepted.
 */
export function isAcceptedRunnerResultStatus(
  durableStatus: WorkflowExecution['status'],
  resultStatus: WorkflowRunResult['status'],
): boolean {
  return durableStatus === resultStatus || (resultStatus === 'completed' && durableStatus === 'finalizing');
}

/**
 * Serialize a lifecycle transition with other transitions for the same execution.
 * @param deps - Dependencies containing the transition registry.
 * @param executionId - Execution whose lifecycle transition is serialized.
 * @param transition - Transition to run after the prior transition settles.
 * @returns The transition result.
 */
export async function withExecutionDurableTransition<T>(
  deps: Pick<FinalizerDeps, 'durableLifecycleTransitions'>,
  executionId: string,
  transition: () => Promise<T>,
): Promise<T> {
  const previous = deps.durableLifecycleTransitions.get(executionId) ?? Promise.resolve();
  const release = Promise.withResolvers<void>();
  const tail = previous.catch(() => undefined).then(() => release.promise);
  deps.durableLifecycleTransitions.set(executionId, tail);
  await previous.catch(() => undefined);
  try {
    return await transition();
  } finally {
    release.resolve();
    if (deps.durableLifecycleTransitions.get(executionId) === tail)
      deps.durableLifecycleTransitions.delete(executionId);
  }
}

/**
 * Commit durable lifecycle state and reserve its ordered publication before
 * releasing the durable queue.
 * @param deps - Lifecycle coordination dependencies.
 * @param executionId - Execution being transitioned.
 * @param transition - Durable storage transition.
 * @param publish - Publication derived from the committed transition result.
 * @param afterCommit - Optional control effect started outside the durable queue and independent of prior publications.
 * @returns The durable transition result.
 */
export async function commitExecutionLifecycleTransition<T>(
  deps: Pick<FinalizerDeps, 'durableLifecycleTransitions' | 'lifecyclePublications' | 'publishingLifecycleExecutions'>,
  executionId: string,
  transition: () => Promise<T>,
  publish: (result: T) => Promise<void>,
  afterCommit?: (result: T) => void | Promise<void>,
): Promise<T> {
  let startPublication: (() => void) | undefined;
  let publication: Promise<void> | undefined;
  let awaitPublication = true;
  const result = await withExecutionDurableTransition(deps, executionId, async () => {
    const committed = await transition();
    const start = Promise.withResolvers<void>();
    const previous = deps.lifecyclePublications.get(executionId) ?? Promise.resolve();
    awaitPublication = !deps.publishingLifecycleExecutions.has(executionId);
    publication = previous
      .catch(() => undefined)
      .then(async () => {
        await start.promise;
        deps.publishingLifecycleExecutions.add(executionId);
        try {
          await publish(committed);
        } finally {
          deps.publishingLifecycleExecutions.delete(executionId);
        }
      });
    deps.lifecyclePublications.set(executionId, publication);
    startPublication = start.resolve;
    return committed;
  });
  if (publication !== undefined) {
    const currentPublication = publication;
    void currentPublication.then(
      () => {
        if (deps.lifecyclePublications.get(executionId) === currentPublication)
          deps.lifecyclePublications.delete(executionId);
      },
      () => {
        if (deps.lifecyclePublications.get(executionId) === currentPublication)
          deps.lifecyclePublications.delete(executionId);
      },
    );
  }
  let controlEffect: void | Promise<void>;
  try {
    controlEffect = afterCommit?.(result);
  } finally {
    // Start publication even if the effect throws. Never keep this barrier
    // closed while awaiting a control subscriber that may itself await an event.
    startPublication?.();
  }
  await controlEffect;
  if (awaitPublication && publication !== undefined) await publication;
  return result;
}

/** Runtime registration for one durable workflow success finalizer. */
export interface WorkflowSuccessFinalizer {
  /** Stable identity shared with durable finalization claims. */
  readonly finalizerId: string;
  /** Typed request subject receiving finalization claims. */
  readonly finalizeSubject: ReturnType<typeof createWorkflowFinalizerNamespace>['subjects']['finalize'];
}

/**
 * Deliver a claimed success transition to its selected finalizer.
 *
 * A transport or handler failure intentionally leaves the durable claim
 * unsettled. The owning finalizer is replayed during executor initialization.
 * @param call - Call context of the handled message the delivery serves.
 * @param deps - Finalizer dependencies.
 * @param finalizer - Registered finalizer receiving the claim.
 * @param claim - Durable transition claim to deliver.
 */
async function deliverSuccessFinalization(
  call: CallContext,
  deps: FinalizerDeps,
  finalizer: WorkflowSuccessFinalizer,
  claim: WorkflowFinalizationClaim,
): Promise<void> {
  const delivery = await deps.bus.request(call, finalizer.finalizeSubject, claim);
  if (!delivery.accepted) {
    const error = `Workflow success finalizer "${finalizer.finalizerId}" rejected transition ${claim.transitionKey}`;
    const completedAt = Date.now();
    const { failed } = await deps.bus.request(call, WorkflowStorageSubjects.failFinalization, {
      executionId: claim.executionId,
      claimToken: claim.claimToken,
      error,
      settledAt: completedAt,
    });
    if (!failed) return;
    return;
  }
}

/**
 * Recover unsettled claims for all currently registered success finalizers.
 * @param call - Context for the result being replayed, or the carrier's own context for a standalone sweep.
 * @param deps - Finalizer dependencies, including the execution ID for a result replay.
 */
export async function recoverSuccessFinalizations(call: CallContext, deps: FinalizerDeps): Promise<void> {
  const { bus, replayingExecutionId } = deps;
  // ORIGIN: A result replay can discover claims from unrelated executions.
  const recoveryCall = replayingExecutionId === undefined ? call : bus.own('shared-work');
  const callForClaim = (claim: WorkflowFinalizationClaim) =>
    claim.executionId === replayingExecutionId ? call : recoveryCall;
  for (const finalizer of deps.successFinalizers?.values() ?? []) {
    const query = { finalizerId: finalizer.finalizerId };
    const { claims } = await bus.request(recoveryCall, WorkflowStorageSubjects.listClaimedFinalizations, query);
    for (const claim of claims) {
      await deliverSuccessFinalization(callForClaim(claim), deps, finalizer, claim);
    }
    const { claims: unpublished } = await bus.request(
      recoveryCall,
      WorkflowStorageSubjects.listUnpublishedFinalizations,
      query,
    );
    for (const claim of unpublished) {
      await bus.request(callForClaim(claim), WorkflowStorageSubjects.publishFinalization, { claim });
    }
  }
}

/**
 * Finalize an execution as completed.
 * @param call - Call context of the handled message the finalization serves.
 * @param deps - Finalizer dependencies.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param startTime - Epoch ms when execution started.
 */
export async function completeExecutionWithSuccess(
  call: CallContext,
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  executionId: string,
  startTime: number,
): Promise<void> {
  const finalizerId = deps.resolveSuccessFinalizerId?.(executionId);
  const finalizer = finalizerId === undefined ? undefined : deps.successFinalizers?.get(finalizerId);
  if (finalizerId !== undefined && finalizer === undefined) {
    await completeExecutionWithFailure(
      call,
      deps,
      execution,
      executionId,
      `Workflow success finalizer "${finalizerId}" is unavailable`,
    );
    return;
  }
  if (finalizer !== undefined) {
    const completedAt = Date.now();
    const claim: WorkflowFinalizationClaim = {
      executionId,
      workflowId: execution.workflowId,
      finalizerId: finalizer.finalizerId,
      transitionKey: `${executionId}:terminal`,
      claimToken: crypto.randomUUID(),
      intent: { status: 'completed', completedAt },
      claimedAt: completedAt,
    };
    const claimed = await commitExecutionLifecycleTransition(
      deps,
      executionId,
      async () => {
        const stored = await deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
        if (stored.execution?.status !== 'running') return false;
        const result = await deps.bus.request(call, WorkflowStorageSubjects.claimFinalization, { claim });
        if (!result.claimed) return false;
        execution.status = 'finalizing';
        deps.activeExecutions.delete(executionId);
        return true;
      },
      async (committed) => {
        if (committed) await deliverSuccessFinalization(call, deps, finalizer, claim);
      },
    );
    if (!claimed) return;
    return;
  }

  const completedAt = Date.now();
  const completed = await commitExecutionLifecycleTransition(
    deps,
    executionId,
    async () => {
      const stored = await deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
      if (stored.execution?.status !== 'running') return false;
      execution.status = 'completed';
      execution.completedAt = completedAt;
      await persistExecutionUpdate(call, deps.bus, execution, { status: execution.status, completedAt });
      deps.activeExecutions.delete(executionId);
      return true;
    },
    async (committed) => {
      if (!committed) return;
      await deps.bus.emit(call, WorkflowSubjects.execution.completed, {
        executionId,
        workflowId: execution.workflowId,
        totalDuration: completedAt - startTime,
        completedAt,
      });
    },
  );
  if (!completed) return;
}

/**
 * Finalize an execution as failed.
 * @param call - Call context of the handled message the finalization serves.
 * @param deps - Finalizer dependencies.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param error - Human-readable failure reason.
 * @param beforeExecutionFailed - Optional best-effort hook that runs after
 * durable failure state is persisted but before the execution-level failure event is emitted.
 */
export async function completeExecutionWithFailure(
  call: CallContext,
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  executionId: string,
  error: string,
  beforeExecutionFailed?: () => Promise<void>,
): Promise<void> {
  const completedAt = Date.now();
  const failed = await commitExecutionLifecycleTransition(
    deps,
    executionId,
    async () => {
      const stored = await deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
      if (stored.execution?.status !== 'running') return false;
      execution.status = 'failed';
      execution.error = error;
      execution.completedAt = completedAt;
      await persistExecutionUpdate(call, deps.bus, execution, { status: execution.status, error, completedAt });
      deps.activeExecutions.delete(executionId);
      return true;
    },
    async (committed) => {
      if (!committed) return;
      try {
        await beforeExecutionFailed?.();
      } catch (hookError) {
        console.error('[WorkflowFinalizer] Failed to run failure pre-emit hook:', hookError);
      }
      await deps.bus.emit(call, WorkflowSubjects.execution.failed, {
        executionId,
        workflowId: execution.workflowId,
        error,
        completedAt,
      });
    },
  );
  if (!failed) return;
}

/**
 * Cancel all active runner steps for a given execution.
 *
 * Aborts each tracked step's AbortController, which triggers the cooperative
 * cancellation signal. It also emits the per-step cancellation bus subject so
 * remote workers can observe cancellation through their own bus connection.
 * @param call - Call context of the handled message the cancellation serves.
 * @param deps - Finalizer dependencies (requires activeRunnerSteps).
 * @param executionId - Execution identifier whose runner steps should be cancelled.
 * @param reason - Optional cancellation reason to forward to remote workers.
 */
export function cancelActiveRunnerSteps(
  call: CallContext,
  deps: FinalizerDeps,
  executionId: string,
  reason?: string,
): void {
  const { activeRunnerSteps, bus } = deps;

  const prefix = `${executionId}:`;
  for (const [key, entry] of activeRunnerSteps) {
    if (!key.startsWith(prefix)) continue;
    const stepId = key.slice(prefix.length);
    entry.controller.abort();
    void bus
      .emit(call, createStepCancelSubject(entry.cancelSubject), { executionId, stepId, reason })
      .catch((error: unknown) => {
        console.error(`[WorkflowFinalizer] Failed to emit cancellation for ${key}:`, error);
      });
  }
}

/**
 * Cancel a running workflow execution and release active resources.
 *
 * Aborts in-flight shell and runner steps, then persists the cancelled status.
 * In the primitive runtime, the abort signal drives frame-level cancellation.
 * @param call - Call context of the handled message the cancellation serves.
 * @param deps - Finalizer dependencies.
 * @param executionId - Execution identifier to cancel.
 * @param reason - Optional human-readable cancellation reason.
 * @param mode - Whether to initiate control or record an observed outcome.
 * @returns Metadata for the committed cancellation, or `undefined` if the execution was ineligible.
 */
async function cancelExecutionDurably(
  call: CallContext,
  deps: FinalizerDeps,
  executionId: string,
  reason?: string,
  mode: 'request' | 'converge' = 'converge',
): Promise<{ workflowId: string; completedAt: number } | undefined> {
  const { execution } = await deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
  if (execution?.status !== 'running') return undefined;
  // This runs inside the existing lifecycle ordering point, so a completed or
  // finalizing owner cannot acquire a new cancel intent after refusing cancel.
  if (mode === 'request') await deps.recordCancellationIntent?.(call, executionId, reason);

  // Durable ownership survives executor restart and may precede loading the
  // executable. A live registry entry is neither required nor authoritative.
  execution.status = 'cancelled';
  execution.reason = reason;
  execution.completedAt = Date.now();
  const active = deps.activeExecutions.get(executionId);
  if (active !== undefined) Object.assign(active.execution, execution);

  try {
    for (const [key, controller] of deps.shellAbortControllers) {
      if (key.startsWith(`${executionId}:`)) {
        controller.abort();
        deps.shellAbortControllers.delete(key);
      }
    }

    // Cancel active runner steps (cooperative abort).
    cancelActiveRunnerSteps(call, deps, executionId, reason);

    await persistExecutionUpdate(call, deps.bus, execution, {
      status: execution.status,
      reason,
      completedAt: execution.completedAt,
    });
  } finally {
    deps.activeExecutions.delete(executionId);
  }

  return { workflowId: execution.workflowId, completedAt: execution.completedAt };
}

/**
 * Record an observed cancellation in lifecycle order.
 * @param call - Call context of the handled message the cancellation serves.
 * @param deps - Finalizer dependencies.
 * @param executionId - Execution to cancel.
 * @param reason - Optional cancellation reason.
 * @returns Whether cancellation changed the execution state.
 */
export async function cancelExecution(
  call: CallContext,
  deps: FinalizerDeps,
  executionId: string,
  reason?: string,
): Promise<boolean> {
  return transitionCancellation(call, deps, executionId, reason, 'converge');
}

/**
 * Initiate owner cancellation, persisting provider control intent before notification.
 * Do not use this to converge an already observed worker cancellation outcome.
 * @param call - Call context of the handled message the cancellation serves.
 * @param deps - Finalizer dependencies.
 * @param executionId - Owner being cancelled by control-plane policy.
 * @param reason - Optional cancellation explanation.
 * @returns Whether the owner accepted cancellation.
 */
export async function requestExecutionCancellation(
  call: CallContext,
  deps: FinalizerDeps,
  executionId: string,
  reason?: string,
): Promise<boolean> {
  return transitionCancellation(call, deps, executionId, reason, 'request');
}

/**
 * Share lifecycle ordering without confusing a control request with its outcome.
 * @param call - Call context of the handled message the cancellation serves.
 * @param deps - Finalizer dependencies.
 * @param executionId - Owner whose cancellation is being recorded.
 * @param reason - Optional cancellation explanation.
 * @param mode - Explicit control initiation or observed outcome convergence.
 * @returns Whether the durable owner state changed.
 */
async function transitionCancellation(
  call: CallContext,
  deps: FinalizerDeps,
  executionId: string,
  reason: string | undefined,
  mode: 'request' | 'converge',
): Promise<boolean> {
  const transition = await commitExecutionLifecycleTransition(
    deps,
    executionId,
    () => cancelExecutionDurably(call, deps, executionId, reason, mode),
    async (committed) => {
      if (committed === undefined) return;
      await deps.bus.emit(call, WorkflowSubjects.execution.cancelled, {
        executionId,
        workflowId: committed.workflowId,
        reason,
        completedAt: committed.completedAt,
      });
    },
    (committed) => {
      // Deliver the committed control request independently of ordered lifecycle publication.
      if (committed !== undefined && mode === 'request') return deps.notifyRunCancellation?.(call, executionId, reason);
    },
  );
  if (transition === undefined) return false;
  return true;
}
