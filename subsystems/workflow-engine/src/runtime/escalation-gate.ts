import type { CallContext } from '@makaio/core';
import type { JsonValue, WorkflowGateInstance, WorkflowLoopNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import type { RuntimeContext } from './runtime-context.js';
import type { validateGateResumeData } from './gate-resume-validation.js';
import type { Deferred } from './deferred.js';

// -----------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------

/** User response payload shape for escalation gate responses. */
export interface EscalationGateResponse {
  readonly action: 'approve' | 'reject';
  readonly resumeData: JsonValue;
  readonly reason?: string;
  /** Call context of the `gate.respond` message that carried this response. */
  readonly call: CallContext;
}

/** Parameters for registering the in-process escalation response handler. */
export interface EscalationResponderOptions {
  readonly node: WorkflowLoopNode;
  readonly ctx: RuntimeContext;
  readonly parentFrameId: string;
  readonly validator: Parameters<typeof validateGateResumeData>[0];
  readonly pending: { value: boolean };
  readonly deferred: Deferred<EscalationGateResponse>;
}

// -----------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------

/**
 * Upsert a gate instance record via the storage bus.
 *
 * Mirrors the gate-node pattern: exit-based parking requires durable
 * persistence; in-process tests downgrade errors to warnings.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context providing the bus.
 * @param gate - Gate instance to upsert.
 * @param required - Whether storage failure should throw.
 */
export async function upsertGateInstance(
  call: CallContext,
  ctx: RuntimeContext,
  gate: WorkflowGateInstance,
  required: boolean,
): Promise<void> {
  try {
    if (required) {
      await ctx.bus.request(call, WorkflowStorageSubjects.setGateInstance, { gate });
    } else {
      await ctx.bus.requestOptional(call, WorkflowStorageSubjects.setGateInstance, { gate });
    }
  } catch (error) {
    if (required) throw error;
    console.warn(`[LoopNode] Failed to upsert escalation gate for '${gate.nodeId}':`, error);
  }
}

/**
 * Emit the gate-suspended event for a loop escalation gate.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context.
 * @param node - Loop node whose escalation gate is being opened.
 * @param frameId - Frame ID used as the gate frame identity.
 * @param schema - JSON Schema for the resume data payload.
 * @param prompt - Rendered escalation prompt.
 * @param openedAt - Epoch milliseconds when the gate opened.
 */
export async function emitGateSuspended(
  call: CallContext,
  ctx: RuntimeContext,
  node: WorkflowLoopNode,
  frameId: string,
  schema: WorkflowGateInstance['schema'],
  prompt: string,
  openedAt: number,
): Promise<void> {
  try {
    await ctx.bus.emit(call, WorkflowSubjects.gate.suspended, {
      executionId: ctx.executionId,
      ...(ctx.executionAttemptId !== undefined ? { executionAttemptId: ctx.executionAttemptId } : {}),
      frameId,
      nodeId: node.id,
      schema,
      prompt,
      ...(node.gate.escalation?.title !== undefined && { title: node.gate.escalation.title }),
      autoAction: node.gate.escalation?.autoAction ?? 'reject',
      timeoutMs: node.gate.escalation?.timeoutMs ?? null,
      openedAt,
    });
  } catch (emitError) {
    console.error(`[LoopNode] gate.suspended emit failed for '${node.id}':`, emitError);
  }
}

/**
 * Emit the gate-resolved lifecycle event for a loop escalation gate.
 * @param call - Call context of the message that caused the resolution.
 * @param ctx - Runtime context.
 * @param nodeId - Loop node identifier.
 * @param frameId - Frame identifier.
 * @param resolution - Resolution metadata.
 */
export async function emitGateResolved(
  call: CallContext,
  ctx: RuntimeContext,
  nodeId: string,
  frameId: string,
  resolution:
    | { readonly action: 'approve' | 'reject'; readonly source: 'user'; readonly reason?: string }
    | { readonly action: 'approve' | 'reject'; readonly source: 'timeout' }
    | { readonly source: 'cancelled' },
): Promise<void> {
  try {
    await ctx.bus.emit(call, WorkflowSubjects.gate.resolved, {
      executionId: ctx.executionId,
      stepId: nodeId,
      stepType: 'gate',
      frameId,
      ...resolution,
    });
  } catch (error) {
    console.error(`[LoopNode] gate.resolved emit failed for '${nodeId}':`, error);
  }
}

/**
 * Load a persisted escalation gate instance for exit-strategy resume paths.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context.
 * @param nodeId - Loop node identifier.
 * @param frameId - Frame ID for the gate instance.
 * @returns The persisted gate instance, or `null` when absent.
 */
export async function loadPersistedEscalationGate(
  call: CallContext,
  ctx: RuntimeContext,
  nodeId: string,
  frameId: string,
): Promise<WorkflowGateInstance | null> {
  if (ctx.suspensionStrategy !== 'wait-in-process') {
    const result = await ctx.bus.request(call, WorkflowStorageSubjects.getGateInstance, {
      executionId: ctx.executionId,
      nodeId,
      frameId,
    });
    return result.gate;
  }

  const result = await ctx.bus.requestOptional(call, WorkflowStorageSubjects.getGateInstance, {
    executionId: ctx.executionId,
    nodeId,
    frameId,
  });
  return result.handled ? result.data.gate : null;
}
