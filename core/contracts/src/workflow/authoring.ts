import { z } from 'zod';
import type { JsonValue } from '../shared/json-value.js';
import type {
  WorkflowCodeStepNode,
  WorkflowDefinition,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
  WorkflowAutomationTriggerBinding,
} from './schemas.js';
import { WorkflowDefinitionSchema } from './schemas.js';
import type { CodeStepHandler, IterateHandler } from './authoring-context.js';
import { WorkflowFinalizerIdSchema } from './finalization.js';
import type {
  AgentStepOptions,
  ArtifactBindingOptions,
  DefineWorkflowOptions,
  IterateOptions,
  LoopOptions,
  ParallelOptions,
  WorkflowBuilder,
  WorkflowStateAuthoringDefinition,
  WorkflowZodSchemas,
} from './authoring-builder.js';
import type { TriggerPayloadFromTriggers, WorkflowTriggerDef } from './authoring-triggers.js';
import { agentStep as buildAgentStepNode, extractStandaloneHandlers, loop } from './authoring-node-factories.js';
import { zodSchemaToJsonRecord } from '../shared/zod-json-schema.js';

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Registers `stepId` in `registry`, throwing if already present.
 * @param registry - The set of already-claimed step IDs
 * @param stepId - Unique step identifier to claim
 */
function claimStepId(registry: Set<string>, stepId: string): void {
  if (registry.has(stepId)) {
    throw new Error(`Duplicate step ID: ${stepId}`);
  }
  registry.add(stepId);
}

/**
 * Recursively claims all node IDs found in `node` and its descendants.
 *
 * Visits `sequence.nodes`, `parallel.branches`, `iterate.body`, and
 * `iterate-chain.body` to ensure every ID in a composite node tree is unique
 * within the workflow before the root is pushed to `rootNodes`.
 * @param registry - The set of already-claimed step IDs
 * @param node - The node (and its descendants) to claim IDs for
 */
function claimNodeIds(registry: Set<string>, node: WorkflowNode): void {
  claimStepId(registry, node.id);
  if (node.type === 'sequence') {
    for (const child of (node as WorkflowSequenceNode).nodes) {
      claimNodeIds(registry, child);
    }
  } else if (node.type === 'parallel') {
    for (const branch of Object.values((node as WorkflowParallelNode).branches)) {
      claimNodeIds(registry, branch);
    }
  } else if (node.type === 'iterate') {
    claimNodeIds(registry, (node as WorkflowIterateNode).body);
  } else if (node.type === 'iterate-chain') {
    claimNodeIds(registry, (node as WorkflowIterateChainNode).body);
  } else if (node.type === 'loop') {
    claimNodeIds(registry, (node as WorkflowLoopNode).body);
  }
}

// ─────────────────────────────────────────────────────────────
// Builder method helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build the branch map for a `parallel` node, claiming IDs and extracting
 * handlers for each branch node.
 * @param nodeId - Parent parallel node ID (used to prefix sequence IDs).
 * @param branches - Array of branch nodes.
 * @param registeredIds - Set of already-claimed step IDs.
 * @param runtimeHandlers - Handler map to populate.
 * @returns Record of branch key → sequence node.
 */
function buildParallelBranchMap(
  nodeId: string,
  branches: WorkflowNode[],
  registeredIds: Set<string>,
  runtimeHandlers: Map<string, CodeStepHandler>,
): Record<string, WorkflowSequenceNode> {
  const branchMap: Record<string, WorkflowSequenceNode> = {};
  branches.forEach((branchNode, index) => {
    if (branchNode.id.length === 0) {
      throw new Error(`parallel branch at index ${index} has an empty ID`);
    }
    const branchKey = branchNode.id;
    const branchSequenceId = `${nodeId}__${branchKey}`;
    claimNodeIds(registeredIds, branchNode);
    claimStepId(registeredIds, branchSequenceId);
    extractStandaloneHandlers(branchNode, runtimeHandlers);
    branchMap[branchKey] = { id: branchSequenceId, type: 'sequence', nodes: [branchNode] };
  });
  return branchMap;
}

/**
 * Build an `iterate` node, registering the body code step ID and its handler.
 * @param nodeId - Iterate node ID.
 * @param handler - Handler for each iteration item.
 * @param iterateOptions - Iterate node options.
 * @param registeredIds - Set of already-claimed step IDs.
 * @param runtimeHandlers - Handler map to populate.
 * @returns The constructed {@link WorkflowIterateNode}.
 */
function buildIterateNode(
  nodeId: string,
  handler: IterateHandler,
  iterateOptions: IterateOptions,
  registeredIds: Set<string>,
  runtimeHandlers: Map<string, CodeStepHandler>,
): WorkflowIterateNode {
  const bodySequenceId = `${nodeId}__body`;
  const bodyStepId = `${nodeId}__item`;
  claimStepId(registeredIds, bodySequenceId);
  claimStepId(registeredIds, bodyStepId);
  runtimeHandlers.set(bodyStepId, handler);
  const bodyStepNode: WorkflowCodeStepNode = { id: bodyStepId, type: 'code-step' };
  return {
    id: nodeId,
    type: 'iterate',
    collection: iterateOptions.collection,
    body: { id: bodySequenceId, type: 'sequence', nodes: [bodyStepNode] },
    ...(iterateOptions.concurrency !== undefined && { concurrency: iterateOptions.concurrency }),
    ...(iterateOptions.when !== undefined && { when: iterateOptions.when }),
    ...(iterateOptions.skip !== undefined && { skip: iterateOptions.skip }),
  };
}

/**
 * Build an `iterate-chain` node, registering IDs and extracting handlers for
 * each chain node.
 * @param nodeId - Iterate-chain node ID.
 * @param chain - Ordered chain of nodes.
 * @param iterateOptions - Iterate node options.
 * @param registeredIds - Set of already-claimed step IDs.
 * @param runtimeHandlers - Handler map to populate.
 * @returns The constructed {@link WorkflowIterateChainNode}.
 */
function buildIterateChainNode(
  nodeId: string,
  chain: WorkflowNode[],
  iterateOptions: IterateOptions,
  registeredIds: Set<string>,
  runtimeHandlers: Map<string, CodeStepHandler>,
): WorkflowIterateChainNode {
  const bodySequenceId = `${nodeId}__body`;
  claimStepId(registeredIds, bodySequenceId);
  for (const chainNode of chain) {
    claimNodeIds(registeredIds, chainNode);
    extractStandaloneHandlers(chainNode, runtimeHandlers);
  }
  return {
    id: nodeId,
    type: 'iterate-chain',
    collection: iterateOptions.collection,
    body: { id: bodySequenceId, type: 'sequence', nodes: chain },
    ...(iterateOptions.when !== undefined && { when: iterateOptions.when }),
    ...(iterateOptions.skip !== undefined && { skip: iterateOptions.skip }),
  };
}

/**
 * Build and validate a loop and collect its body handlers.
 * @param nodeId - Loop node ID.
 * @param bodyNodes - Ordered list of body nodes.
 * @param loopOptions - Loop configuration options.
 * @param registeredIds - Set of already-claimed step IDs.
 * @param runtimeHandlers - Code step handler map to populate.
 * @returns The constructed {@link WorkflowLoopNode}.
 */
function buildLoopNode(
  nodeId: string,
  bodyNodes: WorkflowNode[],
  loopOptions: LoopOptions,
  registeredIds: Set<string>,
  runtimeHandlers: Map<string, CodeStepHandler>,
): WorkflowLoopNode {
  const loopNode = loop(nodeId, bodyNodes, loopOptions);
  claimNodeIds(registeredIds, loopNode.body);
  extractStandaloneHandlers(loopNode.body, runtimeHandlers);
  return loopNode;
}

// ─────────────────────────────────────────────────────────────
// Shared mutable builder state
// ─────────────────────────────────────────────────────────────

/**
 * Mutable state shared across all builder method implementations.
 *
 * Bundled into a single object so helper functions can accept and mutate it
 * without requiring many individual parameters.
 */
interface BuilderState {
  readonly rootNodes: WorkflowNode[];
  readonly runtimeHandlers: Map<string, CodeStepHandler>;
  readonly runtimeFactories: ReadonlyMap<string, () => WorkflowNode[]>;
  readonly registeredIds: Set<string>;
  readonly zodSchemas: {
    input?: z.ZodTypeAny;
    config?: z.ZodTypeAny;
    output?: z.ZodTypeAny;
    artifact?: z.ZodTypeAny;
  };
  readonly definition: WorkflowDefinition;
  readonly triggers: WorkflowAutomationTriggerBinding[];
}

/**
 * Builder shape before fluent methods are attached.
 *
 * The fluent method helpers assign these omitted methods immediately after the
 * seed object is created; keeping the seed typed avoids asserting through
 * `unknown` while still making the staged construction explicit.
 * @typeParam TTriggerPayload - The trigger payload union type.
 * @typeParam TState - The workflow run-state type carried by the builder.
 */
type WorkflowBuilderSeed<TTriggerPayload, TState extends JsonValue | undefined> = Omit<
  WorkflowBuilder<TTriggerPayload, TState>,
  | 'input'
  | 'config'
  | 'output'
  | 'artifact'
  | 'state'
  | 'codeStep'
  | 'agentStep'
  | 'parallel'
  | 'iterate'
  | 'iterateChain'
  | 'loop'
  | 'addNode'
>;

/**
 * Attach schema-related builder methods (`input`, `config`, `output`, `artifact`)
 * to the builder object using the provided shared state.
 *
 * Returns `void` — the builder methods are assigned directly onto `builder`.
 * @param builder - Builder object to annotate.
 * @param state - Shared mutable state.
 * @typeParam TTriggerPayload - The trigger payload union type.
 * @typeParam TState - The workflow run-state type carried by the builder.
 */
function attachSchemaBuilderMethods<TTriggerPayload, TState extends JsonValue | undefined>(
  builder: WorkflowBuilder<TTriggerPayload, TState>,
  state: BuilderState,
): void {
  builder.input = (schema: z.ZodTypeAny) => {
    state.zodSchemas.input = schema;
    state.definition.inputSchema = zodSchemaToJsonRecord(schema);
    return builder;
  };
  builder.config = (schema: z.ZodTypeAny) => {
    state.zodSchemas.config = schema;
    state.definition.configSchema = zodSchemaToJsonRecord(schema);
    return builder;
  };
  builder.output = (schema: z.ZodTypeAny) => {
    state.zodSchemas.output = schema;
    state.definition.outputSchema = zodSchemaToJsonRecord(schema);
    return builder;
  };
  builder.artifact = (opts: ArtifactBindingOptions) => {
    if (opts.schema !== undefined) state.zodSchemas.artifact = opts.schema;
    state.definition.artifact = {
      kind: opts.kind,
      schemaVersion: opts.schemaVersion,
      scope: opts.scope,
      ...(opts.resolve !== undefined && { resolve: opts.resolve }),
      ...(opts.create !== undefined && { create: opts.create }),
      ...(opts.statusPath !== undefined && { statusPath: opts.statusPath }),
    };
    return builder;
  };
  builder.state = <TNextState extends JsonValue>(stateDefinition: WorkflowStateAuthoringDefinition<TNextState>) => {
    state.definition.state = {
      schema: stateDefinition.schema,
      ...(stateDefinition.initial !== undefined && { initial: stateDefinition.initial }),
    };
    return createWorkflowBuilder<TTriggerPayload, TNextState>(state);
  };
}

/**
 * Attach node-building builder methods (`codeStep`, `agentStep`, etc.)
 * to the builder object using the provided shared state.
 * @param builder - Builder object to annotate.
 * @param state - Shared mutable state.
 * @typeParam TTriggerPayload - The trigger payload union type.
 * @typeParam TState - The workflow run-state type carried by the builder.
 */
function attachNodeBuilderMethods<TTriggerPayload, TState extends JsonValue | undefined>(
  builder: WorkflowBuilder<TTriggerPayload, TState>,
  state: BuilderState,
): void {
  const { rootNodes, runtimeHandlers, registeredIds } = state;
  builder.codeStep = (nodeId, handler, nodeOptions) => {
    claimStepId(registeredIds, nodeId);
    rootNodes.push({
      id: nodeId,
      type: 'code-step',
      ...(nodeOptions?.when !== undefined && { when: nodeOptions.when }),
      ...(nodeOptions?.skip !== undefined && { skip: nodeOptions.skip }),
    } as WorkflowCodeStepNode);
    runtimeHandlers.set(nodeId, handler);
    return builder;
  };
  builder.agentStep = (nodeId: string, role: string, nodeOptions?: AgentStepOptions) => {
    claimStepId(registeredIds, nodeId);
    rootNodes.push(buildAgentStepNode(nodeId, role, nodeOptions));
    return builder;
  };
  builder.parallel = (nodeId: string, nodeOptions: ParallelOptions, branches: WorkflowNode[]) => {
    claimStepId(registeredIds, nodeId);
    rootNodes.push({
      id: nodeId,
      type: 'parallel',
      mode: nodeOptions.mode ?? 'all-settled',
      branches: buildParallelBranchMap(nodeId, branches, registeredIds, runtimeHandlers),
      ...(nodeOptions.when !== undefined && { when: nodeOptions.when }),
      ...(nodeOptions.skip !== undefined && { skip: nodeOptions.skip }),
    } as WorkflowParallelNode);
    return builder;
  };
  builder.iterate = (nodeId, handler, iterateOptions) => (
    claimStepId(registeredIds, nodeId),
    rootNodes.push(buildIterateNode(nodeId, handler, iterateOptions, registeredIds, runtimeHandlers)),
    builder
  );
  builder.iterateChain = (nodeId: string, chain: WorkflowNode[], iterateOptions: IterateOptions) => {
    claimStepId(registeredIds, nodeId);
    rootNodes.push(buildIterateChainNode(nodeId, chain, iterateOptions, registeredIds, runtimeHandlers));
    return builder;
  };
  builder.loop = (nodeId: string, bodyNodes: WorkflowNode[], loopOptions: LoopOptions) => {
    claimStepId(registeredIds, nodeId);
    rootNodes.push(buildLoopNode(nodeId, bodyNodes, loopOptions, registeredIds, runtimeHandlers));
    return builder;
  };
  builder.addNode = (node: WorkflowNode) => addNode(node, registeredIds, runtimeHandlers, rootNodes);
}

/**
 * Claim IDs, extract handlers, and append a standalone node to the root sequence.
 * @param node - The workflow node to add.
 * @param registeredIds - Set of already-claimed step IDs.
 * @param runtimeHandlers - Handler map to populate.
 * @param rootNodes - Root node array to append to.
 */
function addNode(
  node: WorkflowNode,
  registeredIds: Set<string>,
  runtimeHandlers: Map<string, CodeStepHandler>,
  rootNodes: WorkflowNode[],
): void {
  claimNodeIds(registeredIds, node);
  extractStandaloneHandlers(node, runtimeHandlers);
  rootNodes.push(node);
}

/**
 * Create a typed fluent builder view over shared mutable authoring state.
 * @param state - Shared mutable workflow definition state.
 * @returns A builder view with the requested trigger and state type parameters.
 * @typeParam TTriggerPayload - The trigger payload union type.
 * @typeParam TState - The workflow run-state type carried by this builder view.
 */
function createWorkflowBuilder<TTriggerPayload, TState extends JsonValue | undefined>(
  state: BuilderState,
): WorkflowBuilder<TTriggerPayload, TState> {
  const builderSeed: WorkflowBuilderSeed<TTriggerPayload, TState> = {
    id: state.definition.id,
    definition: state.definition,
    runtimeHandlers: state.runtimeHandlers,
    runtimeFactories: state.runtimeFactories,
    source: undefined,
    get zodSchemas(): WorkflowZodSchemas {
      return state.zodSchemas as WorkflowZodSchemas;
    },
    addTrigger<TPayload>(trigger: WorkflowTriggerDef<TPayload>): WorkflowBuilder<TTriggerPayload | TPayload, TState> {
      state.triggers.push(trigger);
      return createWorkflowBuilder<TTriggerPayload | TPayload, TState>(state);
    },
  };
  const builder = builderSeed as WorkflowBuilder<TTriggerPayload, TState>;

  attachSchemaBuilderMethods(builder, state);
  attachNodeBuilderMethods(builder, state);
  return builder;
}

// ─────────────────────────────────────────────────────────────
// defineWorkflow
// ─────────────────────────────────────────────────────────────

/**
 * Creates a typed workflow builder for pipeline-based workflow definitions.
 *
 * The builder collects code steps, triggers, Zod schemas, and node primitives in
 * a type-safe manner. The resulting `definition` is serializable for storage
 * and UI. The process that loads the authored workflow resolves its handlers
 * from `runtimeHandlers`.
 *
 * All fluent methods (`.input()`, `.codeStep()`, `.loop()`, etc.) mutate the
 * builder's internal state and return `this` so chains compose naturally.
 * The builder also satisfies {@link BuiltWorkflow} so it can be passed to
 * {@link defineWorkflowBundle} directly.
 * @param id - Unique workflow definition identifier
 * @param options - Optional initial workflow metadata (name, description, triggers, successFinalizerId, extensions)
 * @returns A {@link WorkflowBuilder} instance
 * @example
 * ```typescript
 * const workflow = defineWorkflow('review')
 *   .input(ReviewInputSchema)
 *   .config(ReviewConfigSchema)
 *   .codeStep('analyze', analyzeHandler)
 *   .loop('refine', [codeStep('refineDraft', refineHandler)], {
 *     maxRounds: 3,
 *     check: 'refineDraft',
 *   });
 * ```
 */
export function defineWorkflow<const TTriggers extends readonly WorkflowTriggerDef<unknown>[] | undefined = undefined>(
  id: string,
  options?: DefineWorkflowOptions<TTriggers>,
): WorkflowBuilder<TriggerPayloadFromTriggers<TTriggers>, undefined> {
  const rootNodes: WorkflowNode[] = [];
  const runtimeHandlers = new Map<string, CodeStepHandler>();
  const registeredIds = new Set<string>();
  const zodSchemas: BuilderState['zodSchemas'] = {};
  const runtimeFactories = new Map<string, () => WorkflowNode[]>();
  const triggers: WorkflowAutomationTriggerBinding[] = options?.triggers ? [...options.triggers] : [];
  const definition: WorkflowDefinition = {
    id,
    ...(options?.name !== undefined && { name: options.name }),
    ...(options?.description !== undefined && { description: options.description }),
    ...(options?.successFinalizerId !== undefined && {
      successFinalizerId: WorkflowFinalizerIdSchema.parse(options.successFinalizerId),
    }),
    ...(options?.extensions !== undefined && {
      extensions: WorkflowDefinitionSchema.shape.extensions.parse(options.extensions),
    }),
    root: { id: `${id}__root`, type: 'sequence', nodes: rootNodes },
    triggers,
    scope: { type: 'global' },
  };
  const state: BuilderState = {
    rootNodes,
    runtimeHandlers,
    runtimeFactories,
    registeredIds,
    zodSchemas,
    definition,
    triggers,
  };

  return createWorkflowBuilder<TriggerPayloadFromTriggers<TTriggers>, undefined>(state);
}

export {
  agentStep,
  AutomationWorkflowTrigger,
  BusEventWorkflowTrigger,
  codeStep,
  CronWorkflowTrigger,
  iterate,
  iterateChain,
  loop,
} from './authoring-exports.js';
