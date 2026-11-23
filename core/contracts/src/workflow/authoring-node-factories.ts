import type {
  WorkflowAgentStepNode,
  WorkflowCodeStepNode,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
} from './schemas.js';
import type { CodeStepHandler, IterateHandler } from './authoring-context.js';
import type { LoopCheckHandler } from './loop.js';
import { validateNoNestedLoops } from './loop.js';
import type { AgentStepOptions, IterateOptions, LoopOptions, NodeOptions } from './authoring-builder.js';

// ─────────────────────────────────────────────────────────────
// Shared WeakMap for standalone handler registration
// ─────────────────────────────────────────────────────────────

/**
 * Module-scoped WeakMap that associates standalone-factory nodes with their
 * handler functions.
 *
 * When `codeStep()` or `iterate()` is called with a handler, the executable
 * code step node object is used as a key and the handler is stored here. Builder
 * methods (`parallel()`, `iterateChain()`, `addNode()`) read this map when
 * incorporating nodes so handlers are automatically registered in
 * `runtimeHandlers` without exposing functions in the serializable node shape.
 */
export const standaloneHandlers = new WeakMap<object, CodeStepHandler>();

/**
 * Module-scoped WeakMap that associates standalone-factory loop nodes with
 * their check handler functions.
 *
 * When `loop()` is called with a check registration, the loop node object is
 * used as a key and the check function is stored here. Builder methods
 * (`addNode()`) read this map when incorporating nodes so check handlers are
 * automatically registered in `runtimeLoopChecks` without exposing functions
 * in the serializable node shape.
 */
export const standaloneLoopChecks = new WeakMap<object, LoopCheckHandler>();

// ─────────────────────────────────────────────────────────────
// Standalone Handler Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Walks `node` and its descendants, extracting any handlers registered in
 * `standaloneHandlers` and writing them into `handlers`.
 *
 * When `loopChecks` is provided, loop check handlers from `standaloneLoopChecks`
 * are also extracted into the map in the same recursive pass.
 * @param node - The node to inspect
 * @param handlers - The code step handler map to populate
 * @param loopChecks - Optional loop check handler map to populate
 */
export function extractStandaloneHandlers(
  node: WorkflowNode,
  handlers: Map<string, CodeStepHandler>,
  loopChecks?: Map<string, LoopCheckHandler>,
): void {
  const handler = standaloneHandlers.get(node);
  if (handler !== undefined) {
    handlers.set(node.id, handler);
  }
  if (node.type === 'sequence') {
    for (const child of (node as WorkflowSequenceNode).nodes) {
      extractStandaloneHandlers(child, handlers, loopChecks);
    }
  } else if (node.type === 'parallel') {
    for (const branch of Object.values((node as WorkflowParallelNode).branches)) {
      extractStandaloneHandlers(branch, handlers, loopChecks);
    }
  } else if (node.type === 'iterate') {
    extractStandaloneHandlers((node as WorkflowIterateNode).body, handlers, loopChecks);
  } else if (node.type === 'iterate-chain') {
    extractStandaloneHandlers((node as WorkflowIterateChainNode).body, handlers, loopChecks);
  } else if (node.type === 'loop') {
    if (loopChecks !== undefined) {
      const checkHandler = standaloneLoopChecks.get(node);
      if (checkHandler !== undefined) {
        loopChecks.set((node as WorkflowLoopNode).check.handler, checkHandler);
      }
    }
    extractStandaloneHandlers((node as WorkflowLoopNode).body, handlers, loopChecks);
  }
}

// ─────────────────────────────────────────────────────────────
// Standalone Node Factory Functions
// ─────────────────────────────────────────────────────────────

/**
 * Creates a code step node for use as a branch inside a `parallel()` call or
 * an `iterateChain()` sub-chain.
 *
 * The handler is stored in the module-scoped `standaloneHandlers` WeakMap keyed
 * on the returned node object. Builder methods (`parallel()`, `iterateChain()`,
 * `addNode()`) read this map when incorporating the node so the handler is
 * automatically registered in `runtimeHandlers` without embedding functions in
 * the serializable node shape.
 * @param id - Unique code step identifier
 * @param handler - Code step handler function registered via {@link standaloneHandlers}
 * @param options - Optional node conditions
 * @returns A {@link WorkflowCodeStepNode} with no function in the serializable definition
 */
export function codeStep(id: string, handler: CodeStepHandler, options?: NodeOptions): WorkflowCodeStepNode {
  const node: WorkflowCodeStepNode = {
    id,
    type: 'code-step',
    ...(options?.when !== undefined && { when: options.when }),
    ...(options?.skip !== undefined && { skip: options.skip }),
  };
  standaloneHandlers.set(node, handler);
  return node;
}

/**
 * Creates an agent step node for use as a branch inside a `parallel()` call
 * or an `iterateChain()` sub-chain.
 * @param id - Unique node identifier
 * @param role - Named product role to delegate the agent step to
 * @param options - Optional node conditions and agent step settings; `prompt` defaults to the node ID
 * @returns A {@link WorkflowAgentStepNode}
 */
export function agentStep(id: string, role: string, options?: AgentStepOptions): WorkflowAgentStepNode {
  return {
    id,
    type: 'agent-step',
    role,
    prompt: options?.prompt ?? id,
    ...(options?.when !== undefined && { when: options.when }),
    ...(options?.skip !== undefined && { skip: options.skip }),
    ...(options?.outputSchema !== undefined && { outputSchema: options.outputSchema }),
    ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(options?.completion !== undefined && { completion: options.completion }),
    ...(options?.allowedTools !== undefined && { allowedTools: options.allowedTools }),
    ...(options?.resultFinalizerId !== undefined && { resultFinalizerId: options.resultFinalizerId }),
  };
}

/**
 * Creates an iterate node for use in an `iterateChain()` sub-chain or
 * as a raw node passed to `addNode()`.
 *
 * The handler is stored in the module-scoped `standaloneHandlers` WeakMap keyed
 * on the synthesized body code step. Builder methods (`parallel()`,
 * `iterateChain()`, `addNode()`) read this map when incorporating the node so
 * the handler is automatically registered in `runtimeHandlers` under the
 * code step ID that the runtime executes.
 * @param id - Unique iterate node identifier
 * @param handler - Code step handler executed for each collection item
 * @param options - Iterate configuration including collection expression
 * @returns A {@link WorkflowIterateNode}
 */
export function iterate(id: string, handler: IterateHandler, options: IterateOptions): WorkflowIterateNode {
  const bodyStepId = `${id}__item`;
  const bodyStepNode: WorkflowCodeStepNode = { id: bodyStepId, type: 'code-step' };
  const node: WorkflowIterateNode = {
    id,
    type: 'iterate',
    collection: options.collection,
    body: { id: `${id}__body`, type: 'sequence', nodes: [bodyStepNode] },
    ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
    ...(options.when !== undefined && { when: options.when }),
    ...(options.skip !== undefined && { skip: options.skip }),
  };
  standaloneHandlers.set(bodyStepNode, handler);
  return node;
}

/**
 * Creates an iterate-chain node with a static sub-chain body.
 * @param id - Unique iterate-chain node identifier
 * @param chain - Ordered list of nodes forming the chain body
 * @param options - Iterate configuration including collection expression
 * @returns A {@link WorkflowIterateChainNode}
 */
export function iterateChain(id: string, chain: WorkflowNode[], options: IterateOptions): WorkflowIterateChainNode {
  return {
    id,
    type: 'iterate-chain',
    collection: options.collection,
    body: { id: `${id}__body`, type: 'sequence', nodes: chain },
    ...(options.when !== undefined && { when: options.when }),
    ...(options.skip !== undefined && { skip: options.skip }),
  };
}

/**
 * Creates a loop node for use as a standalone node passed to `addNode()`.
 *
 * The check function is stored in the module-scoped
 * `standaloneLoopChecks` WeakMap keyed on the returned node object. Builder
 * methods (`addNode()`) read this map when incorporating the node so the
 * check handler is automatically registered in `runtimeLoopChecks` without
 * embedding functions in the serializable node shape.
 *
 * Body node handlers registered via standalone `codeStep()` factories are
 * also collected through the existing `standaloneHandlers` mechanism.
 * @param id - Unique loop node identifier
 * @param bodyNodes - Ordered list of nodes forming the loop body
 * @param options - Loop configuration including maxRounds and the check
 * @returns A {@link WorkflowLoopNode} with no functions in the serializable definition
 */
export function loop(id: string, bodyNodes: WorkflowNode[], options: LoopOptions): WorkflowLoopNode {
  const node: WorkflowLoopNode = {
    id,
    type: 'loop',
    maxRounds: options.maxRounds,
    ...(options.onExhausted !== undefined && { onExhausted: options.onExhausted }),
    body: { id: `${id}__body`, type: 'sequence', nodes: bodyNodes },
    check: buildSerializableLoopCheck(options),
    ...(options.when !== undefined && { when: options.when }),
    ...(options.skip !== undefined && { skip: options.skip }),
  };
  const nestedError = validateNoNestedLoops(node);
  if (nestedError !== undefined) {
    throw new Error(nestedError);
  }
  standaloneLoopChecks.set(node, options.check.evaluate);
  return node;
}

/**
 * Builds the serializable check descriptor from {@link LoopOptions}.
 * @param options - Loop options containing the check registration
 * @returns The check descriptor included in the loop definition
 */
export function buildSerializableLoopCheck(options: LoopOptions): WorkflowLoopNode['check'] {
  return {
    handler: options.check.handler,
    ...(options.check.input !== undefined && {
      input: options.check.input,
    }),
    ...(options.check.config !== undefined && {
      config: options.check.config,
    }),
  };
}
