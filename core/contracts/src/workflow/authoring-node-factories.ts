import { z } from 'zod';
import type { JsonValue } from '../shared/json-value.js';
import type {
  WorkflowDelegateAgentNode,
  WorkflowDelegateRoleNode,
  WorkflowGateNode,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowNode,
  WorkflowStationNode,
} from './schemas.js';
import type { IterateHandler, StationHandler } from './authoring-context.js';
import type {
  AgentConfig,
  DelegateToRoleOptions,
  GateOptions,
  IterateOptions,
  NodeOptions,
} from './authoring-builder.js';

// ─────────────────────────────────────────────────────────────
// Shared WeakMap for standalone handler registration
// ─────────────────────────────────────────────────────────────

/**
 * Module-scoped WeakMap that associates standalone-factory nodes with their
 * handler functions.
 *
 * When `station()` or `iterate()` is called with a handler, the executable
 * station node object is used as a key and the handler is stored here. Builder
 * methods (`parallel()`, `iterateChain()`, `addNode()`) read this map when
 * incorporating nodes so handlers are automatically registered in
 * `runtimeHandlers` without exposing functions in the serializable node shape.
 */
export const standaloneHandlers = new WeakMap<object, StationHandler>();

// ─────────────────────────────────────────────────────────────
// Schema helper
// ─────────────────────────────────────────────────────────────

/**
 * Converts a Zod schema to a JSON Schema record compatible with
 * `JsonSchemaRecordSchema`.
 *
 * Uses Zod v4's built-in `z.toJSONSchema()` and strips the `$schema` key so
 * the result is a plain JSON Schema document without the meta-schema pointer.
 * @param schema - Any Zod schema to convert
 * @returns A `Record<string, JsonValue>` suitable for storage in a workflow definition
 */
export function zodSchemaToJsonRecord(schema: z.ZodTypeAny): Record<string, JsonValue> {
  const raw = z.toJSONSchema(schema) as Record<string, JsonValue>;
  const { $schema: _dropped, ...rest } = raw;
  return rest;
}

// ─────────────────────────────────────────────────────────────
// Standalone Node Factory Functions
// ─────────────────────────────────────────────────────────────

/**
 * Creates a station node for use as a branch inside a `parallel()` call or
 * an `iterateChain()` sub-chain.
 *
 * The handler is stored in the module-scoped `standaloneHandlers` WeakMap keyed
 * on the returned node object. Builder methods (`parallel()`, `iterateChain()`,
 * `addNode()`) read this map when incorporating the node so the handler is
 * automatically registered in `runtimeHandlers` without embedding functions in
 * the serializable node shape.
 * @param id - Unique station identifier
 * @param handler - Station handler function registered via {@link standaloneHandlers}
 * @param options - Optional node conditions
 * @returns A {@link WorkflowStationNode} with no function in the serializable definition
 */
export function station(id: string, handler: StationHandler, options?: NodeOptions): WorkflowStationNode {
  const node: WorkflowStationNode = {
    id,
    type: 'station',
    prompt: id,
    ...(options?.when !== undefined && { when: options.when }),
    ...(options?.skip !== undefined && { skip: options.skip }),
  };
  standaloneHandlers.set(node, handler);
  return node;
}

/**
 * Creates a delegate-agent node for use as a branch inside a `parallel()` call
 * or an `iterateChain()` sub-chain.
 * @param id - Unique node identifier
 * @param config - Agent delegation configuration
 * @param options - Optional node conditions
 * @returns A {@link WorkflowDelegateAgentNode}
 */
export function delegateToAgent(id: string, config: AgentConfig, options?: NodeOptions): WorkflowDelegateAgentNode {
  return {
    id,
    type: 'delegate-agent',
    agentId: config.agentId,
    ...(config.inputExpression !== undefined && { inputExpression: config.inputExpression }),
    ...(config.outputSchema !== undefined && { outputSchema: config.outputSchema }),
    ...(options?.when !== undefined && { when: options.when }),
    ...(options?.skip !== undefined && { skip: options.skip }),
  };
}

/**
 * Creates a delegate-role node for use as a branch inside a `parallel()` call
 * or an `iterateChain()` sub-chain.
 * @param id - Unique node identifier
 * @param role - Named product role to delegate to
 * @param options - Optional node conditions plus optional `prompt` and `completion` overrides
 * @returns A {@link WorkflowDelegateRoleNode}
 */
export function delegateToRole(id: string, role: string, options?: DelegateToRoleOptions): WorkflowDelegateRoleNode {
  return {
    id,
    type: 'delegate-role',
    role,
    prompt: options?.prompt ?? id,
    ...(options?.when !== undefined && { when: options.when }),
    ...(options?.skip !== undefined && { skip: options.skip }),
    ...(options?.completion !== undefined && { completion: options.completion }),
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
 * on the synthesized body station. Builder methods (`parallel()`,
 * `iterateChain()`, `addNode()`) read this map when incorporating the node so
 * the handler is automatically registered in `runtimeHandlers` under the
 * station ID that the runtime executes.
 * @param id - Unique iterate node identifier
 * @param handler - Station handler executed for each collection item
 * @param options - Iterate configuration including collection expression
 * @returns A {@link WorkflowIterateNode}
 */
export function iterate(id: string, handler: IterateHandler, options: IterateOptions): WorkflowIterateNode {
  const bodyStationId = `${id}__item`;
  const bodyStationNode: WorkflowStationNode = { id: bodyStationId, type: 'station', prompt: bodyStationId };
  const node: WorkflowIterateNode = {
    id,
    type: 'iterate',
    collection: options.collection,
    body: { id: `${id}__body`, type: 'sequence', nodes: [bodyStationNode] },
    ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
    ...(options.when !== undefined && { when: options.when }),
    ...(options.skip !== undefined && { skip: options.skip }),
  };
  standaloneHandlers.set(bodyStationNode, handler);
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
