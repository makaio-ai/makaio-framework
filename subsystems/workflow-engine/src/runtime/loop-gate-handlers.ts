import {
  walkWorkflowDefinition,
  type LoopGateHandler,
  type WorkflowDefinition,
  type WorkflowLoopNode,
} from '@makaio/contracts';

/**
 * Ensure a workflow provides executable gate handlers for all loop nodes.
 * @param definition - Serializable workflow definition to inspect.
 * @param runtimeLoopGates - Runtime loop gate handlers supplied by the caller.
 */
export function assertLoopGateHandlersPresent(
  definition: WorkflowDefinition,
  runtimeLoopGates: ReadonlyMap<string, LoopGateHandler>,
): void {
  const missing = new Set<string>();
  walkWorkflowDefinition(definition.root, {
    enter(node) {
      if (node.type !== 'loop') return;
      const loopNode = node as WorkflowLoopNode;
      if (!runtimeLoopGates.has(loopNode.gate.handler)) {
        missing.add(loopNode.gate.handler);
      }
    },
  });
  if (missing.size > 0) {
    throw new Error(`Workflow '${definition.id}' is missing loop gate handler(s): ${[...missing].join(', ')}`);
  }
}
