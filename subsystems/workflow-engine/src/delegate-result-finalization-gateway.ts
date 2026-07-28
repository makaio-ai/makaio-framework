import type { IMakaioBus } from '@makaio/bus-core';
import type { BaseMessageContext } from '@makaio/core';
import {
  createWorkflowDelegateResultFinalizerNamespace,
  walkWorkflowDefinition,
  type WorkflowDelegateAgentNode,
  type WorkflowDelegateRoleNode,
  type WorkflowDefinition,
} from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/**
 * Register the static Authority gateway for delegate result finalization.
 *
 * Remote attempts can address only this stable subject. The Authority derives
 * the dynamic finalizer subject exclusively after validating the durable run
 * context and delegate-node selector.
 * @param bus - Authority-local workflow bus.
 * @returns Handler cleanup function.
 */
export function registerDelegateResultFinalizationGateway(bus: IMakaioBus): () => void {
  return bus.on(WorkflowSubjects.finalizeDelegateResult, async (ctx) => {
    const payload = ctx.payload;
    assertExecutionAttemptPeer(ctx, payload.executionId);

    const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, {
      executionId: payload.executionId,
    });
    if (execution === null || execution.workflowId !== payload.workflowId) {
      throw new Error('delegate result finalization execution does not own the requested workflow');
    }

    const { runContext } = await bus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: payload.executionId,
    });
    if (
      runContext === null ||
      runContext.executionId !== payload.executionId ||
      runContext.workflowId !== payload.workflowId
    ) {
      throw new Error('delegate result finalization run context does not own the requested workflow execution');
    }
    if (runContext.definitionSnapshot === undefined) {
      throw new Error('delegate result finalization requires an Authority-owned definition snapshot');
    }
    assertAuthorizedDelegateFinalizer(
      runContext.definitionSnapshot,
      payload.nodeId,
      payload.nodeType,
      payload.finalizerId,
    );

    const { subjects } = createWorkflowDelegateResultFinalizerNamespace(payload.finalizerId);
    const result = await bus.request(subjects.finalize, {
      executionId: payload.executionId,
      workflowId: payload.workflowId,
      frameId: payload.frameId,
      nodeId: payload.nodeId,
      nodeType: payload.nodeType,
      rawResult: payload.rawResult,
      toolObservations: payload.toolObservations,
      ...(payload.economics === undefined ? {} : { economics: payload.economics }),
    });
    ctx.setResult(result);
  });
}

/**
 * Require that a remote finalization request is bound to its exact Authority
 * dispatch attempt. Local Authority callers are trusted composition paths.
 * @param ctx - Incoming gateway request context.
 * @param executionId - Requested workflow execution.
 */
function assertExecutionAttemptPeer(ctx: BaseMessageContext, executionId: string): void {
  if (ctx.origin.local) return;
  const peer = ctx.transport?.peer;
  if (
    peer?.authenticated !== true ||
    peer.kind !== 'workflow-execution-attempt' ||
    peer.claims?.['executionId'] !== executionId
  ) {
    throw new Error('delegate result finalization requires its authenticated workflow-execution-attempt peer');
  }
}

/**
 * Confirm that the exact immutable delegate node selects the requested
 * finalizer. Node ID alone is insufficient because a caller must not switch
 * delegate type or use another node's finalizer.
 * @param definition - Authority-owned immutable workflow snapshot.
 * @param nodeId - Delegate node ID supplied by the worker.
 * @param nodeType - Delegate node type supplied by the worker.
 * @param finalizerId - Requested finalizer identity.
 */
function assertAuthorizedDelegateFinalizer(
  definition: WorkflowDefinition,
  nodeId: string,
  nodeType: 'delegate-agent' | 'delegate-role',
  finalizerId: string,
): void {
  let authorized = false;
  walkWorkflowDefinition(definition.root, {
    enter(node) {
      if (
        (node.type !== 'delegate-agent' && node.type !== 'delegate-role') ||
        node.id !== nodeId ||
        node.type !== nodeType
      )
        return;
      const delegate = node as WorkflowDelegateAgentNode | WorkflowDelegateRoleNode;
      if (delegate.resultFinalizerId === finalizerId) authorized = true;
      return false;
    },
  });
  if (!authorized) {
    throw new Error('delegate result finalizer is not selected by the requested durable delegate node');
  }
}
