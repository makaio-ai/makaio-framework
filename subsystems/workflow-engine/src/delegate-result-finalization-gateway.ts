import type { IMakaioBus } from '@makaio/bus-core';
import type { BaseMessageContext } from '@makaio/core';
import {
  createWorkflowDelegateResultFinalizerNamespace,
  requireExecutableRunContext,
  walkWorkflowDefinition,
  type WorkflowAgentStepNode,
  type WorkflowDefinition,
} from '@makaio/contracts';
import { isExecutionBoundAccessAllowed } from './execution-bound-access.js';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/**
 * Register the static Authority gateway for delegate result finalization.
 *
 * Remote job runs can address only this stable subject. The Authority derives
 * the dynamic finalizer subject exclusively after validating the durable run
 * context and delegate-node selector.
 * @param bus - Authority-local workflow bus.
 * @returns Handler cleanup function.
 */
export function registerDelegateResultFinalizationGateway(bus: IMakaioBus): () => void {
  return bus.on(WorkflowSubjects.finalizeDelegateResult, async (ctx) => {
    const payload = ctx.payload;
    assertJobRunCaller(ctx, payload.executionId);

    const { execution } = await bus.request(ctx.call, WorkflowStorageSubjects.getExecution, {
      executionId: payload.executionId,
    });
    if (execution === null || execution.workflowId !== payload.workflowId) {
      throw new Error('delegate result finalization execution does not own the requested workflow');
    }

    const { runContext: storedRunContext } = await bus.request(ctx.call, WorkflowStorageSubjects.getRunContext, {
      executionId: payload.executionId,
    });
    if (
      storedRunContext === null ||
      storedRunContext.executionId !== payload.executionId ||
      storedRunContext.workflowId !== payload.workflowId
    ) {
      throw new Error('delegate result finalization run context does not own the requested workflow execution');
    }
    const runContext = requireExecutableRunContext(storedRunContext);
    if (runContext.definitionSnapshot === undefined) {
      throw new Error('delegate result finalization requires an Authority-owned definition snapshot');
    }
    assertAuthorizedDelegateFinalizer(runContext.definitionSnapshot, payload.nodeId, payload.finalizerId);

    const { subjects } = createWorkflowDelegateResultFinalizerNamespace(payload.finalizerId);
    const result = await bus.request(ctx.call, subjects.finalize, {
      executionId: payload.executionId,
      workflowId: payload.workflowId,
      frameId: payload.frameId,
      nodeId: payload.nodeId,
      rawResult: payload.rawResult,
      toolObservations: payload.toolObservations,
      ...(payload.economics === undefined ? {} : { economics: payload.economics }),
    });
    ctx.setResult(result);
  });
}

/**
 * Require that a remote finalization request is bound to its authenticated job run. Local Authority callers are trusted composition paths.
 * @param ctx - Incoming gateway request context.
 * @param executionId - Requested workflow execution.
 */
function assertJobRunCaller(ctx: BaseMessageContext, executionId: string): void {
  if (isExecutionBoundAccessAllowed(ctx, executionId)) return;
  throw new Error('delegate result finalization requires its authenticated job run caller');
}

/**
 * Confirm that the exact immutable agent-step node selects the requested
 * finalizer. Node ID alone is insufficient because a caller must not use
 * another node's finalizer.
 * @param definition - Authority-owned immutable workflow snapshot.
 * @param nodeId - Agent-step node ID supplied by the worker.
 * @param finalizerId - Requested finalizer identity.
 */
function assertAuthorizedDelegateFinalizer(definition: WorkflowDefinition, nodeId: string, finalizerId: string): void {
  let authorized = false;
  walkWorkflowDefinition(definition.root, {
    enter(node) {
      if (node.type !== 'agent-step' || node.id !== nodeId) return;
      const agentStep = node as WorkflowAgentStepNode;
      if (agentStep.resultFinalizerId === finalizerId) authorized = true;
      return false;
    },
  });
  if (!authorized) {
    throw new Error('delegate result finalizer is not selected by the requested durable delegate node');
  }
}
