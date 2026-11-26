import type { WorkflowRunResult } from '@makaio/contracts';
import type { ContributionProcessor, KernelHostContext } from '@makaio/kernel';
import { boundedWait } from '@makaio/utils';
import {
  runProcessWorkflowWithFixedOperations,
  type FixedProcessWorkflow,
  type FixedWorkflowRunOptions,
} from './fixed-operation-workflow.js';
import {
  FixedOperationError,
  FixedOperationRegistry,
  type FixedOperationRunResult,
} from './runtime/fixed-operations.js';
import type { FixedOperationCatalog } from './runtime/fixed-operation-registration.js';

/** Host authority for load checks and execution using the same active registrations. */
export interface FixedOperationHost {
  /** Read operation names and phases together with the snapshot for the admitted run. */
  readonly catalog: () => FixedOperationCatalog;
  /**
   * Run a workflow with its admitted contributions, or capture the active set when no snapshot is supplied.
   * @param options - Process workflow inputs.
   * @param fixed - Admitted source and operation ports.
   * @returns Execution result and extension facts for the terminal authority.
   */
  readonly run: (
    options: FixedWorkflowRunOptions,
    fixed: FixedProcessWorkflow,
  ) => Promise<FixedOperationRunResult<WorkflowRunResult>>;
}

interface FixedOperationHostComposition<TContext extends KernelHostContext> {
  readonly host: FixedOperationHost;
  readonly processor: ContributionProcessor<TContext>;
}

/**
 * Build the host port and its extension lifecycle processor together.
 * @param dependencyOrder - Coordinator's stable order of loaded extensions.
 * @param stopBudgetMs - Coordinator's stop budget for each extension.
 * @typeParam TContext - Host context used by the coordinator.
 * @returns Host port plus the processor to install before extension activation.
 */
export function createFixedOperationHost<TContext extends KernelHostContext>(
  dependencyOrder: () => readonly string[],
  stopBudgetMs: (name: string) => number,
): FixedOperationHostComposition<TContext> {
  const registry = new FixedOperationRegistry(dependencyOrder);
  const withdrawals = new Map<string, () => Promise<void>>();
  const retiring = new Set<string>();
  const host: FixedOperationHost = {
    catalog: () => registry.catalog(),
    run: (options, fixed) => runProcessWorkflowWithFixedOperations(registry, options, fixed),
  };
  const processor: ContributionProcessor<TContext> = {
    filter: (pkg) => pkg.fixedOperations !== undefined,
    processActivating(name) {
      if (retiring.has(name)) throw new FixedOperationError('generation-retirement-unconfirmed', 'registration');
    },
    async processActivated(name, pkg, context, generation) {
      if (pkg.fixedOperations === undefined) return;
      if (generation === undefined) throw new FixedOperationError('invalid-registration', 'registration');
      withdrawals.set(
        name,
        registry.activate(name, pkg.fixedOperations, generation, () => context.hasExtension(name)),
      );
    },
    async processStopped(name) {
      const withdraw = withdrawals.get(name);
      if (withdraw === undefined) return;
      withdrawals.delete(name);
      retiring.add(name);
      const drained = withdraw().finally(() => retiring.delete(name));
      if (!(await boundedWait(drained, stopBudgetMs(name))).settled) {
        console.error('[FixedOperationHost] Operation callbacks did not settle within the extension stop window.');
        throw new FixedOperationError('generation-retirement-unconfirmed', 'registration');
      }
    },
  };
  return { host: Object.freeze(host), processor };
}
