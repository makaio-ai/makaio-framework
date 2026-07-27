import type { IMakaioBus } from '@makaio/bus-core';
import { evaluateSync, type ExpressionContext } from '@makaio/expression';
import { ArtifactSubjects } from '@makaio/contracts';
import type {
  ArtifactRevision,
  ArtifactScope,
  ArtifactActor,
  WorkflowArtifactBinding,
  ArtifactBindingOptions,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowRunContext,
} from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Artifact Binding State
// ─────────────────────────────────────────────────────────────

/**
 * Mutable state for the active artifact binding of a workflow execution.
 *
 * Tracks the current revision of the workflow's primary artifact so that
 * `updateArtifact` calls can always supply the correct `previous` ref for
 * the `artifact.revise` RPC.
 */
export interface ArtifactBindingState {
  /**
   * The current artifact revision.
   *
   * Updated atomically after every successful `artifact.create` or
   * `artifact.revise` call so the next update always references the correct
   * previous revision.
   */
  current: ArtifactRevision;

  /**
   * The artifact schema version declared on the workflow binding.
   * Forwarded to every `artifact.revise` call.
   */
  readonly schemaVersion: string;

  /**
   * Optional dot-separated path to the status field within `current.data`.
   * Present only when the workflow's `.artifact()` call included `statusPath`.
   */
  readonly statusPath: string | undefined;

  /**
   * Zod schema from the workflow's `.artifact()` builder call.
   *
   * Used to validate next-data before each artifact write. `undefined` when
   * no schema was supplied (validation is skipped).
   */

  readonly zodSchema: import('zod').ZodTypeAny | undefined;
}

// ─────────────────────────────────────────────────────────────
// System actor used for workflow-originated artifact writes
// ─────────────────────────────────────────────────────────────

/**
 * Framework-level artifact actor used for all workflow-originated writes.
 *
 * Callers that need a more specific actor identity (e.g. the execution ID
 * as the actor ID) should build the actor directly rather than using this
 * constant.
 * @param executionId - The workflow execution ID to use as the actor identifier.
 * @returns An {@link ArtifactActor} representing the workflow engine.
 */
export function makeWorkflowActor(executionId: string): ArtifactActor {
  return {
    kind: 'workflow-execution',
    id: executionId,
    displayName: 'Workflow Engine',
  };
}

// ─────────────────────────────────────────────────────────────
// Artifact binding initialisation
// ─────────────────────────────────────────────────────────────

/**
 * Options for {@link resolveOrCreateArtifactBinding}.
 */
export interface ArtifactBindingResolutionOptions {
  /**
   * Authoring-time options from the workflow's `.artifact()` call.
   * Carries the `schema` Zod validator, `statusPath`, and optional `resolve`
   * / `create` jexl expressions (not evaluated by this function — left to the
   * caller to resolve before invocation).
   */
  readonly bindingOptions: ArtifactBindingOptions;
  /**
   * Serialisable binding from the `WorkflowDefinition.artifact` field.
   * Carries `kind`, `schemaVersion`, and `scope`.
   */
  readonly binding: WorkflowArtifactBinding;
  /**
   * When provided, the runtime resolves this existing artifact by `kind` + `id`
   * rather than creating a new one.
   */
  readonly existingArtifactRef?: { readonly kind: string; readonly id: string };
  /** Execution identifier for actor attribution on new artifact creations. */
  readonly executionId: string;
  /** Scope to use when creating a new artifact. Falls back to `binding.scope`. */
  readonly scope?: ArtifactScope;
  /** Initial data payload when creating a new artifact via `existingArtifactRef` absence. */
  readonly initialData?: Record<string, unknown>;
  /** Message bus for artifact service RPCs. */
  readonly bus: IMakaioBus;
}

/**
 * Options for resolving the artifact binding declared on a workflow definition.
 */
export interface WorkflowArtifactBindingResolutionOptions {
  /** Workflow definition that may declare a primary artifact binding. */
  readonly definition: WorkflowDefinition;
  /** Live execution state used for expression inputs and actor attribution. */
  readonly execution: WorkflowExecution;
  /** Durable run-context snapshot for expression context and platform fields. */
  readonly runContext: WorkflowRunContext;
  /** Optional Zod schema retained from a file-loaded workflow builder. */
  readonly zodSchema?: import('zod').ZodTypeAny;
  /** Message bus for artifact service RPCs. */
  readonly bus: IMakaioBus;
}

/**
 * Build the expression scope for workflow artifact `resolve` and `create`
 * expressions.
 * @param definition - Workflow definition declaring the artifact binding.
 * @param execution - Live workflow execution record.
 * @param runContext - Durable run-context snapshot for the execution.
 * @returns Expression context exposed to artifact binding expressions.
 */
function buildArtifactExpressionContext(
  definition: WorkflowDefinition,
  execution: WorkflowExecution,
  runContext: WorkflowRunContext,
): ExpressionContext {
  return {
    inputs: runContext.inputs,
    config: runContext.config ?? {},
    trigger: runContext.triggerPayload,
    scope: runContext.scope,
    env: runContext.env,
    execution: {
      id: execution.id,
      workflowId: execution.workflowId,
      scope: execution.scope,
    },
    workflow: {
      id: definition.id,
      name: definition.name,
      scope: definition.scope,
    },
  };
}

/**
 * Check whether an evaluated expression returned a plain object.
 * @param value - Evaluated expression result.
 * @returns Whether `value` is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize an evaluated `resolve` expression into an artifact lookup ref.
 *
 * `undefined` and `null` mean "create a new artifact"; otherwise the expression
 * must return at least `{ kind, id }`.
 * @param value - Evaluated `resolve` expression result.
 * @returns Existing artifact lookup ref, or `undefined` when a new artifact should be created.
 */
function normalizeExistingArtifactRef(value: unknown): { readonly kind: string; readonly id: string } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (isRecord(value) && typeof value['kind'] === 'string' && typeof value['id'] === 'string') {
    return { kind: value['kind'], id: value['id'] };
  }
  throw new Error('Artifact resolve expression must return an object with string kind and id fields.');
}

/**
 * Normalize an evaluated `create` expression into initial artifact data.
 *
 * `undefined` means the artifact starts with `{}`. Any provided value must be a
 * plain object because artifact revisions store JSON object data.
 * @param value - Evaluated `create` expression result.
 * @returns Initial artifact data for `artifact.create`.
 */
function normalizeInitialData(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value)) {
    return value;
  }
  throw new Error('Artifact create expression must return an object.');
}

/**
 * Resolve an existing artifact or create a new one at execution start.
 *
 * Resolution order:
 * 1. If `existingArtifactRef` is provided, query the artifact store for the
 *    latest revision of that artifact.
 * 2. Otherwise, create a new artifact via `artifact.create` with `initialData`
 *    (defaulting to an empty object when absent).
 *
 * The returned {@link ArtifactBindingState} is the authoritative in-memory
 * reference for subsequent `updateArtifact` calls during the execution.
 * @param options - Resolution options including the artifact bus and binding config.
 * @returns The initialised binding state, or `undefined` if the artifact could
 *   not be resolved (e.g. the existing ref points to a missing artifact).
 * @throws If the artifact creation RPC fails or returns an unexpected response.
 */
export async function resolveOrCreateArtifactBinding(
  options: ArtifactBindingResolutionOptions,
): Promise<ArtifactBindingState | undefined> {
  const { bindingOptions, binding, existingArtifactRef, executionId, scope, initialData, bus } = options;

  let current: ArtifactRevision | null = null;

  if (existingArtifactRef !== undefined) {
    // Attempt to resolve the latest revision of the referenced artifact.
    const queryResponse = await bus.request(ArtifactSubjects.query, {
      kind: existingArtifactRef.kind,
      ids: [existingArtifactRef.id],
      currentOnly: true,
    });

    if (queryResponse.artifacts.length > 0) {
      current = queryResponse.artifacts[0] as ArtifactRevision;
    } else {
      // Artifact ref provided but not found — return undefined to signal the
      // caller that the binding could not be established.
      return undefined;
    }
  } else {
    // Create a new artifact with the provided initial data.
    const createResponse = await bus.request(ArtifactSubjects.create, {
      kind: binding.kind,
      schemaVersion: binding.schemaVersion,
      scope: scope ?? binding.scope,
      data: initialData ?? {},
      relations: [],
      actor: makeWorkflowActor(executionId),
    });
    current = createResponse.artifact;
  }

  return {
    current,
    schemaVersion: binding.schemaVersion,
    statusPath: bindingOptions.statusPath,
    zodSchema: bindingOptions.schema,
  };
}

/**
 * Resolve the workflow-level artifact binding once before primitive runtime
 * contexts are constructed.
 *
 * Workflows without `.artifact(...)` return `undefined`. Workflows with a
 * binding evaluate the optional `resolve` and `create` expressions against the
 * run context, then delegate to {@link resolveOrCreateArtifactBinding}.
 * @param options - Workflow definition, execution, run context, schema, and bus.
 * @returns The shared artifact binding state for this execution.
 */
export async function resolveWorkflowArtifactBinding(
  options: WorkflowArtifactBindingResolutionOptions,
): Promise<ArtifactBindingState | undefined> {
  const { definition, execution, runContext, zodSchema, bus } = options;
  const binding = definition.artifact;
  if (binding === undefined) {
    return undefined;
  }

  const expressionContext = buildArtifactExpressionContext(definition, execution, runContext);
  // A caller-supplied start artifactRef is an explicit binding target. It
  // takes precedence over definition-level resolve/create expressions so
  // manual/API starts can attach work to an existing artifact deterministically.
  const existingArtifactRef =
    runContext.artifactRef ??
    (binding.resolve !== undefined
      ? normalizeExistingArtifactRef(evaluateSync(binding.resolve, expressionContext))
      : undefined);
  const initialData =
    existingArtifactRef === undefined && binding.create !== undefined
      ? normalizeInitialData(evaluateSync(binding.create, expressionContext))
      : undefined;

  const bindingState = await resolveOrCreateArtifactBinding({
    bindingOptions: {
      kind: binding.kind,
      schemaVersion: binding.schemaVersion,
      scope: binding.scope,
      ...(binding.resolve !== undefined ? { resolve: binding.resolve } : {}),
      ...(binding.create !== undefined ? { create: binding.create } : {}),
      ...(binding.statusPath !== undefined ? { statusPath: binding.statusPath } : {}),
      ...(zodSchema !== undefined ? { schema: zodSchema } : {}),
    },
    binding,
    existingArtifactRef,
    executionId: execution.id,
    scope: binding.scope,
    initialData,
    bus,
  });

  if (bindingState === undefined) {
    throw new Error('Workflow artifact binding could not be resolved for the configured artifact reference.');
  }

  return bindingState;
}
