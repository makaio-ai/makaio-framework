import {
  type CompositeStepState,
  type ForEachWorkflowStep,
  type WorkflowExecution,
  type WorkflowStep,
  type WorkflowRunnerStepType,
  type WorkflowStepType,
} from '@makaio/contracts';
import { evaluateSync, type WorkflowExpressionContext } from '@makaio/expression';
import { WorkflowSubjects } from './namespace.js';
import type { ActiveExecution, ActiveRunnerStep, SchedulerNode, WorkflowSchedulerDeps } from './types.js';
import { sleep } from './executor-helpers.js';
import { expandForEachAtRuntime, buildStepContextFromSnapshot, buildChildStepMap } from './runtime-for-each.js';
import { persistStepState, persistStepStates } from './workflow-execution-persistence.js';
import {
  cancelActiveRunnerSteps,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  emitTerminatedStepEvents,
  terminalizeNonTerminalSteps,
  type FinalizerDeps,
  type TerminalizedStepIds,
} from './workflow-execution-finalizer.js';
import {
  assertChildStepIdsAvailable,
  buildLocalStepAliases,
  markFailedAncestorCompositeNodes,
  settleCompletedCompositeNodes,
} from './workflow-scheduler-state.js';
import {
  applyStepRunResult,
  persistStepSpan,
  prepareRunnerManagedStep,
  type StepExecutionOutcome,
} from './workflow-step-result.js';
import {
  runBusRequestInlineStep,
  runFunctionInlineStep,
  runGateInlineStep,
} from './workflow-scheduler-inline-steps.js';
import {
  buildInitialSchedulerGraph,
  findReadySchedulerNodes,
  insertExpandedChildNodes,
  rewireCompositeDownstreamDependencies,
} from './workflow-scheduler-graph.js';

// WorkflowScheduler

/**
 * Mutable DAG scheduler for workflow execution.
 *
 * Replaces the static topological-level approach: instead of pre-expanding
 * for-each steps before starting, the scheduler holds composite nodes in the
 * graph and expands them when all their dependencies become terminal.
 *
 * ### Scheduling loop
 * 1. Find all nodes whose `needs` are fully satisfied (terminal state).
 * 2. For composite nodes (`for-each`): expand collection at runtime, insert
 *    children into the graph, rewire downstream dependencies.
 * 3. For executable nodes (`agent | shell | gate | function | bus-request`): evaluate `if`, then run.
 * 4. When any node fails: abort in-flight nodes and fail the execution.
 * 5. Repeat until no ready nodes remain and no in-flight work is pending.
 */
export class WorkflowScheduler {
  /** Mutable DAG graph seeded from authored steps. */
  private readonly nodes = new Map<string, SchedulerNode>();
  /** Currently executing node promises keyed by step ID. */
  private readonly inFlight = new Map<string, Promise<StepExecutionOutcome & { stepId: string }>>();
  private readonly startTime = Date.now();

  /**
   * Cached base expression context (`trigger`, `steps`, `inputs`).
   * Rebuilt lazily when `baseContextDirty` is true — i.e., after any step settles.
   * The per-node `item`/`index` overlay is merged on each call to {@link getExpressionContext}.
   */
  private baseContextCache: Pick<WorkflowExpressionContext, 'trigger' | 'steps' | 'inputs'> | null = null;
  private baseContextDirty = true;

  /**
   * Stable finalizer dependency bundle derived from this scheduler's deps.
   * @returns FinalizerDeps bundling bus, activeExecutions, shellAbortControllers, activeRunnerSteps, and gateCoordinator.
   */
  private get finalizerDeps(): FinalizerDeps {
    return {
      bus: this.deps.bus,
      activeExecutions: this.deps.activeExecutions,
      shellAbortControllers: this.deps.shellAbortControllers,
      activeRunnerSteps: this.deps.activeRunnerSteps,
      cancelTimeoutMs: this.deps.config.cancelTimeoutMs,
      gateCoordinator: this.deps.gateCoordinator,
    };
  }

  public constructor(
    private readonly deps: WorkflowSchedulerDeps,
    private readonly executionId: string,
  ) {}

  /**
   * Return the expression context for a node, rebuilding the base context only when dirty.
   *
   * The base context (`trigger`, `steps`, `inputs`) is rebuilt once per scheduler tick
   * (after a step settles) and reused for all nodes dispatched in the same tick.
   * The per-node for-each `item`/`index` overlay is merged on each call (cheap Map lookup).
   * @param execution - Current workflow execution state.
   * @param nodeId - Node whose for-each context should be overlaid, if any.
   * @returns Expression context for jexl evaluation.
   */
  private getExpressionContext(execution: WorkflowExecution, nodeId: string): WorkflowExpressionContext {
    if (this.baseContextDirty || !this.baseContextCache) {
      this.baseContextCache = {
        trigger: execution.triggerPayload ?? {},
        steps: Object.fromEntries(
          Object.entries(execution.steps)
            .filter(([, state]) => state.status !== 'pending')
            .map(([id, state]) => [
              id,
              {
                result: state.kind === 'executable' ? state.result : undefined,
                status: state.status,
              },
            ]),
        ),
        inputs: execution.inputs,
      };
      this.baseContextDirty = false;
    }

    const active = this.deps.activeExecutions.get(this.executionId);
    const forEachCtx = active?.stepContext.get(nodeId);
    const localStepAliases = buildLocalStepAliases(nodeId, this.baseContextCache.steps);
    const steps = { ...this.baseContextCache.steps, ...localStepAliases };
    if (forEachCtx) {
      return { ...this.baseContextCache, steps, item: forEachCtx.item, index: forEachCtx.index };
    }
    return { ...this.baseContextCache, steps };
  }

  /**
   * Run the scheduler loop until all steps are settled or the execution fails.
   * @param authoredSteps - The workflow's authored step list (including for-each nodes).
   */
  public async run(authoredSteps: WorkflowStep[]): Promise<void> {
    const active = this.deps.activeExecutions.get(this.executionId);
    if (!active) return;

    const { execution } = active;

    try {
      buildInitialSchedulerGraph(authoredSteps, this.nodes);

      while (execution.status === 'running') {
        const ready = findReadySchedulerNodes(this.nodes, execution, this.inFlight);

        if (ready.length === 0 && this.inFlight.size === 0) {
          const settledCompositeIds = await settleCompletedCompositeNodes(this.deps.bus, execution);
          if (settledCompositeIds.length > 0) {
            this.baseContextDirty = true;
            continue;
          }
          break;
        }

        for (const nodeId of ready) {
          this.dispatchNode(nodeId);
        }

        if (this.inFlight.size === 0) {
          break;
        }

        const outcome = await Promise.race(this.inFlight.values());
        this.inFlight.delete(outcome.stepId);
        this.baseContextDirty = true;

        if (execution.status !== 'running') return;

        if (outcome.status === 'failed') {
          await this.failExecution(execution, outcome.error, outcome.failedStepId);
          return;
        }

        const settledCompositeIds = await settleCompletedCompositeNodes(this.deps.bus, execution);
        if (settledCompositeIds.length > 0) this.baseContextDirty = true;

        if (this.deps.config.stepCooldownMs > 0 && outcome.status === 'completed') {
          await sleep(this.deps.config.stepCooldownMs);
        }
      }

      if (execution.status === 'running') {
        const nonTerminalSteps = Object.entries(execution.steps).filter(
          ([, state]) =>
            state.status === 'pending' ||
            state.status === 'running' ||
            state.status === 'waiting' ||
            state.status === 'expanding',
        );
        if (nonTerminalSteps.length > 0) {
          const stuckIds = nonTerminalSteps.map(([id]) => id).join(', ');
          const invariantError = `Scheduler invariant violation: steps still pending: ${stuckIds}`;
          await this.failExecution(execution, invariantError);
          return;
        }
        await completeExecutionWithSuccess(this.finalizerDeps, execution, this.executionId, this.startTime);
      }
    } catch (error) {
      if (execution.status !== 'running') return;
      const message = error instanceof Error ? error.message : String(error);
      await this.failExecution(execution, message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Node dispatch
  // ─────────────────────────────────────────────────────────────

  /**
   * Dispatch a single node for execution and register it in `inFlight`.
   * @param nodeId - Step ID to dispatch.
   */
  private dispatchNode(nodeId: string): void {
    const promise = this.runNode(nodeId)
      .then((outcome): StepExecutionOutcome & { stepId: string } => ({ ...outcome, stepId: nodeId }))
      .catch((error: unknown): StepExecutionOutcome & { stepId: string } => ({
        stepId: nodeId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        failedStepId: nodeId,
      }));
    this.inFlight.set(nodeId, promise);
  }

  /**
   * Run a single node — dispatch to composite or executable path.
   * @param nodeId - Step ID to run.
   * @returns Step execution outcome.
   */
  private async runNode(nodeId: string): Promise<StepExecutionOutcome> {
    const active = this.deps.activeExecutions.get(this.executionId);
    if (!active) return { status: 'failed', error: 'Execution no longer active', failedStepId: nodeId };

    const step = active.stepMap.get(nodeId);
    if (!step) return { status: 'failed', error: `Step not found: ${nodeId}`, failedStepId: nodeId };

    if (step.type === 'for-each') {
      return this.runCompositeNode(nodeId, step as ForEachWorkflowStep, active);
    }

    return this.runExecutableNode(nodeId, active);
  }

  // ─────────────────────────────────────────────────────────────
  // Composite (for-each) execution path
  // ─────────────────────────────────────────────────────────────

  /**
   * Expand a composite for-each node at runtime.
   *
   * Steps:
   * 1. Mark composite `expanding`.
   * 2. Evaluate `if` — skip if falsy, removing dependency from downstream.
   * 3. Evaluate collection expression.
   * 4. If collection is not array → fail composite.
   * 5. Build expansion snapshot.
   * 6. Empty collection → skip composite, unblock downstream.
   * 7. Persist child states as pending.
   * 8. Insert child nodes into graph.
   * 9. Rewire downstream dependencies from composite ID to leaf IDs.
   * 10. Keep composite `expanding` until its leaf nodes settle.
   * @param nodeId - Composite step ID.
   * @param step - For-each step definition.
   * @param active - Active execution state.
   * @returns Outcome for the composite node itself.
   */
  private async runCompositeNode(
    nodeId: string,
    step: ForEachWorkflowStep,
    active: ActiveExecution,
  ): Promise<StepExecutionOutcome> {
    const { execution } = active;
    const rawState = execution.steps[nodeId];
    if (!rawState || rawState.kind !== 'composite') {
      return { status: 'failed', error: `Unexpected state kind for composite: ${nodeId}`, failedStepId: nodeId };
    }

    // Crash-recovery boundary: persisting `expanding` lets boot recovery detect mid-expansion state.
    rawState.status = 'expanding';
    rawState.startedAt = Date.now();
    await persistStepState(this.deps.bus, execution, nodeId);
    if (execution.status !== 'running') {
      return { status: 'failed', error: 'Execution cancelled', failedStepId: nodeId };
    }

    const context = this.getExpressionContext(execution, nodeId);

    let snapshot;
    try {
      if (step.if) {
        const condResult = evaluateSync(step.if, context);
        if (!condResult) {
          return this.skipCompositeNode(nodeId, rawState, execution);
        }
      }

      snapshot = expandForEachAtRuntime(step, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rawState.status = 'failed';
      rawState.error = message;
      rawState.completedAt = Date.now();
      await persistStepState(this.deps.bus, execution, nodeId);
      return { status: 'failed', error: message, failedStepId: nodeId };
    }

    if (snapshot.childSteps.length === 0) {
      return this.skipCompositeNode(nodeId, rawState, execution);
    }

    assertChildStepIdsAvailable(snapshot.childSteps, execution, active, this.nodes);

    for (const childStep of snapshot.childSteps) {
      execution.steps[childStep.id] =
        childStep.type === 'for-each'
          ? { kind: 'composite', status: 'pending' }
          : { kind: 'executable', status: 'pending' };
    }

    rawState.expansion = snapshot;
    await persistStepStates(this.deps.bus, execution, [
      nodeId,
      ...snapshot.childSteps.map((childStep) => childStep.id),
    ]);

    const childStepMap = buildChildStepMap(snapshot);
    for (const [childId, childStep] of childStepMap) {
      active.stepMap.set(childId, childStep);
    }
    const childContext = buildStepContextFromSnapshot(snapshot);
    for (const [childId, ctx] of childContext) {
      active.stepContext.set(childId, ctx);
    }

    insertExpandedChildNodes(this.nodes, snapshot.childSteps);
    rewireCompositeDownstreamDependencies(this.nodes, nodeId, snapshot.leafStepIds);

    return { status: 'completed' };
  }

  /**
   * Skip a composite node and rewire downstream dependencies.
   *
   * Composite steps are internal scheduling constructs — no lifecycle event is
   * emitted. Only executable child steps emit `step.skipped`/`step.failed`.
   * @param nodeId - Composite step ID.
   * @param compositeState - Mutable composite state.
   * @param execution - Mutable execution state.
   * @returns Skipped outcome.
   */
  private async skipCompositeNode(
    nodeId: string,
    compositeState: CompositeStepState,
    execution: WorkflowExecution,
  ): Promise<StepExecutionOutcome> {
    compositeState.status = 'skipped';
    compositeState.completedAt = Date.now();
    await persistStepState(this.deps.bus, execution, nodeId);

    // Rewire downstream: remove composite dependency, making downstream immediately schedulable.
    rewireCompositeDownstreamDependencies(this.nodes, nodeId, []);

    return { status: 'skipped' };
  }

  // ─────────────────────────────────────────────────────────────
  // Executable node execution path
  // ─────────────────────────────────────────────────────────────

  /**
   * Run a single executable (agent / shell / gate / function / bus-request) node.
   * Evaluates the `if` condition first, then delegates to the step runner
   * (agent/shell) or handles inline steps (gate, function, bus-request) directly.
   * @param nodeId - Executable step ID.
   * @param active - Active execution state.
   * @returns Step execution outcome.
   */
  private async runExecutableNode(nodeId: string, active: ActiveExecution): Promise<StepExecutionOutcome> {
    const { execution } = active;
    const step = active.stepMap.get(nodeId);
    // `for-each` composite steps are internal scheduling nodes and are never
    // dispatched here — they are handled by `runCompositeNode`.
    if (!step || step.type === 'for-each') {
      return { status: 'failed', error: `Executable step not found: ${nodeId}`, failedStepId: nodeId };
    }

    const context = this.getExpressionContext(execution, nodeId);

    if (step.if) {
      const result = evaluateSync(step.if, context);
      if (!result) {
        const stepState = execution.steps[nodeId];
        if (stepState) {
          stepState.status = 'skipped';
          stepState.completedAt = Date.now();
        }
        await persistStepState(this.deps.bus, execution, nodeId);
        await persistStepSpan(this.deps.bus, active, nodeId, 'skipped');
        await this.deps.bus.emit(WorkflowSubjects.step.skipped, {
          executionId: this.executionId,
          stepId: nodeId,
          stepType: step.type as WorkflowStepType,
          condition: step.if,
        });
        return { status: 'skipped' };
      }
    }

    const resolvedInputs: WorkflowExpressionContext = { ...context };

    // Gate, function, and bus-request steps have specialised execution paths
    // extracted to workflow-scheduler-inline-steps.ts for clarity and to keep
    // this method within the per-function line budget.
    if (step.type === 'gate') {
      return runGateInlineStep(this.deps, this.executionId, active, nodeId, resolvedInputs);
    }
    if (step.type === 'function') {
      return runFunctionInlineStep(this.deps, this.executionId, active, nodeId, resolvedInputs);
    }
    if (step.type === 'bus-request') {
      return runBusRequestInlineStep(this.deps, this.executionId, active, nodeId, resolvedInputs);
    }

    if (!this.deps.runnerManagesLifecycle) {
      await prepareRunnerManagedStep(this.deps.bus, active, nodeId);
      if (execution.status !== 'running') {
        return { status: 'failed', error: 'Execution cancelled', failedStepId: nodeId };
      }
    }

    const controller = new AbortController();
    const key = `${this.executionId}:${nodeId}`;
    this.deps.shellAbortControllers.set(key, controller);

    // Register in activeRunnerSteps for cancellation tracking.
    const cancelSubject = `workflow.${this.executionId}.step.${nodeId}.cancel`;
    const runnerEntry: ActiveRunnerStep = { controller, cancelSubject };
    this.deps.activeRunnerSteps.set(key, runnerEntry);

    this.scheduleRunnerHardKill(controller, runnerEntry, key, nodeId);

    let result;
    try {
      result = await this.deps.runStep(
        {
          executionId: this.executionId,
          workflowId: active.workflow.id,
          stepId: nodeId,
          coordinatorSessionId: execution.coordinatorSessionId ?? this.executionId,
          stepType: step.type as WorkflowRunnerStepType,
          stepDefinition: step,
          resolvedInputs,
          busUrl: this.deps.config.busUrl,
          busAuth: this.deps.config.busAuth,
          platformDefaults: this.deps.config.platformDefaults,
          cancelSubject,
        },
        controller.signal,
      );
    } finally {
      if (runnerEntry.hardKillTimer) clearTimeout(runnerEntry.hardKillTimer);
      this.deps.activeRunnerSteps.delete(key);
      this.deps.shellAbortControllers.delete(key);
    }

    return applyStepRunResult(this.deps.bus, active, nodeId, result, resolvedInputs);
  }

  /**
   * Arm a hard-kill timer when runner cooperative cancellation starts.
   * @param controller - Step abort controller passed to the runner.
   * @param runnerEntry - Active runner tracking entry to receive the timer.
   * @param key - Active-runner map key for diagnostics.
   * @param nodeId - Step ID for runner forceKill calls.
   */
  private scheduleRunnerHardKill(
    controller: AbortController,
    runnerEntry: ActiveRunnerStep,
    key: string,
    nodeId: string,
  ): void {
    controller.signal.addEventListener('abort', () => {
      const { cancelTimeoutMs } = this.deps.config;
      if (!this.deps.forceKillStep || cancelTimeoutMs <= 0) return;
      const timer = setTimeout(() => {
        void Promise.resolve(this.deps.forceKillStep?.(this.executionId, nodeId)).catch((err) => {
          console.error(`[WorkflowScheduler] forceKill failed for ${key}:`, err);
        });
      }, cancelTimeoutMs);
      timer.unref?.();
      runnerEntry.hardKillTimer = timer;
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Fail-fast abort
  // ─────────────────────────────────────────────────────────────

  /**
   * Abort all in-flight nodes when a step fails (fail-fast semantics).
   *
   * - Shells are aborted via `shellAbortControllers`.
   * - Active runner steps are cancelled with hard kill timers via `cancelActiveRunnerSteps`.
   * - Gates are resolved for cancellation via `WorkflowGateCoordinator`.
   * - Subagents are killed via the `onAbortSubagent` callback.
   * @param reason - Human-readable abort reason.
   */
  private async abortInFlightNodes(reason: string): Promise<void> {
    const active = this.deps.activeExecutions.get(this.executionId);
    if (!active) return;

    const { execution } = active;
    const abortPromises: Promise<unknown>[] = [];

    // Cancel active runner steps (cooperative abort + hard kill timer).
    cancelActiveRunnerSteps(this.finalizerDeps, this.executionId, reason);

    for (const nodeId of this.inFlight.keys()) {
      // Abort shell process (for steps not tracked by activeRunnerSteps)
      const shellKey = `${this.executionId}:${nodeId}`;
      this.deps.shellAbortControllers.get(shellKey)?.abort();

      // Release gate waiting
      this.deps.gateCoordinator.resolveForCancellation(this.executionId, nodeId);

      // Kill subagent via the injected callback (avoids coupling to SubagentSubjects).
      const stepState = execution.steps[nodeId];
      const subagentId = stepState?.kind === 'executable' ? stepState.subagentId : undefined;
      if (subagentId && this.deps.onAbortSubagent) {
        abortPromises.push(this.deps.onAbortSubagent(nodeId, subagentId).catch(() => {}));
      }
    }

    await Promise.allSettled(abortPromises);
  }

  /**
   * Fail the execution, terminate remaining steps, persist the terminal state,
   * and emit lifecycle events.
   * @param execution - Mutable execution state.
   * @param error - Failure reason.
   * @param failedStepId - Optional originating failed step ID.
   */
  private async failExecution(execution: WorkflowExecution, error: string, failedStepId?: string): Promise<void> {
    execution.status = 'failed';
    await this.abortInFlightNodes('Workflow step failed');
    const failedCompositeIds = markFailedAncestorCompositeNodes(execution, failedStepId, error);
    const terminatedIds = this.terminalizeRemainingSteps(execution, error);
    await completeExecutionWithFailure(
      this.finalizerDeps,
      execution,
      this.executionId,
      error,
      failedStepId,
      [...failedCompositeIds, ...terminatedIds.stepIds],
      async () => {
        try {
          await emitTerminatedStepEvents(this.finalizerDeps, this.executionId, terminatedIds.executableIds);
        } catch (eventError) {
          console.error('[WorkflowScheduler] Failed to emit terminalized step events:', eventError);
        }
      },
    );
  }

  /**
   * Terminalize any remaining non-terminal steps before persisting a failed execution.
   * @param execution - Mutable execution state.
   * @param error - Failure reason applied to executable steps.
   * @returns Step ID groups terminalized by the finalizer.
   */
  private terminalizeRemainingSteps(execution: WorkflowExecution, error: string): TerminalizedStepIds {
    const active = this.deps.activeExecutions.get(this.executionId);
    if (!active) return { stepIds: [], executableIds: [] };
    return terminalizeNonTerminalSteps(execution, error, active, this.deps.gateCoordinator);
  }
}

// Re-export graph rebuild utilities for crash recovery and test use.
export { rebuildSchedulerGraph, type RebuildSchedulerGraphParams } from './workflow-scheduler-rebuild.js';
export type { SchedulerGraph } from './types.js';
