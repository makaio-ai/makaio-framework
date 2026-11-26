import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  walkWorkflowDefinition,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowSubjects,
  type WorkerMaterializationSpec,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { createLocalLauncher, type Launcher, type OwnerQuiescence } from '@makaio/subprocess';
import {
  assertProcessWorkflowSupported,
  runWorkflowOrchestrator,
} from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { resolveAwaitTriggerConfig } from './await-trigger.js';
import type { CheckoutWorkflowSource } from './checkout-workflow-reader.js';
import { materializeLocalDirectory } from './local-directory-materializer.js';
import { writeWorkflowSourceToTempFile } from './workflow-file-loader.js';
import {
  createProcessStepRunner,
  snapshotRunModel,
  type FixedStepAuthority,
  type ProcessStepCheckoutOptions,
  type ProcessStepRunnerOptions,
} from './process-step-runner.js';

/** Inputs exclusively owned by the worker process. */
export type ProcessWorkflowRunOptions = ProcessStepCheckoutOptions & {
  readonly call: CallContext;
  readonly bus: IMakaioBus;
  readonly config: WorkflowWorkerConfig;
  readonly signal: AbortSignal;
  readonly workspace: string;
  readonly model?: ProcessStepRunnerOptions['model'];
  readonly runModel?: ProcessStepRunnerOptions['runModel'];
};

/**
 * Locate the private step programs beside the active worker entry.
 * @returns Commands for the installed source or packaged runtime.
 */
function resolveStepCommands(): Pick<ProcessStepRunnerOptions, 'codeCommand' | 'agentCommand'> {
  const current = fileURLToPath(import.meta.url);
  const moduleDir = dirname(current);
  const suffix = extname(current);
  const codeName = `checkout-code-step-entry${suffix}`;
  const agentName = join('agent-step', `agent-step-entry${suffix}`);
  const folder = [
    moduleDir,
    join(moduleDir, 'workflow-worker'),
    join(moduleDir, 'runtime-node', 'workflow-worker'),
  ].find((path) => existsSync(join(path, codeName)) && existsSync(join(path, agentName)));
  if (folder === undefined) {
    throw new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, 'Workflow step process programs are unavailable');
  }
  const args = suffix === '.ts' ? ['--import', import.meta.resolve('tsx')] : [];
  return {
    codeCommand: { command: process.execPath, args: [...args, join(folder, codeName)] },
    agentCommand: { command: process.execPath, args: [...args, join(folder, agentName)] },
  };
}

/**
 * Revalidate an admitted task's selected path against its frozen materialization spec.
 * @param spec - Authority-owned specification preserved on the Piscina task.
 * @param workspaceRoot - Worker-local root resolved by the host for this task.
 * @param sourcePath - Worker-local source selected by the host for this task.
 */
async function verifyAdmittedSource(
  spec: Extract<WorkerMaterializationSpec, { kind: 'local-directory' }>,
  workspaceRoot: string,
  sourcePath: string,
): Promise<void> {
  try {
    const materialized = await materializeLocalDirectory(spec, [], { resolveWorkspaceRoot: async () => workspaceRoot });
    if (materialized.sourcePath === sourcePath) return;
  } catch {
    // The materializer's diagnostics can include host paths and digests.
  }
  throw new WorkflowError(
    WorkflowErrorCode.SOURCE_MISMATCH,
    'Prepared workflow source does not match its specification',
  );
}

/**
 * Select the registered module from a materialized directory or stage its frozen inline source.
 * @param config - Frozen definition and resolved source descriptor.
 * @param home - Private run directory that remains owned until process closure.
 * @param workspaceRoot - Verified root for a path source.
 * @param verifyPath - Whether to match admitted task files against the frozen specification.
 * @returns Bound reader input when the registered workflow has an executable source.
 */
async function prepareRegisteredSource(
  config: WorkflowWorkerConfig,
  home: string,
  workspaceRoot: string | undefined,
  verifyPath: boolean,
): Promise<CheckoutWorkflowSource | undefined> {
  const { definition, source } = config;
  if (definition === undefined || source.kind === 'definition') return undefined;
  let hasCodeSteps = false;
  walkWorkflowDefinition(definition.root, {
    enter(node) {
      if (node.type === 'code-step') hasCodeSteps = true;
      if (hasCodeSteps) return false;
    },
  });
  if (!hasCodeSteps) return undefined;
  const workflowId = definition.id;
  if (source.kind === 'source') {
    const { tempDir, tempPath } = await writeWorkflowSourceToTempFile(source.filename, source.source, home);
    return { checkoutRoot: tempDir, workflowPath: relative(tempDir, tempPath), workflowId };
  }
  if (source.kind === 'path' && workspaceRoot !== undefined) {
    if (verifyPath) {
      if (config.materializationSpec?.kind !== 'local-directory') return undefined;
      await verifyAdmittedSource(config.materializationSpec, workspaceRoot, source.path);
    }
    return {
      checkoutRoot: workspaceRoot,
      workflowPath: relative(workspaceRoot, source.path).split(sep).join('/'),
      workflowId,
    };
  }
  return undefined;
}

/**
 * Run a registered workflow from a local Piscina task.
 * @param options - Local worker context and verified materialized root, if present.
 * @param workspaceRoot - Verified root for a path source.
 * @param verifyPath - Whether this route must revalidate its prepared path.
 * @returns Result of the frozen workflow.
 */
export function runRegisteredProcessWorkflow(
  options: ProcessWorkflowRunOptions,
  workspaceRoot: string | undefined,
  verifyPath: boolean,
): Promise<WorkflowRunResult> {
  return runWithProcessStepSite(options, async ({ home, execute }) =>
    execute(await prepareRegisteredSource(options.config, home, workspaceRoot, verifyPath)),
  );
}

/**
 * Run a frozen workflow without loading a workflow module in the worker.
 * @param options - Workflow and launch authority supplied by the worker entry point.
 * @returns Workflow result after owned processes have stopped.
 */
export function runProcessWorkflow(options: ProcessWorkflowRunOptions): Promise<WorkflowRunResult> {
  return runWithProcessStepSite(options, ({ execute }) => execute());
}

interface StepSite {
  readonly launcher: Launcher;
  readonly home: string;
  readonly workspace: string;
  readonly definition: NonNullable<WorkflowWorkerConfig['definition']>;
  readonly execute: (source?: CheckoutWorkflowSource, fixed?: FixedStepAuthority) => Promise<WorkflowRunResult>;
}

/**
 * Own the process site and its temporary source through workflow disposal.
 * @param options - Worker-owned launch configuration.
 * @param run - Use the process site to execute the workflow.
 * @param ownWorkspace - Create and retire a private workspace for this run.
 * @returns The run's result.
 * @typeParam T - Result of the worker-local workflow invocation.
 */
export async function runWithProcessStepSite<T>(
  options: ProcessWorkflowRunOptions,
  run: (site: StepSite) => Promise<T>,
  ownWorkspace = false,
): Promise<T> {
  const { bus, config, signal, workspace } = options;
  const runModel = snapshotRunModel(options.runModel);
  const definition = config.definition;
  if (definition === undefined) {
    throw new WorkflowError(WorkflowErrorCode.SNAPSHOT_UNAVAILABLE, 'Worker requires a frozen workflow definition');
  }
  if (options.checkout !== undefined && options.onRequestRefused === undefined) {
    throw new Error('Worker checkout requires a request refusal observer');
  }
  assertProcessWorkflowSupported(definition);
  const configForTrigger = await resolveAwaitTriggerConfig(config, { definition }, bus, signal);
  const commands = resolveStepCommands();
  const home = await mkdtemp(join(ownWorkspace ? workspace : tmpdir(), 'makaio-workflow-'));
  const runWorkspace = ownWorkspace ? join(home, 'workspace') : workspace;
  const { launcher: siteLauncher } = createLocalLauncher({
    workspaceRoot: runWorkspace,
    stepHomeRoot: join(home, 'steps'),
    runtimeHomeRoot: join(home, 'runtime'),
  });
  let runtimeClosure: Extract<OwnerQuiescence, { kind: 'unproven' }> | undefined;
  const launcher: Launcher = {
    boundary: siteLauncher.boundary,
    launch: (request) => siteLauncher.launch(request),
    async closeAll() {
      const steps = await siteLauncher.closeAll();
      return runtimeClosure ?? steps;
    },
    async closeOwner(owner) {
      try {
        const evidence = await siteLauncher.closeOwner(owner);
        if (owner.kind === 'runtime' && evidence.kind === 'unproven') runtimeClosure ??= evidence;
        return evidence;
      } catch (error) {
        if (owner.kind === 'runtime') {
          runtimeClosure ??= { kind: 'unproven', boundary: siteLauncher.boundary, reason: 'observation-unavailable' };
        }
        throw error;
      }
    },
  };
  const closeSteps = async (): Promise<void> => {
    if ((await launcher.closeAll()).kind !== 'quiescent') {
      throw new Error('Worker step process closure could not be confirmed');
    }
  };
  const removeHome = (): Promise<void> => rm(home, { recursive: true, force: true });
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => (disposal ??= closeSteps().then(removeHome));
  const execute: StepSite['execute'] = (source, fixed) => {
    return executeProcessSteps(
      { ...options, runModel, workspace: runWorkspace, config: configForTrigger },
      { ...commands, launcher: guardStepLauncher(launcher, fixed?.assertActive), fixed },
      definition,
      // The fixed-operation scheduler owns closure evidence and preserves the step result.
      fixed === undefined ? dispose : undefined,
      source,
    );
  };
  try {
    if (ownWorkspace) await mkdir(runWorkspace);
    return await run({ launcher, definition, home, workspace: runWorkspace, execute });
  } finally {
    if (disposal === undefined) {
      const evidence = await launcher.closeAll();
      if (evidence.kind === 'quiescent') await removeHome();
    }
  }
}

/**
 * Recheck the fixed operation registrations at the process launch boundary.
 * @param launcher - Worker-owned process launcher.
 * @param assertActive - Admission guard for steps using contributed operations.
 * @returns The launcher for the step runner.
 */
function guardStepLauncher(launcher: Launcher, assertActive: (() => void) | undefined): Launcher {
  if (assertActive === undefined) return launcher;
  return {
    ...launcher,
    launch(request) {
      assertActive();
      return launcher.launch(request);
    },
  };
}

/**
 * Launch steps with only their workflow input and execution capabilities.
 * @param options - Frozen workflow invocation.
 * @param site - Launcher and step commands.
 * @param definition - Frozen definition.
 * @param dispose - Optional closure for runs without a separate operation scheduler.
 * @param registeredSource - Reader input for an explicitly selected source.
 * @returns The workflow's terminal result.
 */
function executeProcessSteps(
  options: ProcessWorkflowRunOptions,
  site: Pick<ProcessStepRunnerOptions, 'launcher' | 'codeCommand' | 'agentCommand' | 'fixed'>,
  definition: StepSite['definition'],
  dispose: (() => Promise<void>) | undefined,
  registeredSource?: CheckoutWorkflowSource,
): Promise<WorkflowRunResult> {
  const { call, bus, config, signal, workspace } = options;
  if (registeredSource !== undefined) signal.throwIfAborted();
  const runner = createProcessStepRunner(
    {
      ...options,
      ...site,
      timeoutMs: 300_000,
      resolveRole: async (received, role, stepSignal) => {
        const resolved = await bus.requestOptional(
          received,
          WorkflowSubjects.resolveRole,
          { roleId: role },
          { signal: stepSignal },
        );
        return resolved.handled ? resolved.data : undefined;
      },
    },
    registeredSource,
  );
  return runWorkflowOrchestrator({
    call,
    bus,
    config,
    loaded: { definition },
    signal,
    workspaceRoot: workspace,
    stepRunner: {
      ...runner,
      async run(config, signal) {
        // The run owns cancellation of a launched step. Registration retirement only invalidates its result.
        const result = await runner.run(config, signal);
        site.fixed?.assertActive();
        return result;
      },
      dispose,
    },
  });
}
