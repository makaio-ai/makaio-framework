import { createBusNamespace } from '@makaio/core';
import { WorkflowBlocksSchemas } from './schemas.js';

/**
 * Workflow-blocks namespace for MakaioBus.
 *
 * Defines subjects for querying and monitoring the workflow block catalog of
 * step declarations contributed by extensions. Workflow start conditions live
 * in the `automation-triggers` namespace, not here.
 * @example
 * ```typescript
 * import { WorkflowBlocksSubjects } from '@makaio/contracts';
 *
 * // List all registered step blocks
 * const { steps } = await bus.request(WorkflowBlocksSubjects.list, {});
 * ```
 */
export const WorkflowBlocksNamespace = createBusNamespace('workflow-blocks', WorkflowBlocksSchemas);

/**
 * Type-safe subjects for workflow-blocks operations.
 *
 * Provides strongly-typed request/response handlers for each
 * workflow-blocks subject.
 */
export const WorkflowBlocksSubjects = WorkflowBlocksNamespace.subjects;
