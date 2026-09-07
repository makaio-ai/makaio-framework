import { isAbsolute, relative } from 'node:path';
import { waitForSubscriptionPropagation, type IMakaioBus } from '@makaio/bus-core';
import {
  createWorkflowCancelSubject,
  WorkerSchemas,
  WorkerSubjects,
  WorkflowRunContextSchema,
  type ExecutionAttemptWorkspaceBinding,
  type WorkerRuntimeContext,
  type WorkflowRunContext,
} from '@makaio/contracts';
import {
  parseWorkflowAttemptInstruction,
  WORKFLOW_WORKLOAD_KIND,
  WORKFLOW_WORKLOAD_VERSION,
  type WorkflowInvocationInput,
} from '@makaio/subsystem-workflow-engine';
import { resolveMakaioHome } from '../makaio-config.js';
import type {
  HeadlessWorkerBootstrapCredentials,
  HeadlessWorkflowWorkerDeps,
  HeadlessWorkflowWorkerResult,
} from './headless-workflow-worker.js';
import { createIsolatedWorkflowRuntime, type IsolatedWorkflowRuntime } from './isolated-workflow-runtime.js';
import type { InstalledWorkloadAdapter } from './workload-invocation.js';

/** Installed workflow execution plus separately acknowledged executable cleanup. */
export interface WorkflowWorkloadAdapter {
  /** Workflow implementation installed in the generic Invocation harness. */
  readonly adapter: InstalledWorkloadAdapter;
  /** Release private executable files only when the outcome permits it. */
  releaseExecutable(result?: HeadlessWorkflowWorkerResult): Promise<void>;
}

/**
 * Reconstruct the existing executor DTO without reading mutable run context.
 * @param bus - Authenticated Attempt control connection.
 * @param executionAttemptId - Attempt owning the selected Runtime inputs.
 * @param input - Frozen workflow semantics.
 * @param workflowEnv - Private host-delivered environment captured when the adapter was created.
 * @param signal - Invocation cancellation signal.
 * @returns Local executor context combining immutable semantics and selected Runtime inputs.
 */
async function readWorkflowContext(
  bus: IMakaioBus,
  executionAttemptId: string,
  input: WorkflowInvocationInput,
  workflowEnv: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<WorkflowRunContext> {
  const response = WorkerSchemas['runtime.inputs.get'].response.parse(
    await bus.request(WorkerSubjects.runtime.inputs.get, { executionAttemptId }, { signal }),
  );
  if (response.runtimeInputs === null) throw new Error('Selected Worker Runtime inputs are unavailable');
  return WorkflowRunContextSchema.parse({
    ...input,
    ...response.runtimeInputs,
    // This reconstructed local DTO has no separate snapshot timestamp. The
    // instruction revision, not this legacy required field, pins its identity.
    createdAt: 0,
    env: workflowEnv,
  });
}

/**
 * Determine whether two absolute roots share cleanup ownership.
 * @param executableRoot - Materializer-owned executable root.
 * @param workspaceRoot - Prepared project Workspace root.
 * @returns Whether either directory contains the other.
 */
function rootsOverlap(executableRoot: string, workspaceRoot: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'));
  };
  return contains(executableRoot, workspaceRoot) || contains(workspaceRoot, executableRoot);
}

/**
 * Compose adapters using project CWD when one was explicitly prepared.
 * @param deps - Installed workflow runtime dependencies.
 * @param credentials - Locally claimed connection credentials.
 * @param runtimeContext - Executable paths with the effective project CWD.
 * @param signal - Invocation cancellation signal.
 * @returns Composed and connected workflow runtime.
 */
async function composeRuntime(
  deps: HeadlessWorkflowWorkerDeps,
  credentials: HeadlessWorkerBootstrapCredentials,
  runtimeContext: WorkerRuntimeContext,
  signal: AbortSignal,
): Promise<IsolatedWorkflowRuntime> {
  const contributedPackages = await deps.loadContributions(runtimeContext, signal);
  signal.throwIfAborted();
  const makaioHome = resolveMakaioHome();
  return await createIsolatedWorkflowRuntime({
    connectAuthority: (bus) => deps.connectBus(bus, credentials, signal),
    contributedPackages: [...contributedPackages],
    configRepository: deps.configRepository,
    context: {
      cwd: runtimeContext.workspaceRoot,
      platform: runtimeContext.platform,
      homedir: makaioHome,
      makaioHome,
      username: 'workflow-worker',
      machineId: `headless-worker-${deps.executionAttemptId}`,
    },
    toolsets: [...deps.toolsets],
    ...(deps.prepareAuthRuntime !== undefined && { prepareAuthRuntime: deps.prepareAuthRuntime }),
  });
}

/**
 * Create a workflow adapter without acquiring or loading executable code yet.
 * @param deps - Installed workflow dependencies and optional project root.
 * @param credentials - Claimed connection credentials, never persisted in input.
 * @param controlBus - Registered control connection retained through final ACK.
 * @returns Installed adapter and an acknowledgement-gated file release handle.
 */
export function createWorkflowWorkloadAdapter(
  deps: HeadlessWorkflowWorkerDeps,
  credentials: HeadlessWorkerBootstrapCredentials,
  controlBus: IMakaioBus,
): WorkflowWorkloadAdapter {
  const workflowEnv = { ...deps.workflowEnv };
  let cleanup: (() => Promise<void>) | undefined;
  let preservationRequired = true;
  return {
    adapter: {
      kind: WORKFLOW_WORKLOAD_KIND,
      version: WORKFLOW_WORKLOAD_VERSION,
      async bindControl({ instruction, signal }) {
        const input = parseWorkflowAttemptInstruction(instruction);
        if (input.executionId !== deps.executionId) throw new Error('Workflow instruction execution identity mismatch');
        const cancellation = new AbortController();
        const unsubscribe = controlBus.on(createWorkflowCancelSubject(input.cancelSubject), () => cancellation.abort());
        try {
          await waitForSubscriptionPropagation(unsubscribe);
          return {
            signal: AbortSignal.any([...(signal === undefined ? [] : [signal]), cancellation.signal]),
            release: unsubscribe,
          };
        } catch (error) {
          unsubscribe();
          throw error;
        }
      },
      async invoke({ instruction, workspace, signal }) {
        const input = parseWorkflowAttemptInstruction(instruction);
        preservationRequired = instruction.preservation.required.length !== 0;
        const effectiveSignal = signal ?? new AbortController().signal;
        let runtime: IsolatedWorkflowRuntime | undefined;
        try {
          effectiveSignal.throwIfAborted();
          const context = await readWorkflowContext(
            controlBus,
            deps.executionAttemptId,
            input,
            workflowEnv,
            effectiveSignal,
          );
          const materialized = await deps.materialize(context, effectiveSignal);
          if (workspace === undefined || !rootsOverlap(materialized.context.workspaceRoot, workspace.workspaceRoot)) {
            cleanup = materialized.cleanup;
          }
          const runtimeContext = withWorkspace(materialized.context, workspace);
          effectiveSignal.throwIfAborted();
          runtime = await composeRuntime(deps, credentials, runtimeContext, effectiveSignal);
          effectiveSignal.throwIfAborted();
          return await deps.execute(runtime.bus, context, runtimeContext, effectiveSignal);
        } finally {
          // Process resources stop before the generic harness can acknowledge
          // the outcome and release the prepared project Workspace.
          // Shutdown failure must reject Invocation, even after execution returned
          // or aborted: unconfirmed shutdown cannot authorize successful file release.
          await runtime?.shutdown();
        }
      },
    },
    async releaseExecutable(result) {
      if (result === undefined || preservationRequired) return;
      // Failure or cancellation can include incomplete runtime shutdown. Their
      // ACK confirms reporting, not permission to remove potentially active files.
      if (result.outcome.kind !== 'workload-result') return;
      if (result.decision !== 'accepted' && result.decision !== 'duplicate') return;
      await cleanup?.().catch(() => undefined);
    },
  };
}

/**
 * Apply project CWD without relocating absolute executable/contribution paths.
 * @param context - Materialized executable context with absolute paths.
 * @param workspace - Optional Authority-accepted project binding.
 * @returns Local executor context with the explicit project CWD, when requested.
 */
function withWorkspace(
  context: WorkerRuntimeContext,
  workspace: ExecutionAttemptWorkspaceBinding | undefined,
): WorkerRuntimeContext {
  return workspace === undefined ? context : { ...context, workspaceRoot: workspace.workspaceRoot };
}
