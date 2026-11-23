import {
  walkWorkflowDefinition,
  type LoopCheckHandler,
  type WorkflowDefinition,
  type WorkflowLoopNode,
} from '@makaio/contracts';

/**
 * Ensure a workflow provides a check handler for every loop node.
 * @param definition - Workflow definition to inspect.
 * @param runtimeLoopChecks - Check handlers supplied by the caller.
 */
export function assertLoopCheckHandlersPresent(
  definition: WorkflowDefinition,
  runtimeLoopChecks: ReadonlyMap<string, LoopCheckHandler>,
): void {
  const missing = new Set<string>();
  walkWorkflowDefinition(definition.root, {
    enter(node) {
      if (node.type !== 'loop') return;
      const loopNode = node as WorkflowLoopNode;
      if (!runtimeLoopChecks.has(loopNode.check.handler)) {
        missing.add(loopNode.check.handler);
      }
    },
  });
  if (missing.size > 0) {
    throw new Error(`Workflow '${definition.id}' is missing loop check handler(s): ${[...missing].join(', ')}`);
  }
}
