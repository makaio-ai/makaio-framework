import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { createLocalLauncher, type Launcher } from '@makaio/subprocess';
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
  readonly definition: NonNullable<WorkflowWorkerConfig['definition']>;
  readonly execute: (source?: CheckoutWorkflowSource, cleanup?: 'after-fixed-operations') => Promise<WorkflowRunResult>;
}

/**
 * Own the process site and its temporary source through workflow disposal.
 * @param options - Worker-owned launch configuration.
 * @param run - Use the process site to execute the workflow.
 * @returns The run's result.
 * @typeParam T - Result of the worker-local workflow invocation.
 */
export async function runWithProcessStepSite<T>(
  options: ProcessWorkflowRunOptions,
  run: (site: StepSite) => Promise<T>,
): Promise<T> {
  const { bus, config, signal, workspace } = options;
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
  const home = await mkdtemp(join(tmpdir(), 'makaio-workflow-'));
  const { launcher: siteLauncher } = createLocalLauncher({
    workspaceRoot: workspace,
    stepHomeRoot: join(home, 'steps'),
    runtimeHomeRoot: join(home, 'runtime'),
  });
  let operationClosureUnconfirmed = false;
  const launcher: Launcher = {
    boundary: siteLauncher.boundary,
    launch: (request) => siteLauncher.launch(request),
    closeAll: () => siteLauncher.closeAll(),
    async closeOwner(owner) {
      const evidence = await siteLauncher.closeOwner(owner);
      operationClosureUnconfirmed ||= owner.kind === 'runtime' && evidence.kind === 'unproven';
      return evidence;
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
  const execute: StepSite['execute'] = (source, cleanup) =>
    executeProcessSteps(
      { ...options, config: configForTrigger },
      { ...commands, launcher },
      definition,
      cleanup === 'after-fixed-operations' ? closeSteps : dispose,
      source,
    );
  try {
    return await run({ launcher, definition, home, execute });
  } finally {
    if (disposal === undefined) {
      const evidence = await launcher.closeAll();
      if (evidence.kind === 'quiescent' && !operationClosureUnconfirmed) await removeHome();
    }
  }
}

/**
 * Launch steps with only their workflow input and execution capabilities.
 * @param options - Frozen workflow invocation.
 * @param site - Launcher and step commands.
 * @param definition - Frozen definition.
 * @param dispose - Close the step processes after execution.
 * @param registeredSource - Reader input for an explicitly selected source.
 * @returns The workflow's terminal result.
 */
function executeProcessSteps(
  options: ProcessWorkflowRunOptions,
  site: Pick<ProcessStepRunnerOptions, 'launcher' | 'codeCommand' | 'agentCommand'>,
  definition: StepSite['definition'],
  dispose: () => Promise<void>,
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
    stepRunner: { ...runner, dispose },
  });
}
