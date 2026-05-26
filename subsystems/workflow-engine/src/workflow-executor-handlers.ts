import type { IMakaioBus } from '@makaio/bus-core';
import type { IWorkflowTriggerTypeRegistry } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

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
