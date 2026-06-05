import type { IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, WorkflowSubjects } from '@makaio/contracts';
import type { ArtifactContext, ArtifactPatch, ArtifactUpdater } from '@makaio/contracts';
import { makeWorkflowActor, type ArtifactBindingState } from './artifact-binding.js';

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

const artifactUpdateQueues = new WeakMap<ArtifactBindingState, Promise<void>>();

/**
 * Run artifact updates for a binding in revision order.
 *
 * The binding state is the execution-local authority for the current artifact
 * revision. Serializing per binding keeps each update's read, validation, and
 * revise RPC in one ordered revision chain even when station handlers overlap.
 * @param bindingState - Shared artifact binding state for this execution.
 * @param operation - Update operation to run after earlier writes settle.
 * @returns The operation result.
 */
function enqueueArtifactUpdate<TResult>(
  bindingState: ArtifactBindingState,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const previous = artifactUpdateQueues.get(bindingState) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  artifactUpdateQueues.set(
    bindingState,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Apply a declarative patch to the current artifact data.
 *
 * - `set`    — replace `current` entirely with `patch.data`
 * - `merge`  — deep-merge `patch.data` into `current` (shallow at top level)
 * - `append` — for each field in `patch.data`, if both current and patch
 *   values are arrays, concatenate them; otherwise behave like `merge`
 * @param current - Current artifact data snapshot.
 * @param patch - Declarative patch descriptor.
 * @returns The next artifact data payload.
 */
function applyPatch<TData extends Record<string, unknown>>(
  current: Readonly<TData>,
  patch: ArtifactPatch<TData>,
): TData {
  switch (patch.operation) {
    case 'set':
      return patch.data as TData;

    case 'merge':
      return { ...current, ...patch.data };

    case 'append': {
      const result: Record<string, unknown> = { ...current };
      for (const [key, patchValue] of Object.entries(patch.data)) {
        const currentValue = current[key];
        if (Array.isArray(currentValue) && Array.isArray(patchValue)) {
          result[key] = [...currentValue, ...patchValue];
        } else {
          result[key] = patchValue;
        }
      }
      return result as TData;
    }
  }
}

/**
 * Produce a new data object with the value at the given path segments replaced by `value`.
 *
 * Intermediate objects are shallow-cloned so the original `data` is not
 * mutated. Missing intermediate keys are created as plain objects.
 * @param data - The source object to clone and update.
 * @param segments - Pre-split path segments.
 * @param value - The new value to set.
 * @returns A shallow-cloned object with the targeted field updated.
 */
function setSegmentsRecursive(
  data: Record<string, unknown>,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    return { ...data, [head!]: value };
  }
  const child =
    data[head!] !== null && typeof data[head!] === 'object' && !Array.isArray(data[head!])
      ? (data[head!] as Record<string, unknown>)
      : {};
  return {
    ...data,
    [head!]: setSegmentsRecursive(child, rest, value),
  };
}

/**
 * Produce a new data object with the value at `path` replaced by `value`.
 *
 * Supports both dot-notation and slash-prefixed JSON Pointer paths.
 * Path parsing happens once at entry; recursive traversal uses pre-split
 * segments to avoid mixed separator issues.
 * Intermediate objects are shallow-cloned so the original `data` is not
 * mutated. Missing intermediate keys are created as plain objects.
 * @param data - The source object to clone and update.
 * @param path - Dot-separated or slash-prefixed path string.
 * @param value - The new value to set at `path`.
 * @returns A shallow-cloned object with the targeted field updated.
 */
function setValueAtPath(data: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.startsWith('/') ? path.slice(1).split('/') : path.split('.');
  return setSegmentsRecursive(data, segments, value);
}

// ─────────────────────────────────────────────────────────────
// Compute changed paths
// ─────────────────────────────────────────────────────────────

/**
 * Compare two plain objects and return the top-level keys whose values differ.
 *
 * For the `workflow.artifact.updated` event, `paths` lists the JSON Pointer
 * paths to changed fields:
 * - `set` and `functional` — return an empty array to signal a full replacement.
 *   Consumers that receive an empty `paths` array must treat the entire artifact
 *   as replaced and must not rely on specific field deltas.
 * - `merge` and `append` — enumerate only the top-level keys that changed, since
 *   only the patched keys can differ.
 * @param previous - Previous artifact data snapshot.
 * @param next - Next artifact data snapshot.
 * @param operation - Update operation that produced `next`.
 * @returns Array of JSON Pointer paths to changed top-level fields, or empty
 * array for full-replacement operations.
 */
function computeChangedPaths(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  operation: ArtifactPatch<Record<string, unknown>>['operation'] | 'functional',
): string[] {
  if (operation === 'set' || operation === 'functional') {
    // Full replacement — return empty array as the documented signal.
    return [];
  }

  // merge / append: only the patched keys can have changed.
  const changed: string[] = [];
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key]) {
      changed.push(`/${key}`);
    }
  }
  return changed;
}

// ─────────────────────────────────────────────────────────────
// Resolve update helper
// ─────────────────────────────────────────────────────────────

/**
 * Resolved update result returned by {@link resolveUpdate}.
 */
interface ResolvedUpdate<TData> {
  nextData: TData;
  operationLabel: string;
  changedPaths: string[];
}

/**
 * Resolve the next artifact data and metadata from a patch or functional updater.
 * @param currentData - Current artifact data snapshot.
 * @param update - Declarative patch or functional updater.
 * @returns Resolved next data, operation label, and changed paths.
 */
async function resolveUpdate<TData extends Record<string, unknown>>(
  currentData: TData,
  update: ArtifactPatch<TData> | ArtifactUpdater<TData>,
): Promise<ResolvedUpdate<TData>> {
  if (typeof update === 'function') {
    const nextData = await update(Object.freeze({ ...currentData }) as Readonly<TData>);
    return { nextData, operationLabel: 'functional', changedPaths: [] };
  }
  const nextData = applyPatch(currentData, update);
  const changedPaths = computeChangedPaths(
    currentData as Record<string, unknown>,
    nextData as Record<string, unknown>,
    update.operation,
  );
  return { nextData, operationLabel: update.operation, changedPaths };
}

// ─────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for {@link createArtifactContext}.
 */
export interface CreateArtifactContextOptions {
  /** Execution identifier — used for actor attribution and event correlation. */
  readonly executionId: string;
  /** Frame identifier — used in `workflow.artifact.updated` events. */
  readonly frameId: string;
  /** Mutable binding state shared across all stations in this execution. */
  readonly bindingState: ArtifactBindingState;
  /** Message bus for artifact service RPCs and event emission. */
  readonly bus: IMakaioBus;
}

/**
 * Build a typed {@link ArtifactContext} for injection into a station's
 * {@link StepContext}.
 *
 * The returned context is a snapshot-at-call-time view: `data` is frozen
 * from the `bindingState.current.data` at the moment `createArtifactContext`
 * is called. Subsequent `updateArtifact` calls mutate `bindingState.current`
 * in place so the next station invocation sees the latest data.
 * @param options - Construction options including execution/frame IDs and binding state.
 * @returns A typed {@link ArtifactContext} ready for use in a station handler.
 */
export function createArtifactContext<TData extends Record<string, unknown> = Record<string, unknown>>(
  options: CreateArtifactContextOptions,
): ArtifactContext<TData> {
  const { executionId, frameId, bindingState, bus } = options;
  const snapshot = Object.freeze({ ...bindingState.current.data }) as Readonly<TData>;

  const updateArtifact = async (update: ArtifactPatch<TData> | ArtifactUpdater<TData>): Promise<string> => {
    return enqueueArtifactUpdate(bindingState, async () => {
      const current = bindingState.current;
      const { nextData, operationLabel, changedPaths } = await resolveUpdate(current.data as TData, update);

      // Validate with Zod schema when present.
      if (bindingState.zodSchema !== undefined) {
        const result = bindingState.zodSchema.safeParse(nextData);
        if (!result.success) {
          throw new Error(`Artifact data validation failed: ${result.error.message}`);
        }
      }

      // Write new revision via the artifact bus.
      const reviseResponse = await bus.request(ArtifactSubjects.revise, {
        previous: {
          refClass: 'artifact',
          kind: current.kind,
          id: current.id,
          revision: current.revision,
        },
        revision: {
          kind: current.kind,
          schemaVersion: bindingState.schemaVersion,
          scope: current.scope,
          data: nextData as Record<string, unknown>,
          relations: current.relations,
          actor: makeWorkflowActor(executionId),
        },
      });

      // Update binding state to the new revision.
      bindingState.current = reviseResponse.artifact;

      const newRevision = reviseResponse.artifact.revision;

      // Emit workflow.artifact.updated event — fire-and-forget so a slow
      // observer cannot stall station execution.
      void bus
        .emit(WorkflowSubjects.artifact.updated, {
          executionId,
          frameId,
          artifactRef: {
            kind: reviseResponse.artifact.kind,
            id: reviseResponse.artifact.id,
          },
          paths: changedPaths,
          operation: operationLabel,
          revision: newRevision,
        })
        .catch((err: unknown) => {
          console.error('[ArtifactContext] Failed to emit artifact.updated event:', err);
        });

      return newRevision;
    });
  };

  const updateStatus = async (value: string): Promise<string> => {
    if (bindingState.statusPath === undefined) {
      throw new Error(
        'updateStatus() called but no statusPath is configured on the artifact binding. ' +
          'Set statusPath in the .artifact() builder call to use updateStatus().',
      );
    }

    // Capture statusPath for use inside the closure (TypeScript narrows it to
    // `string` here, but the closure needs a stable local reference).
    const statusPath = bindingState.statusPath;

    // Use a functional updater so the read and write are atomic within the
    // updateArtifact call, avoiding a TOCTOU race with concurrent updates.
    return updateArtifact((current) => setValueAtPath(current as Record<string, unknown>, statusPath, value) as TData);
  };

  return {
    data: snapshot,
    updateArtifact,
    updateStatus,
  };
}
