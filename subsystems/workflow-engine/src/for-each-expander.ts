import type { WorkflowStep, ForEachWorkflowStep } from '@makaio/contracts';
import { evaluateSync, type ExpressionContext } from '@makaio/expression';

/**
 * Per-step context override for for-each item/index scoping.
 */
export interface ForEachStepContext {
  /** Current item in the iteration. */
  item: unknown;
  /** Current zero-based index in the iteration. */
  index: number;
}

/**
 * Result of expanding for-each steps into a flat DAG.
 */
export interface ExpansionResult {
  /** Flat step array with all for-each steps expanded. */
  steps: WorkflowStep[];
  /** Per-step context overrides keyed by expanded step ID. */
  stepContext: Map<string, ForEachStepContext>;
}

/**
 * Expanded replacement for a single for-each step.
 */
interface ForEachExpansion {
  /** Flat steps produced by the for-each expansion. */
  steps: WorkflowStep[];
  /** Leaf step IDs produced across all iterations. */
  leafIds: string[];
}

/**
 * Namespace an inner step ID relative to a for-each step iteration.
 * @param forEachId - The for-each step's ID
 * @param index - The iteration index
 * @param innerStepId - The inner step's original ID
 * @returns The namespaced step ID
 */
function namespacedId(forEachId: string, index: number, innerStepId: string): string {
  return `${forEachId}.${index}.${innerStepId}`;
}

/**
 * Validate for-each namespacing invariants for authored step IDs.
 * IDs containing dots are rejected because expansion uses dot-delimited IDs.
 * @param forEachId - The parent for-each step ID
 * @param innerSteps - The inner steps to be namespaced
 */
function assertNamespacingSafeIds(forEachId: string, innerSteps: WorkflowStep[]): void {
  if (forEachId.includes('.')) {
    throw new Error(`for-each step '${forEachId}': id cannot contain '.'`);
  }
  for (const innerStep of innerSteps) {
    if (innerStep.id.includes('.')) {
      throw new Error(`for-each step '${forEachId}': inner step id '${innerStep.id}' cannot contain '.'`);
    }
  }
}

/**
 * Identify inner step IDs that are leaf nodes (not depended on by any sibling step).
 * @param innerSteps - The inner steps of the for-each
 * @returns Array of step IDs that no other inner step depends on
 */
export function findInnerLeafIds(innerSteps: WorkflowStep[]): string[] {
  const dependedOnByInner = new Set(innerSteps.flatMap((s) => s.needs ?? []));
  return innerSteps.filter((s) => !dependedOnByInner.has(s.id)).map((s) => s.id);
}

/**
 * Batch boundary flags for a single iteration index.
 */
interface BatchInfo {
  /** True if this index is the first item of a new batch (batch \> 0). */
  isFirst: boolean;
  /** True if this index is the last item in its batch. */
  isLast: boolean;
}

/**
 * Computes batch boundary information for a given iteration index.
 * @param i - Iteration index.
 * @param batchSize - Number of items per batch.
 * @param total - Total number of items.
 * @returns Batch boundary flags for this iteration.
 */
function batchInfo(i: number, batchSize: number, total: number): BatchInfo {
  const batch = Math.floor(i / batchSize);
  return {
    isFirst: batch > 0 && Math.floor((i - 1) / batchSize) < batch,
    isLast: i === total - 1 || Math.floor((i + 1) / batchSize) > batch,
  };
}

/**
 * Compute the extra `needs` edges for concurrency batching.
 *
 * When a batch size is configured, the root steps of batch N must wait for
 * the leaf steps of batch N-1 to complete before starting.
 * @param i - Current iteration index
 * @param batchSize - Maximum concurrent iterations (0 = unlimited)
 * @param total - Total number of items in the collection
 * @param previousBatchLeafIds - Leaf IDs from the previous batch
 * @returns Additional needs to prepend for this iteration's root steps
 */
function concurrencyNeeds(i: number, batchSize: number, total: number, previousBatchLeafIds: string[]): string[] {
  if (batchSize === 0 || previousBatchLeafIds.length === 0) return [];
  return batchInfo(i, batchSize, total).isFirst ? previousBatchLeafIds : [];
}

/**
 * Clone a non-for-each inner step with a new namespaced ID and rewired needs.
 * @param innerStep - The inner step (not a for-each) to clone
 * @param expandedId - The new namespaced step ID
 * @param namespacedNeeds - The rewired `needs` array (empty = omit)
 * @returns Cloned step with updated ID and needs
 */
function cloneInnerStep(innerStep: WorkflowStep, expandedId: string, namespacedNeeds: string[]): WorkflowStep {
  // Destructure to exclude id/needs from the spread; preserve everything else
  const { id: _id, needs: _needs, if: ifExpr, ...rest } = innerStep as Exclude<WorkflowStep, ForEachWorkflowStep>;
  return {
    ...rest,
    id: expandedId,
    ...(namespacedNeeds.length > 0 ? { needs: namespacedNeeds } : {}),
    ...(ifExpr !== undefined ? { if: ifExpr } : {}),
  } as WorkflowStep;
}

/**
 * Expand a single for-each step into its flattened WorkflowStep array.
 *
 * Nested for-each steps are expanded separately for each concrete iteration so
 * their collection expressions can resolve this iteration's item/index scope.
 * @param forEachStep - The for-each step to expand
 * @param collection - Pre-resolved collection array (non-empty)
 * @param context - Expression context for evaluating nested for-each steps
 * @param stepContext - Mutable map to record per-step context overrides
 * @returns Expanded steps and leaf IDs replacing this for-each step
 */
function expandSingleForEachWithCollection(
  forEachStep: ForEachWorkflowStep,
  collection: unknown[],
  context: ExpressionContext,
  stepContext: Map<string, ForEachStepContext>,
): ForEachExpansion {
  const batchSize = forEachStep.concurrency && forEachStep.concurrency > 0 ? forEachStep.concurrency : 0;

  const expanded: WorkflowStep[] = [];
  const leafIds: string[] = [];
  let previousBatchLeafIds: string[] = [];
  let currentBatchLeafIds: string[] = [];

  for (let i = 0; i < collection.length; i++) {
    const item = collection[i];
    const iterationContext: ExpressionContext = { ...context, item, index: i };
    const { steps: innerSteps, stepContext: innerContext } = expandForEachSteps(forEachStep.steps, iterationContext);
    const innerRootIds = new Set(innerSteps.filter((s) => !s.needs || s.needs.length === 0).map((s) => s.id));
    const innerLeafIds = findInnerLeafIds(innerSteps);
    const namespacedLeafIds = innerLeafIds.map((leafId) => namespacedId(forEachStep.id, i, leafId));
    const extraConcurrencyNeeds = concurrencyNeeds(i, batchSize, collection.length, previousBatchLeafIds);

    for (const innerStep of innerSteps) {
      const expandedId = namespacedId(forEachStep.id, i, innerStep.id);
      const namespacedNeeds: string[] = (innerStep.needs ?? []).map((dep) => namespacedId(forEachStep.id, i, dep));

      if (innerRootIds.has(innerStep.id)) {
        if (forEachStep.needs?.length) namespacedNeeds.push(...forEachStep.needs);
        if (extraConcurrencyNeeds.length) namespacedNeeds.push(...extraConcurrencyNeeds);
      }

      expanded.push(cloneInnerStep(innerStep, expandedId, namespacedNeeds));
      // Preserve inner for-each context if the inner step was itself expanded from a for-each.
      // The innermost scope wins for every outer iteration.
      const existingInnerCtx = innerContext.get(innerStep.id);
      stepContext.set(expandedId, existingInnerCtx ?? { item, index: i });
    }

    if (batchSize > 0) {
      currentBatchLeafIds.push(...namespacedLeafIds);
    }
    leafIds.push(...namespacedLeafIds);

    // Update batch boundary tracking
    if (batchSize > 0 && batchInfo(i, batchSize, collection.length).isLast) {
      previousBatchLeafIds = currentBatchLeafIds;
      currentBatchLeafIds = [];
    }
  }

  return { steps: expanded, leafIds };
}

/**
 * Rewire steps whose `needs` reference a for-each ID, replacing it with the expanded leaf IDs.
 * @param steps - Steps to rewire
 * @param forEachLeafMap - Map from for-each step ID to its expanded leaf step IDs
 * @returns Rewired steps
 */
function rewireNeeds(steps: WorkflowStep[], forEachLeafMap: Map<string, string[]>): WorkflowStep[] {
  return steps.map((step) => {
    if (!step.needs) return step;
    let changed = false;
    const newNeeds: string[] = [];
    for (const dep of step.needs) {
      const leafIds = forEachLeafMap.get(dep);
      if (leafIds !== undefined) {
        newNeeds.push(...leafIds);
        changed = true;
      } else {
        newNeeds.push(dep);
      }
    }
    if (!changed) return step;
    return { ...step, needs: newNeeds.length > 0 ? newNeeds : undefined } as WorkflowStep;
  });
}

/**
 * Expand all for-each steps in a workflow into a flat DAG.
 *
 * For each for-each step:
 * 1. Evaluates the `collection` expression to get the array.
 * 2. For each item, copies inner steps with namespaced IDs: `{forEachId}.{index}.{innerStepId}`.
 * 3. Rewires `needs` on inner steps and downstream dependents.
 * 4. Applies concurrency batching via synthetic `needs` edges between batches.
 * 5. Recurses into nested for-each steps once each parent iteration context exists.
 *
 * The function is pure: no bus access, no side effects.
 * Collection expression errors propagate to the caller (caught by `runExecution`).
 * @param steps - Original workflow steps
 * @param context - Expression context for evaluating collection expressions
 * @returns Expanded steps and per-step context map
 */
export function expandForEachSteps(steps: WorkflowStep[], context: ExpressionContext): ExpansionResult {
  const stepContext = new Map<string, ForEachStepContext>();
  const expanded: WorkflowStep[] = [];
  // Track which for-each step IDs map to their expanded leaf IDs (for downstream rewiring)
  const forEachLeafMap = new Map<string, string[]>();

  for (const step of steps) {
    if (step.type !== 'for-each') {
      expanded.push(step);
      continue;
    }

    const forEachStep = step;

    // Evaluate the for-each step's own `if` condition before expanding.
    // A falsy result is treated as an empty collection: no expanded steps,
    // and downstream needs are rewired to nothing (same path as `collection: []`).
    // Uses truthy check (not `!== undefined`) to match executor's `if (step.if)`
    // semantics — empty/whitespace strings are treated as "no condition".
    if (forEachStep.if) {
      const conditionResult = evaluateSync(forEachStep.if, context);
      if (!conditionResult) {
        forEachLeafMap.set(forEachStep.id, []);
        continue;
      }
    }

    // Validate authored IDs before recursive expansion; expanded nested IDs may
    // already contain dots as part of internal namespacing and are expected.
    assertNamespacingSafeIds(forEachStep.id, forEachStep.steps);

    // Evaluate collection once, reuse for both expansion and leaf ID computation
    const collection = evaluateSync(forEachStep.collection, context);
    if (!Array.isArray(collection)) {
      throw new Error(
        `for-each step '${forEachStep.id}': collection expression did not resolve to an array (got ${typeof collection})`,
      );
    }

    const expandedForEach =
      collection.length > 0
        ? expandSingleForEachWithCollection(forEachStep, collection, context, stepContext)
        : { steps: [], leafIds: [] };
    forEachLeafMap.set(forEachStep.id, expandedForEach.leafIds);

    expanded.push(...expandedForEach.steps);
  }

  return { steps: rewireNeeds(expanded, forEachLeafMap), stepContext };
}
