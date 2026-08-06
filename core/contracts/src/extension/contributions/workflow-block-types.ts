import type { WorkflowBlockCollection } from '../../workflow/blocks.js';

/**
 * Workflow block contribution — step blocks for the workflow builder.
 *
 * Unlike other contribution surfaces, blocks are purely declarative (no runtime
 * context needed), so this is a static property rather than a factory. The
 * workflow block registry processor reads `blocks` during extension activation
 * and serialises each block to JSON Schema for catalog storage.
 *
 * Use `automationTriggers` instead to contribute trigger types — trigger
 * catalog entries are derived from executable automation trigger descriptors,
 * not from declarative blocks.
 */
export interface ExtensionWorkflowBlocksContribution {
  /** Step block declarations contributed by this extension. */
  readonly blocks: WorkflowBlockCollection;
}
