import { WorkflowError, WorkflowErrorCode, type WorkflowWorkerConfig } from '@makaio/contracts';
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
 * - All other source kinds delegate to the file-loader for runtime handlers.
 *   When `config.definition` is present, that serialized definition is the
 *   execution snapshot and replaces the file-loaded definition after the source
 *   identity check.
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

  const loaded = await loadWorkflowModule(config.source);
  assertSourceWorkflowMatchesLogicalWorkflow(config, loaded);
  return config.definition === undefined ? loaded : { ...loaded, definition: config.definition };
}

/**
 * Assert that the source-loaded definition ID matches the logical workflow ID.
 *
 * Definition-sourced workers skip this check (their definition is pre-resolved).
 * RunFile executions skip this check (workflowId === executionId signals an
 * ephemeral file-backed execution where the file defines the canonical ID).
 * @param config - Worker configuration with the logical workflow identity.
 * @param loaded - The runtime-loaded workflow from the source file.
 */
function assertSourceWorkflowMatchesLogicalWorkflow(config: WorkflowWorkerConfig, loaded: RuntimeLoadedWorkflow): void {
  if (config.workflowId === config.executionId) return;
  if (loaded.definition.id === config.workflowId) return;

  throw new WorkflowError(
    WorkflowErrorCode.SOURCE_MISMATCH,
    `Source-backed workflow for logical workflow '${config.workflowId}' loaded definition '${loaded.definition.id}'.`,
  );
}
