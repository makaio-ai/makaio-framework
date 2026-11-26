import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { WorkflowError, WorkflowErrorCode, type WorkflowRunResult, type WorkflowWorkerConfig } from '@makaio/contracts';
import { deepFreeze } from '@makaio/utils';
import {
  assertWorkflowPathSyntax,
  resolveWorkflowPath,
  type CheckoutWorkflowSource,
} from './checkout-workflow-reader.js';
import type { FixedStepAuthority } from './process-step-runner.js';
import { runWithProcessStepSite, type ProcessWorkflowRunOptions } from './process-workflow.js';
import type { FixedOperationAdmission } from './runtime/fixed-operation-registration.js';
import {
  FixedOperationError,
  type FixedOperationRegistry,
  type FixedOperationRun,
  type FixedOperationRunResult,
  type FixedWorkflowSource,
  type VerifiedFixedWorkflowSource,
} from './runtime/fixed-operations.js';

/** Host-admitted checkout identity and immutable revision. */
export interface FixedSourceIdentity {
  readonly checkoutId: string;
  readonly revision: string;
}

/** A frozen workflow source with the host's independent checkout verdict. */
export interface AdmittedFixedWorkflowSource extends FixedWorkflowSource, FixedSourceIdentity {
  /** Portable path relative to the prepared checkout. */
  readonly path: string;
  /**
   * Read checkout identity and revision from the prepared root using host authority.
   * @param root - Canonical prepared checkout root.
   * @param path - Canonical workflow file inside the checkout.
   * @param signal - Cancellation of the source phase.
   * @returns Observed checkout data when the source file matches the admitted checkout.
   */
  readonly verify: (root: string, path: string, signal: AbortSignal) => Promise<FixedSourceIdentity | undefined>;
}

/** Process invocation with terminal submission reserved to the authority. */
export type FixedWorkflowRunOptions = Omit<ProcessWorkflowRunOptions, 'checkout' | 'onRequestRefused'> & {
  readonly config: WorkflowWorkerConfig & { readonly terminalAuthority: 'authority' };
};

/** Run-local inputs and scoped capabilities provided by the worker host. */
export type FixedProcessWorkflow = Pick<
  FixedOperationRun,
  'blocks' | 'definitions' | 'withAddresses' | 'afterStepsSignal'
> & {
  /** Bind this run to the single-use, non-serializable snapshot issued by the same host. */
  readonly admission?: FixedOperationAdmission;
  readonly source?: AdmittedFixedWorkflowSource;
  /** Explicitly allow a frozen definition to run without a checkout. */
  readonly allowSourceFree?: true;
};

/**
 * Check whether one canonical path is at or under another.
 * @param root - Candidate ancestor directory.
 * @param path - Candidate descendant path.
 * @returns Whether the path is inside the root, including the root itself.
 */
function contains(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/**
 * Validate the source path and independently compare the prepared checkout to the admitted pin.
 * @param checkoutRoot - Canonical checkout root.
 * @param source - Immutable host admission or previously verified checkout.
 * @param verify - Host verifier bound to the admitted source.
 * @param signal - Run cancellation.
 * @returns Frozen, verified checkout and workflow file to use for execution.
 */
async function verifyPreparedSource(
  checkoutRoot: string,
  source: Omit<CheckoutWorkflowSource, 'checkoutRoot'> & FixedSourceIdentity,
  verify: AdmittedFixedWorkflowSource['verify'],
  signal: AbortSignal,
): Promise<VerifiedFixedWorkflowSource> {
  try {
    signal.throwIfAborted();
    const verifiedPath = await resolveWorkflowPath({ ...source, checkoutRoot }, true);
    signal.throwIfAborted();
    const observed = await verify(checkoutRoot, verifiedPath, signal);
    signal.throwIfAborted();
    if (observed?.checkoutId === source.checkoutId && observed?.revision === source.revision) {
      return Object.freeze({ ...source, checkoutRoot, verifiedPath });
    }
  } catch {
    // Verification diagnostics can carry local paths or checkout credentials.
  }
  if (signal.aborted) throw new FixedOperationError('operation-aborted', 'workflow-source');
  throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Prepared workflow source does not match admission');
}

/**
 * Validate the admission and snapshot its data before the runner can suspend.
 * @param input - Host input for fixed operations.
 * @returns A frozen admission, or no source for an explicitly source-free run.
 */
function snapshotSource(input: FixedProcessWorkflow): AdmittedFixedWorkflowSource | undefined {
  const { source: supplied, allowSourceFree } = input;
  if (supplied === undefined) {
    if (allowSourceFree === true) return;
    throw new FixedOperationError('missing-source', 'workflow-source');
  }
  const { extension, declaration, block, dependencies, path, verify, checkoutId, revision } = supplied;
  const source = Object.freeze({
    extension,
    declaration: deepFreeze(structuredClone(declaration)),
    block: deepFreeze(structuredClone(block)),
    dependencies: deepFreeze(structuredClone(dependencies)),
    path,
    verify,
    checkoutId,
    revision,
  });
  if (
    typeof source.verify !== 'function' ||
    typeof source.checkoutId !== 'string' ||
    !source.checkoutId ||
    typeof source.revision !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(source.revision)
  ) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Workflow source requires a verified checkout pin');
  }
  assertWorkflowPathSyntax(source.path);
  return source;
}

/**
 * Bind the first verification to directories selected by the worker before checkout.
 * @param workspace - Canonical working directory of the steps.
 * @param sourceParent - Canonical private source directory when owned by the run.
 * @param source - Frozen host admission, when present.
 * @param workflowId - Expected workflow definition.
 * @returns The verifier that admits a canonical checkout for subsequent use.
 */
function bindSourceVerifier(
  workspace: string,
  sourceParent: string | undefined,
  source: AdmittedFixedWorkflowSource | undefined,
  workflowId: string,
): FixedOperationRun['verifySource'] {
  return async (root, signal) => {
    if (source === undefined) throw new FixedOperationError('missing-source', 'workflow-source');
    const checkoutRoot = await realpath(root).catch(() => undefined);
    signal.throwIfAborted();
    if (
      checkoutRoot === undefined ||
      contains(checkoutRoot, workspace) ||
      contains(workspace, checkoutRoot) ||
      (sourceParent !== undefined && !contains(sourceParent, checkoutRoot))
    ) {
      throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Workflow source requires a separate checkout');
    }
    const { checkoutId, revision, path: workflowPath } = source;
    return verifyPreparedSource(
      checkoutRoot,
      { checkoutId, revision, workflowPath, workflowId },
      source.verify,
      signal,
    );
  };
}

/**
 * Recheck the admitted checkout before each code step can launch.
 * @param execute - Process-backed workflow runner.
 * @param verified - Checkout bound to this run, if declared.
 * @param reverifySource - Independent verifier bound at admission.
 * @param assertActive - Guard for the contributions used by this run.
 * @returns The step result or a typed rejection if the source changed.
 */
async function executeVerifiedSteps(
  execute: (source: CheckoutWorkflowSource | undefined, authority: FixedStepAuthority) => Promise<WorkflowRunResult>,
  verified: VerifiedFixedWorkflowSource | undefined,
  reverifySource: FixedOperationRun['reverifySource'],
  assertActive: () => void,
): Promise<WorkflowRunResult> {
  if (verified === undefined) return execute(undefined, { assertActive });
  const { checkoutRoot, workflowPath, workflowId, verifiedPath } = verified;
  let mismatch: WorkflowError | undefined;
  const result = await execute(
    { checkoutRoot, workflowPath, workflowId, verifiedPath },
    {
      assertActive,
      async verifySource(signal) {
        assertActive();
        try {
          await reverifySource(verified, signal);
        } catch (error) {
          if (error instanceof WorkflowError && error.code === WorkflowErrorCode.SOURCE_MISMATCH) mismatch = error;
          throw error;
        }
      },
    },
  );
  if (mismatch !== undefined) throw mismatch;
  return result;
}

/**
 * Execute fixed operations around an authority-owned workflow before terminal submission.
 * @param registry - The host's activated operation registry.
 * @param input - Worker-local execution options.
 * @param fixedInput - Admitted source and operation capabilities for the run.
 * @param ownWorkspace - Use a private workspace owned by this execution.
 * @returns The unsubmitted workflow result and facts from its fixed operations.
 */
export function runProcessWorkflowWithFixedOperations(
  registry: FixedOperationRegistry,
  input: FixedWorkflowRunOptions,
  fixedInput: FixedProcessWorkflow,
  ownWorkspace = true,
): Promise<FixedOperationRunResult<WorkflowRunResult>> {
  const { bus, call, signal, workspace, model, runModel } = input;
  let config: FixedWorkflowRunOptions['config'];
  let source: AdmittedFixedWorkflowSource | undefined;
  let run: ReturnType<FixedOperationRegistry['bindRun']>;
  try {
    config = deepFreeze(structuredClone(input.config));
    if (config?.terminalAuthority !== 'authority') {
      throw new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, 'Fixed runs require terminal authority');
    }
    source = snapshotSource(fixedInput);
    run = registry.bindRun(fixedInput.admission);
  } catch (error) {
    return Promise.reject(error);
  }
  const options = Object.freeze({
    bus,
    call,
    signal,
    workspace,
    config,
    runModel,
    model:
      model === undefined
        ? undefined
        : Object.freeze({
            ...model,
            target: Object.freeze({ ...model.target, url: new URL(model.target.url) }),
            credentialSource: Object.freeze({ request: model.credentialSource.request.bind(model.credentialSource) }),
          }),
  });
  const ports = Object.freeze({
    blocks: fixedInput.blocks,
    definitions: fixedInput.definitions,
    withAddresses: fixedInput.withAddresses,
    afterStepsSignal: fixedInput.afterStepsSignal,
  });
  const blocks = deepFreeze(structuredClone(ports.blocks));
  return runWithProcessStepSite(
    options,
    async ({ launcher, definition, execute, home, workspace }) => {
      const sourceDirectory = join(home, 'source');
      await mkdir(sourceDirectory);
      const canonicalWorkspace = await realpath(workspace);
      const sourceParent = ownWorkspace ? await realpath(sourceDirectory) : undefined;
      const verifySource = bindSourceVerifier(canonicalWorkspace, sourceParent, source, definition.id);
      const reverifySource: FixedOperationRun['reverifySource'] = async (verified, signal) => {
        if (source === undefined) throw new FixedOperationError('missing-source', 'workflow-source');
        await verifyPreparedSource(verified.checkoutRoot, verified, source.verify, signal);
      };
      return run(
        {
          ...ports,
          blocks,
          source: source && {
            extension: source.extension,
            declaration: source.declaration,
            block: source.block,
            dependencies: source.dependencies,
          },
          sourceDirectory,
          launcher,
          definition,
          workspace,
          signal,
          verifySource,
          reverifySource,
        },
        (verified, assertActive) => executeVerifiedSteps(execute, verified, reverifySource, assertActive),
      );
    },
    ownWorkspace,
  );
}
