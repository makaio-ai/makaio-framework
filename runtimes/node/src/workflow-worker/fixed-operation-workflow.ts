import type { WorkflowRunResult, WorkflowWorkerConfig } from '@makaio/contracts';
import { runWithProcessStepSite, type ProcessWorkflowRunOptions } from './process-workflow.js';
import type {
  FixedOperationRun,
  FixedOperationRunResult,
  FixedWorkflowSource,
  registerFixedOperations,
} from './runtime/fixed-operations.js';

/** Run-local extension inputs provided by the worker composition. */
type FixedProcessWorkflow = Omit<FixedOperationRun, 'definition' | 'workspace' | 'launcher' | 'signal' | 'source'> & {
  readonly registry: ReturnType<typeof registerFixedOperations>;
  /** The caller owns admission of the path and verification of the prepared checkout. */
  readonly source?: FixedWorkflowSource & { readonly path: string };
};

/**
 * Execute fixed operations around an authority-owned workflow before terminal submission.
 * @param options - Worker-local execution options for a workflow the authority will finalize.
 * @param fixed - Verified registrations, source and operation capabilities for the run.
 * @returns The unsubmitted workflow result and facts from its fixed operations.
 */
export function runProcessWorkflowWithFixedOperations(
  options: ProcessWorkflowRunOptions & { readonly config: WorkflowWorkerConfig & { terminalAuthority: 'authority' } },
  fixed: FixedProcessWorkflow,
): Promise<FixedOperationRunResult<WorkflowRunResult>> {
  return runWithProcessStepSite(options, ({ launcher, definition, execute }) =>
    fixed.registry.run(
      { ...fixed, launcher, definition, workspace: options.workspace, signal: options.signal },
      (root) => {
        const source =
          root !== undefined && fixed.source !== undefined
            ? { checkoutRoot: root, workflowPath: fixed.source.path, workflowId: definition.id }
            : undefined;
        return execute(source, 'after-fixed-operations');
      },
    ),
  );
}
