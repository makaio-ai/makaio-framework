import {
  JsonValueSchema,
  type ForEachExpansionSnapshot,
  type ForEachWorkflowStep,
  type WorkflowStep,
} from '@makaio/contracts';
import { evaluateSync, type WorkflowExpressionContext } from '@makaio/expression';
import { findInnerLeafIds, type ForEachStepContext } from './for-each-expander.js';
import { validateAuthoredWorkflowSteps } from './dag-utils.js';

/**
 * Namespace an inner step ID relative to a for-each step iteration.
 * @param forEachId - The for-each step's ID.
 * @param index - The iteration index.
 * @param innerStepId - The inner step's original ID.
 * @returns Namespaced runtime step ID.
 */
function namespacedId(forEachId: string, index: number, innerStepId: string): string {
  return `${forEachId}.${index}.${innerStepId}`;
}

/**
 * Validate for-each namespacing invariants for authored step IDs.
 * @param innerSteps - Direct inner steps to be namespaced.
 */
function assertNamespacingSafeIds(innerSteps: WorkflowStep[]): void {
  validateAuthoredWorkflowSteps(innerSteps);
}

/**
 * Batch boundary flags for a single iteration index.
 */
interface BatchInfo {
  /** True if this index is the first item of a new batch after batch 0. */
  isFirst: boolean;
  /** True if this index is the last item in its batch. */
  isLast: boolean;
}

/**
 * Compute batch boundary information.
 * @param index - Iteration index.
 * @param batchSize - Number of items per batch.
 * @param total - Total number of items.
 * @returns Batch boundary flags.
 */
function batchInfo(index: number, batchSize: number, total: number): BatchInfo {
  const batch = Math.floor(index / batchSize);
  return {
    isFirst: batch > 0 && Math.floor((index - 1) / batchSize) < batch,
    isLast: index === total - 1 || Math.floor((index + 1) / batchSize) > batch,
  };
}

/**
 * Compute the extra `needs` edges for concurrency batching.
 * @param index - Current iteration index.
 * @param batchSize - Maximum concurrent iterations, or 0 for unlimited.
 * @param previousBatchLeafIds - Leaf IDs from the previous batch.
 * @returns Additional needs for this iteration's root steps.
 */
function concurrencyNeeds(index: number, batchSize: number, previousBatchLeafIds: string[]): string[] {
  if (batchSize === 0 || previousBatchLeafIds.length === 0) return [];
  return Math.floor(index / batchSize) > 0 ? previousBatchLeafIds : [];
}

/**
 * Clone a direct inner step with a runtime namespaced ID and rewired needs.
 * @param innerStep - Authored direct inner step.
 * @param expandedId - Runtime namespaced ID.
 * @param needs - Rewired needs.
 * @returns Runtime child step.
 */
function cloneInnerStep(innerStep: WorkflowStep, expandedId: string, needs: string[]): WorkflowStep {
  const { id: _id, needs: _needs, ...rest } = innerStep;
  return {
    ...rest,
    id: expandedId,
    ...(needs.length > 0 ? { needs } : {}),
  } as WorkflowStep;
}

/**
 * Parameters for building a for-each expansion snapshot.
 */
export interface BuildForEachExpansionSnapshotParams {
  /** The for-each step to expand. */
  parent: ForEachWorkflowStep;
  /** Pre-resolved collection items for this expansion. */
  collection: unknown[];
  /**
   * Expression context at the point of expansion.
   * Preserved for API symmetry with {@link expandForEachAtRuntime}.
   */
  expressionContext: WorkflowExpressionContext;
}

/**
 * Build a persisted expansion snapshot for a single for-each step.
 *
 * Expands the for-each step's inner `steps` array into a flat set of
 * namespaced child steps, computing:
 * - Deterministic child step IDs: `{parentId}.{index}.{innerStepId}`
 * - Per-child item/index context for expression resolution
 * - Leaf step IDs for downstream dependency rewiring
 * - Concurrency batch edges between iteration batches (when `concurrency` is set)
 *
 * The returned snapshot is pure data — no bus access or side effects.
 * It can be persisted to storage and replayed without re-evaluating the
 * collection expression.
 * @param params - Expansion parameters
 * @returns Persisted snapshot of the expanded for-each step
 */
export function buildForEachExpansionSnapshot(params: BuildForEachExpansionSnapshotParams): ForEachExpansionSnapshot {
  const { parent, collection } = params;

  if (collection.length === 0) {
    return {
      parentStepId: parent.id,
      childSteps: [],
      stepContext: {},
      leafStepIds: [],
    };
  }

  assertNamespacingSafeIds(parent.steps);

  const batchSize = parent.concurrency && parent.concurrency > 0 ? parent.concurrency : 0;
  const innerRootIds = new Set(
    parent.steps.filter((step) => !step.needs || step.needs.length === 0).map((step) => step.id),
  );
  const innerLeafIds = findInnerLeafIds(parent.steps);
  const childSteps: WorkflowStep[] = [];
  const stepContextRecord: ForEachExpansionSnapshot['stepContext'] = {};
  const leafStepIds: string[] = [];
  let previousBatchLeafIds: string[] = [];
  let currentBatchLeafIds: string[] = [];

  for (let index = 0; index < collection.length; index++) {
    const item = JsonValueSchema.parse(collection[index]);
    const namespacedLeafIds = innerLeafIds.map((leafId) => namespacedId(parent.id, index, leafId));
    const extraConcurrencyNeeds = concurrencyNeeds(index, batchSize, previousBatchLeafIds);

    for (const innerStep of parent.steps) {
      const expandedId = namespacedId(parent.id, index, innerStep.id);
      const needs = (innerStep.needs ?? []).map((dep) => namespacedId(parent.id, index, dep));

      if (innerRootIds.has(innerStep.id)) {
        if (parent.needs?.length) needs.push(...parent.needs);
        if (extraConcurrencyNeeds.length) needs.push(...extraConcurrencyNeeds);
      }

      childSteps.push(cloneInnerStep(innerStep, expandedId, needs));
      stepContextRecord[expandedId] = { item, index };
    }

    if (batchSize > 0) {
      currentBatchLeafIds.push(...namespacedLeafIds);
    }
    leafStepIds.push(...namespacedLeafIds);

    if (batchSize > 0 && batchInfo(index, batchSize, collection.length).isLast) {
      previousBatchLeafIds = currentBatchLeafIds;
      currentBatchLeafIds = [];
    }
  }

  return {
    parentStepId: parent.id,
    childSteps,
    stepContext: stepContextRecord,
    leafStepIds,
  };
}

/**
 * Evaluate the for-each collection expression and build an expansion snapshot.
 *
 * Combines expression evaluation with snapshot building: resolves `parent.collection`
 * using the provided context, then delegates to `buildForEachExpansionSnapshot`.
 *
 * Throws when:
 * - The collection expression resolves to a non-array value
 * - The for-each ID or any inner step ID contains a dot (namespace collision)
 * @param parent - The for-each step definition to expand
 * @param expressionContext - Runtime expression context
 * @returns Persisted expansion snapshot
 */
export function expandForEachAtRuntime(
  parent: ForEachWorkflowStep,
  expressionContext: WorkflowExpressionContext,
): ForEachExpansionSnapshot {
  const collection = evaluateSync(parent.collection, expressionContext);
  if (!Array.isArray(collection)) {
    throw new Error(
      `for-each step '${parent.id}': collection expression did not resolve to an array (got ${typeof collection})`,
    );
  }

  return buildForEachExpansionSnapshot({ parent, collection, expressionContext });
}

// Re-export for-each types so callers import from a single runtime-for-each module.
export type { ForEachStepContext } from './for-each-expander.js';
export type { ForEachExpansionSnapshot } from '@makaio/contracts';

/**
 * Reconstruct the child step map from a persisted expansion snapshot.
 *
 * Used by the scheduler to rebuild the in-memory step registry after a
 * checkpoint restore without re-evaluating the collection expression.
 * @param snapshot - Persisted expansion snapshot
 * @returns Map from expanded step ID to its WorkflowStep definition
 */
export function buildChildStepMap(snapshot: ForEachExpansionSnapshot): Map<string, WorkflowStep> {
  return new Map(snapshot.childSteps.map((step) => [step.id, step]));
}

/**
 * Reconstruct the per-step context Map from a persisted expansion snapshot.
 *
 * Used by the scheduler to restore item/index context for each child step
 * without re-evaluating collection expressions.
 * @param snapshot - Persisted expansion snapshot
 * @returns Map from expanded step ID to its item/index context
 */
export function buildStepContextFromSnapshot(snapshot: ForEachExpansionSnapshot): Map<string, ForEachStepContext> {
  const map = new Map<string, ForEachStepContext>();
  for (const [stepId, ctx] of Object.entries(snapshot.stepContext)) {
    map.set(stepId, ctx);
  }
  return map;
}
