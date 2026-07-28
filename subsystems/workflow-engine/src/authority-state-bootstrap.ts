import { isDeepStrictEqual } from 'node:util';
import type { IMakaioBus } from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import type { WorkflowDefinition, WorkflowRunContext } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { WorkflowSubjects } from './namespace.js';
import { getValidatedInitialWorkflowState } from './workflow-state-validation.js';
import { isExecutionBoundAccessAllowed } from './execution-bound-access.js';

/** Product or host hook invoked after immutable authority state is persisted. */
export type AuthorityStatePersistedHook = (context: {
  readonly bus: IMakaioBus;
  readonly executionId: string;
  readonly definition: WorkflowDefinition;
  readonly transport: TransportReceiveContext | undefined;
}) => void | Promise<void>;

const authorityStatePersistedHooks = new Set<AuthorityStatePersistedHook>();

/**
 * Register a host-provided post-persistence authority-state hook.
 * @param hook - Callback invoked after a trusted authority snapshot persists.
 * @returns Idempotent cleanup that unregisters the hook.
 */
export function registerAuthorityStatePersistedHook(hook: AuthorityStatePersistedHook): () => void {
  authorityStatePersistedHooks.add(hook);
  return () => authorityStatePersistedHooks.delete(hook);
}

/**
 * Persist state metadata learned only after an authority-owned runner loads its definition.
 * @param bus - Authority-connected workflow bus.
 * @param runContext - Loaded run-context snapshot.
 * @param definition - Loaded workflow definition.
 */
export async function persistAuthorityLoadedState(
  bus: IMakaioBus,
  runContext: WorkflowRunContext,
  definition: WorkflowDefinition,
): Promise<void> {
  const local = await bus.requestOptional(WorkflowStorageSubjects.getRunContext, {
    executionId: runContext.executionId,
  });
  if (local.handled) {
    await bootstrapAuthorityLoadedState(bus, runContext.executionId, definition);
    return;
  }
  await bus.request(WorkflowSubjects.bootstrapAuthorityState, {
    executionId: runContext.executionId,
    terminalAuthority: 'authority',
    definition,
  });
}

/**
 * Persist a worker-loaded definition through authority-local storage.
 * @param bus - Authority-local workflow bus.
 * @param executionId - Execution whose durable context is updated.
 * @param definition - Definition loaded by the isolated worker.
 * @returns Whether an existing authority-owned context was updated.
 */
export async function bootstrapAuthorityLoadedState(
  bus: IMakaioBus,
  executionId: string,
  definition: WorkflowDefinition,
): Promise<boolean> {
  return (await bootstrapAuthorityLoadedStateSnapshot(bus, executionId, definition)) !== undefined;
}

/**
 * Persist authority metadata while preserving an already-pinned definition snapshot.
 * @param bus - Authority-local workflow bus.
 * @param executionId - Execution whose durable context is updated.
 * @param definition - Definition loaded by the isolated worker.
 * @returns The authoritative snapshot, or `undefined` when no context exists.
 */
async function bootstrapAuthorityLoadedStateSnapshot(
  bus: IMakaioBus,
  executionId: string,
  definition: WorkflowDefinition,
): Promise<WorkflowDefinition | undefined> {
  const stored = await bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
  if (stored.runContext === null) return undefined;
  if (stored.runContext.executionId !== executionId) {
    throw new Error(`Authority bootstrap identity mismatch for '${executionId}'`);
  }
  const storedSnapshot = stored.runContext.definitionSnapshot;
  if (storedSnapshot === undefined) {
    await bus.request(WorkflowStorageSubjects.setRunContext, {
      runContext: { ...stored.runContext, terminalAuthority: 'authority' },
    });
    return undefined;
  }
  if (!definitionsAreJsonEqual(storedSnapshot, definition)) {
    throw new Error(`Authority bootstrap definition mismatch for '${executionId}'`);
  }
  const authoritativeDefinition = storedSnapshot;
  await bus.request(WorkflowStorageSubjects.setRunContext, {
    runContext: {
      ...stored.runContext,
      terminalAuthority: 'authority',
      definitionSnapshot: authoritativeDefinition,
    },
    initialState: getValidatedInitialWorkflowState(authoritativeDefinition),
  });
  return authoritativeDefinition;
}

/**
 * Compare definitions using their durable JSON representation.
 * @param left - Stored authority definition.
 * @param right - Worker-loaded definition.
 * @returns Whether both definitions have the same durable JSON value.
 */
function definitionsAreJsonEqual(left: WorkflowDefinition, right: WorkflowDefinition): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

/**
 * Register the execution-bound authority bootstrap RPC.
 * @param bus - Authority-local workflow bus.
 * @param onPersisted - Callback that refreshes authority-owned in-memory execution state.
 * @returns Handler cleanup function.
 */
export function registerAuthorityStateBootstrapHandler(
  bus: IMakaioBus,
  onPersisted?: (executionId: string, definition: WorkflowDefinition) => void,
): () => void {
  return bus.on(WorkflowSubjects.bootstrapAuthorityState, async (ctx) => {
    if (!isExecutionBoundAccessAllowed(ctx, ctx.payload.executionId)) {
      throw new Error('authority state bootstrap is execution-bound');
    }
    const persistedDefinition = await bootstrapAuthorityLoadedStateSnapshot(
      bus,
      ctx.payload.executionId,
      ctx.payload.definition as WorkflowDefinition,
    );
    if (persistedDefinition !== undefined) {
      onPersisted?.(ctx.payload.executionId, persistedDefinition);
      for (const hook of authorityStatePersistedHooks) {
        await hook({
          bus,
          executionId: ctx.payload.executionId,
          definition: persistedDefinition,
          transport: ctx.transport,
        });
      }
    }
    ctx.setResult({ persisted: persistedDefinition !== undefined });
  });
}
