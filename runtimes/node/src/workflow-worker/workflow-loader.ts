import type { WorkflowStep, WorkflowWorkerConfig } from '@makaio/contracts';
import { loadWorkflowModule } from './workflow-file-loader.js';
import type { RuntimeLoadedWorkflow } from './types.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Find a runtime-only function step inside a definition-sourced workflow.
 *
 * Recurses into `for-each` steps to ensure nested function steps are caught.
 * @param steps - Workflow steps to scan recursively.
 * @returns First function step found, or `undefined` when the definition is
 *   fully serializable (i.e. safe for definition-sourced dispatch).
 */
export function findFunctionStep(steps: readonly WorkflowStep[]): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.type === 'function') return step;
    if (step.type === 'for-each') {
      const nested = findFunctionStep(step.steps);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Resolve a {@link RuntimeLoadedWorkflow} from the parsed worker config.
 *
 * Routing rules:
 * - `source.kind === 'definition'` with a populated `config.definition`:
 *   builds the {@link RuntimeLoadedWorkflow} in-place from the serialized definition.
 *   DB workflows use shell, agent, and gate steps exclusively; there are no
 *   function steps, so `runtimeSteps` is an empty Map.
 * - All other source kinds delegate to the file-loader which handles `'path'`
 *   and `'source'` variants.
 * @param config - Parsed and validated worker configuration.
 * @returns The loaded workflow ready for the orchestrator.
 * @throws When `source.kind === 'definition'` but `config.definition` is absent.
 * @throws When `source.kind === 'definition'` and the definition contains a
 *   function step (function steps require file/source-authored runtime functions).
 */
export async function loadWorkflowFromConfig(config: WorkflowWorkerConfig): Promise<RuntimeLoadedWorkflow> {
  if (config.source.kind === 'definition') {
    if (config.definition === undefined) {
      throw new Error(
        `Definition-sourced worker config for workflowId "${config.source.workflowId}" ` +
          `is missing the required 'definition' field. ` +
          `Ensure the executor populates WorkflowWorkerConfig.definition before dispatching.`,
      );
    }
    const functionStep = findFunctionStep(config.definition.steps);
    if (functionStep) {
      throw new Error(
        `Definition-sourced workflow "${config.definition.id}" contains function step "${functionStep.id}". ` +
          'Function steps require file/source-authored runtime functions.',
      );
    }
    return {
      definition: config.definition,
      runtimeSteps: new Map(),
    };
  }

  return loadWorkflowModule(config.source);
}
