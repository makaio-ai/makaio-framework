import type { BuiltWorkflow } from './authoring.js';

// ─────────────────────────────────────────────────────────────
// Workflow Bundle
// ─────────────────────────────────────────────────────────────

/**
 * A co-export package grouping related workflow definitions.
 *
 * Bundles are the primary unit of deployment for multi-workflow features.
 */
export interface WorkflowBundle {
  /**
   * All workflow definitions included in this bundle.
   * Each entry is a {@link BuiltWorkflow} carrying both the serializable
   * definition and the runtime handler maps.
   */
  readonly workflows: readonly BuiltWorkflow[];
}

// ─────────────────────────────────────────────────────────────
// defineWorkflowBundle
// ─────────────────────────────────────────────────────────────

/**
 * Packages one or more workflow definitions into a {@link WorkflowBundle} for
 * co-export from a workflow contribution file.
 *
 * This is a simple structural helper — it validates non-emptiness and snapshots
 * the inputs into the bundle shape. No complex logic is applied.
 * @param config - Bundle configuration with a non-empty `workflows` list.
 * @returns A {@link WorkflowBundle} ready for export and runtime registration.
 * @example
 * ```typescript
 * export const bundle = defineWorkflowBundle({
 *   workflows: [reviewWorkflow, applyFindingsWorkflow],
 * });
 * ```
 */
export function defineWorkflowBundle(config: {
  /** Non-empty list of built workflows to include in the bundle. */
  readonly workflows: readonly BuiltWorkflow[];
}): WorkflowBundle {
  if (config.workflows.length === 0) {
    throw new Error('defineWorkflowBundle: workflows must not be empty');
  }
  return {
    workflows: Object.freeze([...config.workflows]),
  };
}
