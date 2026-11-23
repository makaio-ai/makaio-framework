import { zodSchemaToJsonRecord } from '../shared/zod-json-schema.js';
import type {
  WorkflowAgentStepNode,
  WorkflowCodeStepNode,
  WorkflowGateNode,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
} from './schemas.js';
import type { CodeStepHandler, IterateHandler } from './authoring-context.js';
import type { LoopGateHandler } from './loop.js';
import { validateNoNestedLoops } from './loop.js';
import type { AgentStepOptions, GateOptions, IterateOptions, LoopOptions, NodeOptions } from './authoring-builder.js';

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
 * their gate handler functions.
 *
 * When `loop()` is called with a gate registration, the loop node object is
 * used as a key and the gate evaluate function is stored here. Builder methods
 * (`addNode()`) read this map when incorporating nodes so gate handlers are
 * automatically registered in `runtimeLoopGates` without exposing functions
 * in the serializable node shape.
 */
export const standaloneLoopGates = new WeakMap<object, LoopGateHandler>();

// ─────────────────────────────────────────────────────────────
// Standalone Handler Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Walks `node` and its descendants, extracting any handlers registered in
 * `standaloneHandlers` and writing them into `handlers`.
 *
 * When `loopGates` is provided, loop gate handlers from `standaloneLoopGates`
 * are also extracted into the map in the same recursive pass.
 * @param node - The node to inspect
 * @param handlers - The code step handler map to populate
 * @param loopGates - Optional loop gate handler map to populate
 */
export function extractStandaloneHandlers(
  node: WorkflowNode,
  handlers: Map<string, CodeStepHandler>,
  loopGates?: Map<string, LoopGateHandler>,
): void {
  const handler = standaloneHandlers.get(node);
  if (handler !== undefined) {
    handlers.set(node.id, handler);
  }
  if (node.type === 'sequence') {
    for (const child of (node as WorkflowSequenceNode).nodes) {
      extractStandaloneHandlers(child, handlers, loopGates);
    }
  } else if (node.type === 'parallel') {
    for (const branch of Object.values((node as WorkflowParallelNode).branches)) {
      extractStandaloneHandlers(branch, handlers, loopGates);
    }
  } else if (node.type === 'iterate') {
    extractStandaloneHandlers((node as WorkflowIterateNode).body, handlers, loopGates);
  } else if (node.type === 'iterate-chain') {
    extractStandaloneHandlers((node as WorkflowIterateChainNode).body, handlers, loopGates);
  } else if (node.type === 'loop') {
    if (loopGates !== undefined) {
      const gateHandler = standaloneLoopGates.get(node);
      if (gateHandler !== undefined) {
        loopGates.set((node as WorkflowLoopNode).gate.handler, gateHandler);
      }
    }
    extractStandaloneHandlers((node as WorkflowLoopNode).body, handlers, loopGates);
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
 * Creates a gate node for use as a standalone node or as a branch entry.
 * @param id - Unique gate node identifier
 * @param options - Gate configuration including prompt and timeout
 * @returns A {@link WorkflowGateNode}
 */
export function gate(id: string, options: GateOptions): WorkflowGateNode {
  return {
    id,
    type: 'gate',
    prompt: options.prompt,
    autoAction: options.autoAction,
    timeoutMs: options.timeoutMs,
    ...(options.title !== undefined && { title: options.title }),
    ...(options.resume !== undefined && {
      resumeSchema: zodSchemaToJsonRecord(options.resume),
    }),
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
 * The gate evaluate function is stored in the module-scoped
 * `standaloneLoopGates` WeakMap keyed on the returned node object. Builder
 * methods (`addNode()`) read this map when incorporating the node so the
 * gate handler is automatically registered in `runtimeLoopGates` without
 * embedding functions in the serializable node shape.
 *
 * Body node handlers registered via standalone `codeStep()` factories are
 * also collected through the existing `standaloneHandlers` mechanism.
 * @param id - Unique loop node identifier
 * @param bodyNodes - Ordered list of nodes forming the loop body
 * @param options - Loop configuration including maxRounds and gate
 * @returns A {@link WorkflowLoopNode} with no functions in the serializable definition
 */
export function loop(id: string, bodyNodes: WorkflowNode[], options: LoopOptions): WorkflowLoopNode {
  const node: WorkflowLoopNode = {
    id,
    type: 'loop',
    maxRounds: options.maxRounds,
    body: { id: `${id}__body`, type: 'sequence', nodes: bodyNodes },
    gate: buildSerializableLoopGate(options),
    ...(options.when !== undefined && { when: options.when }),
    ...(options.skip !== undefined && { skip: options.skip }),
  };
  const nestedError = validateNoNestedLoops(node);
  if (nestedError !== undefined) {
    throw new Error(nestedError);
  }
  standaloneLoopGates.set(node, options.gate.evaluate);
  return node;
}

/**
 * Builds the serializable gate descriptor from {@link LoopOptions}.
 *
 * Applies schema defaults for `escalation.autoAction` and
 * `escalation.timeoutMs` so the resulting object satisfies
 * `WorkflowLoopNode['gate']` without optional-to-required mismatches.
 * @param options - Loop options containing the gate registration
 * @returns A plain gate object suitable for the serializable node
 */
export function buildSerializableLoopGate(options: LoopOptions): WorkflowLoopNode['gate'] {
  const escalation = options.gate.escalation;
  return {
    handler: options.gate.handler,
    ...(options.gate.input !== undefined && {
      input: options.gate.input,
    }),
    ...(options.gate.config !== undefined && {
      config: options.gate.config,
    }),
    ...(escalation !== undefined && {
      escalation: {
        prompt: escalation.prompt,
        autoAction: escalation.autoAction ?? 'reject',
        timeoutMs: escalation.timeoutMs ?? null,
        ...(escalation.title !== undefined && {
          title: escalation.title,
        }),
        ...(escalation.resumeSchema !== undefined && {
          resumeSchema: escalation.resumeSchema,
        }),
      },
    }),
  };
}
