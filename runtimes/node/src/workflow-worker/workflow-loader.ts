import type { WorkflowWorkerConfig } from '@makaio/contracts';
import { loadWorkflowModule } from './workflow-file-loader.js';
import type { RuntimeLoadedWorkflow } from './types.js';

/**
 * Resolve a {@link RuntimeLoadedWorkflow} from the parsed worker config.
 *
 * Routing rules:
 * - `source.kind === 'definition'` with a populated `config.definition`:
 *   builds the {@link RuntimeLoadedWorkflow} in-place from the serialized definition.
 *   Pipeline-primitive definitions are fully serializable, so `runtimeHandlers`
 *   is always an empty Map for definition-sourced dispatch.
 * - All other source kinds delegate to the file-loader which handles `'path'`
 *   and `'source'` variants.
 * @param config - Parsed and validated worker configuration.
 * @returns The loaded workflow ready for the orchestrator.
 * @throws When `source.kind === 'definition'` but `config.definition` is absent.
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
    return {
      definition: config.definition,
      runtimeHandlers: new Map(),
    };
  }

  return loadWorkflowModule(config.source);
}
