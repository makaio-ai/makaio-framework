import type { IMakaioBus } from '@makaio/bus-core';
import type { BaseMessageContext } from '@makaio/core';
import type { IWorkflowTriggerTypeRegistry } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/**
 * Enforce the trust-boundary rules documented on `WorkflowSubjects.getRunContext`.
 *
 * - Local callers are always permitted (hot path, no transport round-trip).
 * - Direct-HMAC callers must present an authenticated `workflow-execution`
 *   peer whose `id === executionId`.
 * - Relay callers must present an encrypted E2E peer whose relay identity is
 *   also bound to `executionId`. Encryption alone is not authorization.
 * - All other remote callers are denied.
 * @param ctx - Incoming message context.
 * @param executionId - The requested execution identifier.
 * @returns `true` when the caller may receive the run context.
 */
function isRunContextAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
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
      if (!isRunContextAccessAllowed(ctx, executionId)) {
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
