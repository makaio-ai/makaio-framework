import type { IMakaioBus } from '@makaio/bus-core';
import type { BaseMessageContext } from '@makaio/core';
import {
  JsonPatchOperationSchema,
  type IWorkflowTriggerTypeRegistry,
  type JsonValue,
  type WorkflowDefinition,
} from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { assertWorkflowStateValueMatchesSchema } from './workflow-state-validation.js';

/**
 * Enforce the trust-boundary rules for execution-bound public RPC subjects.
 *
 * - Local callers are always permitted (hot path, no transport round-trip).
 * - Direct-HMAC callers must present an authenticated `workflow-execution`
 *   peer whose `id === executionId`.
 * - Relay callers must present an encrypted E2E peer whose relay identity is
 *   also bound to `executionId`. Encryption alone is not authorization.
 * - All other remote callers are denied.
 * @param ctx - Incoming message context.
 * @param executionId - The requested execution identifier.
 * @returns `true` when the caller may access the execution-bound resource.
 */
function isExecutionBoundAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
  if (ctx.origin.local) {
    return true;
  }
  const peer = ctx.transport?.peer;
  if (peer?.authenticated !== true) {
    return false;
  }
  if (peer.id !== executionId) {
    return false;
  }
  if (peer.kind === 'workflow-execution') {
    return true;
  }
  return peer.kind === 'e2e' && peer.encrypted === true;
}

/**
 * Load the workflow definition snapshot used to authorize state schema changes.
 * @param bus - Message bus used for storage requests.
 * @param executionId - Execution whose workflow state is being mutated.
 * @returns Workflow definition snapshot, or `undefined` when no state contract is available.
 */
async function loadStateWorkflowSnapshot(
  bus: IMakaioBus,
  executionId: string,
): Promise<WorkflowDefinition | undefined> {
  const { runContext } = await bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
  if (runContext === null) {
    throw new Error(`Run context not found for execution: ${executionId}`);
  }
  if (runContext.definitionSnapshot !== undefined) {
    return runContext.definitionSnapshot;
  }
  const { workflow } = await bus.request(WorkflowStorageSubjects.get, { id: runContext.workflowId });
  return workflow ?? undefined;
}

/**
 * Register handlers that delegate workflow contract subjects to storage subjects.
 * @param bus - Message bus
 * @returns Cleanup functions for all registered handlers
 */
export function registerWorkflowStorageDelegationHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.getDefinition, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.get, { id: ctx.payload.id });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.setDefinition, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.set, { workflow: ctx.payload.workflow });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.deleteDefinition, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.delete, { id: ctx.payload.id });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listDefinitions, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.list, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.getExecution, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: ctx.payload.executionId,
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listExecutions, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listExecutions, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listSpans, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listSpans, {
        executionId: ctx.payload.executionId,
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listFrames, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: ctx.payload.executionId,
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listGateInstances, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listGateInstances, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.setExecutionLink, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.setExecutionLink, { link: ctx.payload.link });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listExecutionLinks, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listExecutionLinks, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.getRunContext, async (ctx) => {
      const { executionId } = ctx.payload;
      if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
        throw new Error(`Unauthorized: caller is not permitted to read run context for execution: ${executionId}`);
      }
      const { runContext } = await bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
      if (!runContext) {
        throw new Error(`Run context not found for execution: ${executionId}`);
      }
      ctx.setResult(runContext);
    }),
  ];
}

/**
 * Register public-facing workflow state bus handlers.
 *
 * These handlers delegate to internal storage subjects and emit
 * lifecycle events. They are registered by the executor during init.
 * @param bus - The bus to register handlers on
 * @returns Array of cleanup functions for handler deregistration
 */
export function registerWorkflowStateHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.state.get, async (ctx) => {
      const { executionId } = ctx.payload;
      if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
        throw new Error(`Unauthorized: caller is not permitted to read state for execution: ${executionId}`);
      }
      const { state } = await bus.request(WorkflowStorageSubjects.getState, { executionId });
      if (state === null) {
        throw new Error(`no workflow state for execution ${executionId}`);
      }
      ctx.setResult(state);
    }),

    bus.on(WorkflowSubjects.state.patch, async (ctx) => {
      const { executionId, expectedSequence, patch, nextValue } = ctx.payload;
      if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
        throw new Error(`Unauthorized: caller is not permitted to patch state for execution: ${executionId}`);
      }
      if (expectedSequence === undefined) {
        throw new Error('expectedSequence is required to patch workflow state');
      }
      const workflow = await loadStateWorkflowSnapshot(bus, executionId);
      if (workflow !== undefined) {
        assertWorkflowStateValueMatchesSchema(workflow, nextValue as JsonValue, 'next');
      }
      JsonPatchOperationSchema.array().parse(patch);
      const result = await bus.request(WorkflowStorageSubjects.patchState, {
        executionId,
        expectedSequence,
        nextValue: nextValue as JsonValue,
      });
      bus
        .emit(WorkflowSubjects.state.updated, {
          executionId: result.executionId,
          sequence: result.sequence,
          patch: result.patch,
          value: result.value,
          updatedAt: Date.now(),
        })
        .catch(() => {
          // observer failures must not reject the RPC after state is persisted
        });
      ctx.setResult({ executionId: result.executionId, sequence: result.sequence, value: result.value });
    }),
  ];
}

/**
 * Register trigger type query handlers.
 * @param bus - Message bus
 * @param getRegistry - Lazy trigger registry accessor
 * @returns Cleanup functions for registered handlers
 */
export function registerWorkflowTriggerTypeHandlers(
  bus: IMakaioBus,
  getRegistry: () => IWorkflowTriggerTypeRegistry | undefined,
): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.listTriggerTypes, (ctx) => {
      const triggerTypes = getRegistry()?.getAll() ?? [];
      ctx.setResult({ triggerTypes });
    }),
  ];
}
