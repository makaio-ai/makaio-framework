import { NoHandlerError } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { resolveTemplate } from '@makaio/expression';
import type { JsonValue, LoopGateOutcome, WorkflowGateInstance, WorkflowLoopNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import type { NodeOutcome } from './node-execution.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import {
  compileGateResumeValidator,
  validateGateResumeData,
  validateGateResumeDataForSchema,
} from './gate-resume-validation.js';
import { buildLoopOutput } from './loop-node.js';
import { buildDeferred } from './deferred.js';
import {
  emitGateResolved,
  emitGateSuspended,
  loadPersistedEscalationGate,
  upsertGateInstance,
  type EscalationGateResponse,
  type EscalationResponderOptions,
} from './escalation-gate.js';
import { raceDeferredResponse } from './deferred-race.js';
import { AUTO_APPROVE_TIMEOUT_RESUME_DATA } from './gate-suspension.js';

// -----------------------------------------------------------------
// In-process gate suspension
// -----------------------------------------------------------------

/**
 * Register the one-shot in-process escalation response handler.
 * @param options - Registration dependencies and shared pending state.
 * @returns Unsubscribe callback for the bus handler.
 */
function registerInProcessEscalationResponder(options: EscalationResponderOptions): () => void {
  const { node, ctx, parentFrameId, validator, pending, deferred } = options;
  return ctx.bus.on(WorkflowSubjects.gate.respond, async (respondCtx) => {
    const {
      executionId,
      executionAttemptId,
      gateId,
      frameId: respondFrameId,
      action,
      resumeData,
      reason,
    } = respondCtx.payload;
    if (
      executionId !== ctx.executionId ||
      gateId !== node.id ||
      executionAttemptId !== ctx.executionAttemptId ||
      (respondFrameId !== undefined && respondFrameId !== parentFrameId)
    ) {
      try {
        await respondCtx.next();
      } catch (e) {
        if (e instanceof NoHandlerError) respondCtx.setResult({ accepted: false });
        else throw e;
      }
      return;
    }
    if (!pending.value) {
      respondCtx.setResult({ accepted: false });
      return;
    }
    const validation = validateGateResumeData(validator, resumeData as JsonValue);
    if (!validation.valid) {
      respondCtx.setResult({ accepted: false });
      return;
    }
    pending.value = false;
    respondCtx.setResult({ accepted: true });
    deferred.resolve({ action, resumeData: resumeData as JsonValue, reason, call: respondCtx.call });
  });
}

/**
 * Wait for an in-process `gate.respond` and settle the escalation gate.
 *
 * Registers a one-shot respond handler, races the deferred response
 * against timeout and abort signals, and returns the terminal loop outcome.
 * A user response settles with the call context of its `gate.respond` message;
 * timeout and cancellation settle with the run's call.
 * @param call - Call context of the message that drives this execution run.
 * @param node - Loop node with escalation config.
 * @param ctx - Runtime context.
 * @param parentFrameId - Loop container frame ID.
 * @param gateInstance - Persisted waiting gate instance.
 * @param gateOutcome - Escalation gate outcome for the loop output.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs.
 * @returns Terminal node outcome.
 */
async function waitForInProcessResponse(
  call: CallContext,
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  parentFrameId: string,
  gateInstance: WorkflowGateInstance,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
): Promise<NodeOutcome> {
  const resumeValidator = compileGateResumeValidator(node.id, node.gate.escalation?.resumeSchema);
  if (resumeValidator.status === 'failed') {
    return { status: 'failed', error: resumeValidator.error };
  }

  const pending = { value: true };
  const deferred = buildDeferred<EscalationGateResponse>();
  const unsubRespond = registerInProcessEscalationResponder({
    node,
    ctx,
    parentFrameId,
    validator: resumeValidator.validator,
    pending,
    deferred,
  });

  await emitGateSuspended(
    call,
    ctx,
    node,
    parentFrameId,
    gateInstance.schema,
    gateInstance.prompt ?? '',
    gateInstance.createdAt,
  );

  try {
    const waitResult = await raceDeferredResponse(deferred, pending, ctx.signal, gateInstance.timeoutMs);
    if (waitResult.status === 'timed-out') {
      return resolveExpiredEscalationGate(
        call,
        ctx,
        node,
        parentFrameId,
        gateInstance,
        gateOutcome,
        rounds,
        bodyOutputs,
        false,
      );
    }
    if (waitResult.status === 'resolved') {
      return settleInProcessResponse(
        waitResult.value.call,
        ctx,
        node.id,
        parentFrameId,
        gateInstance,
        waitResult.value,
        gateOutcome,
        rounds,
        bodyOutputs,
      );
    }

    await upsertGateInstance(call, ctx, { ...gateInstance, status: 'cancelled', resolvedAt: Date.now() }, false);
    await emitGateResolved(call, ctx, node.id, parentFrameId, { source: 'cancelled' });
    return { status: 'cancelled' };
  } finally {
    unsubRespond();
  }
}

/**
 * Persist the resolved gate state and emit lifecycle events after an
 * in-process escalation gate response.
 * @param call - Call context of the `gate.respond` message that carried the response.
 * @param ctx - Runtime context.
 * @param nodeId - Loop node identifier.
 * @param frameId - Gate frame identifier.
 * @param gateInstance - The waiting gate instance to update.
 * @param response - User response payload.
 * @param gateOutcome - Escalation gate outcome for the loop output.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs.
 * @returns Terminal node outcome.
 */
async function settleInProcessResponse(
  call: CallContext,
  ctx: RuntimeContext,
  nodeId: string,
  frameId: string,
  gateInstance: WorkflowGateInstance,
  response: EscalationGateResponse,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
): Promise<NodeOutcome> {
  const resolvedAt = Date.now();
  const resolvedStatus = response.action === 'reject' ? 'rejected' : 'resumed';
  await upsertGateInstance(
    call,
    ctx,
    {
      ...gateInstance,
      status: resolvedStatus,
      resumeData: response.resumeData,
      ...(response.reason !== undefined ? { reason: response.reason } : {}),
      resolvedAt,
    },
    false,
  );

  try {
    await ctx.bus.emit(call, WorkflowSubjects.gate.resumed, {
      executionId: ctx.executionId,
      frameId,
      nodeId,
      resumeData: response.resumeData,
    });
    await emitGateResolved(call, ctx, nodeId, frameId, {
      action: response.action,
      source: 'user',
      ...(response.reason !== undefined ? { reason: response.reason } : {}),
    });
  } catch (emitError) {
    console.error(`[LoopNode] gate.resumed emit failed for '${nodeId}':`, emitError);
  }

  return {
    status: 'completed',
    output: buildLoopOutput('escalate', rounds, gateOutcome, bodyOutputs, response.resumeData),
  };
}

// -----------------------------------------------------------------
// Public API
// -----------------------------------------------------------------

/**
 * Open a loop escalation gate suspension and wait for a response (in-process)
 * or return paused (exit-based).
 *
 * Creates a {@link WorkflowGateInstance} from the loop's escalation config,
 * persists it, sets the frame to waiting, and either:
 * - Exit-based: emits `gate.suspended` and returns `paused`
 * - In-process: registers a `gate.respond` handler, emits `gate.suspended`,
 *   and waits for the response, timeout, or cancellation
 * @param call - Call context of the message that drives this execution run.
 * @param node - Loop node with escalation config.
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression context for prompt rendering.
 * @param parentFrameId - Loop container frame ID (used as the gate frame).
 * @param gateOutcome - The escalation gate outcome that triggered this.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs collected so far.
 * @returns Terminal node outcome for the loop.
 */
export async function openEscalationGate(
  call: CallContext,
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  parentFrameId: string,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
): Promise<NodeOutcome> {
  const escalation = node.gate.escalation;
  if (escalation === undefined) {
    return {
      status: 'completed',
      output: buildLoopOutput('escalate', rounds, gateOutcome, bodyOutputs),
    };
  }

  const prompt = resolveTemplate(escalation.prompt, buildRuntimeExpressionScope(expressionCtx));
  const schema: WorkflowGateInstance['schema'] = escalation.resumeSchema ?? {};

  const gateInstance: WorkflowGateInstance = {
    executionId: ctx.executionId,
    ...(ctx.executionAttemptId !== undefined ? { executionAttemptId: ctx.executionAttemptId } : {}),
    nodeId: node.id,
    frameId: parentFrameId,
    schema,
    prompt,
    status: 'waiting',
    autoAction: escalation.autoAction ?? 'reject',
    timeoutMs: escalation.timeoutMs ?? null,
    createdAt: Date.now(),
  };

  const requiresDurable = ctx.suspensionStrategy !== 'wait-in-process';
  await upsertGateInstance(call, ctx, gateInstance, requiresDurable);
  await ctx.updateFrame(call, parentFrameId, { status: 'waiting' }, { requireFrameStorage: requiresDurable });

  if (requiresDurable) {
    await emitGateSuspended(call, ctx, node, parentFrameId, schema, prompt, gateInstance.createdAt);
    return { status: 'paused', pausedAtGateId: node.id, pausedAtFrameId: parentFrameId };
  }

  return waitForInProcessResponse(call, node, ctx, parentFrameId, gateInstance, gateOutcome, rounds, bodyOutputs);
}

/**
 * Resolve an expired persisted loop escalation gate.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context.
 * @param node - Loop node with escalation config.
 * @param parentFrameId - Loop container frame ID used as the gate frame.
 * @param persistedGate - Waiting gate whose timeout deadline has elapsed.
 * @param gateOutcome - The escalation outcome for the loop output.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs collected so far.
 * @param storageRequired - Whether persisting the resolved gate is mandatory.
 * @returns Terminal outcome for the expired gate.
 */
async function resolveExpiredEscalationGate(
  call: CallContext,
  ctx: RuntimeContext,
  node: WorkflowLoopNode,
  parentFrameId: string,
  persistedGate: WorkflowGateInstance,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
  storageRequired = true,
): Promise<NodeOutcome> {
  const resolvedAt = Date.now();
  if (persistedGate.autoAction === 'approve') {
    const validation = validateGateResumeDataForSchema(node.id, persistedGate.schema, AUTO_APPROVE_TIMEOUT_RESUME_DATA);
    if (!validation.valid) {
      await upsertGateInstance(call, ctx, { ...persistedGate, status: 'timed-out', resolvedAt }, storageRequired);
      await emitGateResolved(call, ctx, node.id, parentFrameId, { action: 'reject', source: 'timeout' });
      return {
        status: 'failed',
        error: `Loop '${node.id}' escalation gate auto-approve timeout resume data does not match resumeSchema: ${validation.error}`,
      };
    }
    await upsertGateInstance(
      call,
      ctx,
      { ...persistedGate, status: 'resumed', resumeData: AUTO_APPROVE_TIMEOUT_RESUME_DATA, resolvedAt },
      storageRequired,
    );
    await emitGateResolved(call, ctx, node.id, parentFrameId, { action: 'approve', source: 'timeout' });
    return {
      status: 'completed',
      output: buildLoopOutput('escalate', rounds, gateOutcome, bodyOutputs, AUTO_APPROVE_TIMEOUT_RESUME_DATA),
    };
  }
  await upsertGateInstance(call, ctx, { ...persistedGate, status: 'timed-out', resolvedAt }, storageRequired);
  await emitGateResolved(call, ctx, node.id, parentFrameId, { action: 'reject', source: 'timeout' });
  return {
    status: 'failed',
    error: `Loop '${node.id}' escalation gate timed out after ${String(persistedGate.timeoutMs)}ms and auto-rejected`,
  };
}

/**
 * Resolve a persisted escalation gate instance on re-dispatch.
 *
 * Handles three sub-cases:
 * - Resolved gate (`resumed`/`rejected`) with valid `resumeData`: complete.
 * - Still-waiting gate: return `paused` so the runner exits.
 * - Unresumable status: fail.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context.
 * @param node - Loop node with escalation config.
 * @param parentFrameId - Loop container frame ID used as the gate frame.
 * @param gateOutcome - The escalation outcome for the loop output.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs collected so far.
 * @returns Terminal outcome, or `undefined` when no persisted gate exists.
 */
export async function resolvePersistedEscalationGate(
  call: CallContext,
  ctx: RuntimeContext,
  node: WorkflowLoopNode,
  parentFrameId: string,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
): Promise<NodeOutcome | undefined> {
  const persistedGate = await loadPersistedEscalationGate(call, ctx, node.id, parentFrameId);
  if (persistedGate === null) {
    return undefined;
  }

  if (
    (persistedGate.status === 'resumed' || persistedGate.status === 'rejected') &&
    persistedGate.resumeData !== undefined
  ) {
    const validation = validateGateResumeDataForSchema(node.id, persistedGate.schema, persistedGate.resumeData);
    if (!validation.valid) {
      return {
        status: 'failed',
        error: `Loop '${node.id}' escalation gate resumeData is invalid: ${validation.error}`,
      };
    }
    try {
      await ctx.bus.emit(call, WorkflowSubjects.gate.resumed, {
        executionId: ctx.executionId,
        frameId: parentFrameId,
        nodeId: node.id,
        resumeData: persistedGate.resumeData,
      });
    } catch (emitError) {
      console.error(`[LoopNode] gate.resumed emit failed for '${node.id}':`, emitError);
    }
    await emitGateResolved(call, ctx, node.id, parentFrameId, {
      action: persistedGate.status === 'rejected' ? 'reject' : 'approve',
      source: 'user',
      ...(persistedGate.reason !== undefined ? { reason: persistedGate.reason } : {}),
    });
    return {
      status: 'completed',
      output: buildLoopOutput('escalate', rounds, gateOutcome, bodyOutputs, persistedGate.resumeData),
    };
  }

  if (persistedGate.status === 'waiting') {
    if (persistedGate.timeoutMs !== null && Date.now() >= persistedGate.createdAt + persistedGate.timeoutMs) {
      return resolveExpiredEscalationGate(
        call,
        ctx,
        node,
        parentFrameId,
        persistedGate,
        gateOutcome,
        rounds,
        bodyOutputs,
      );
    }
    return { status: 'paused', pausedAtGateId: node.id, pausedAtFrameId: parentFrameId };
  }

  if (
    (persistedGate.status === 'resumed' || persistedGate.status === 'rejected') &&
    persistedGate.resumeData === undefined
  ) {
    return {
      status: 'failed',
      error: `Loop '${node.id}' escalation gate has status '${persistedGate.status}' but resumeData is missing`,
    };
  }

  return {
    status: 'failed',
    error: `Loop '${node.id}' escalation gate cannot resume from status '${persistedGate.status}'`,
  };
}
