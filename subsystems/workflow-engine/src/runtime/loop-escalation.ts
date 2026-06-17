import { NoHandlerError } from '@makaio/bus-core';
import { resolveTemplate } from '@makaio/expression';
import type { JsonValue, LoopGateOutcome, WorkflowGateInstance, WorkflowLoopNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
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

// -----------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------

/** User response payload shape for escalation gate responses. */
interface EscalationGateResponse {
  readonly action: 'approve' | 'reject';
  readonly resumeData: JsonValue;
  readonly reason?: string;
}

/** Resume payload produced when a loop escalation timeout auto-approves. */
const AUTO_APPROVE_TIMEOUT_RESUME_DATA = { action: 'approve', source: 'timeout' } as const satisfies JsonValue;

// -----------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------

/**
 * Upsert a gate instance record via the storage bus.
 *
 * Mirrors the gate-node pattern: exit-based parking requires durable
 * persistence; in-process tests downgrade errors to warnings.
 * @param ctx - Runtime context providing the bus.
 * @param gate - Gate instance to upsert.
 * @param required - Whether storage failure should throw.
 */
async function upsertGateInstance(ctx: RuntimeContext, gate: WorkflowGateInstance, required: boolean): Promise<void> {
  try {
    if (required) {
      await ctx.bus.request(WorkflowStorageSubjects.setGateInstance, { gate });
    } else {
      await ctx.bus.requestOptional(WorkflowStorageSubjects.setGateInstance, { gate });
    }
  } catch (error) {
    if (required) throw error;
    console.warn(`[LoopNode] Failed to upsert escalation gate for '${gate.nodeId}':`, error);
  }
}

/**
 * Emit the gate-suspended event for a loop escalation gate.
 * @param ctx - Runtime context.
 * @param node - Loop node whose escalation gate is being opened.
 * @param frameId - Frame ID used as the gate frame identity.
 * @param schema - JSON Schema for the resume data payload.
 * @param prompt - Rendered escalation prompt.
 * @param openedAt - Epoch milliseconds when the gate opened.
 */
async function emitGateSuspended(
  ctx: RuntimeContext,
  node: WorkflowLoopNode,
  frameId: string,
  schema: WorkflowGateInstance['schema'],
  prompt: string,
  openedAt: number,
): Promise<void> {
  try {
    await ctx.bus.emit(WorkflowSubjects.gate.suspended, {
      executionId: ctx.executionId,
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
 * @param ctx - Runtime context.
 * @param nodeId - Loop node identifier.
 * @param frameId - Frame identifier.
 * @param resolution - Resolution metadata.
 */
async function emitGateResolved(
  ctx: RuntimeContext,
  nodeId: string,
  frameId: string,
  resolution:
    | { readonly action: 'approve' | 'reject'; readonly source: 'user'; readonly reason?: string }
    | { readonly action: 'approve' | 'reject'; readonly source: 'timeout' }
    | { readonly source: 'cancelled' },
): Promise<void> {
  try {
    await ctx.bus.emit(WorkflowSubjects.gate.resolved, {
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

// -----------------------------------------------------------------
// In-process gate suspension
// -----------------------------------------------------------------

/**
 * Wait for an in-process `gate.respond` and settle the escalation gate.
 *
 * Registers a one-shot respond handler, races the deferred response
 * against the abort signal, and returns the terminal loop outcome.
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

  const unsubRespond = ctx.bus.on(WorkflowSubjects.gate.respond, async (respondCtx) => {
    const { executionId, gateId, frameId: respondFrameId, action, resumeData, reason } = respondCtx.payload;
    if (
      executionId !== ctx.executionId ||
      gateId !== node.id ||
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
    const validation = validateGateResumeData(resumeValidator.validator, resumeData as JsonValue);
    if (!validation.valid) {
      respondCtx.setResult({ accepted: false });
      return;
    }
    pending.value = false;
    respondCtx.setResult({ accepted: true });
    deferred.resolve({ action, resumeData: resumeData as JsonValue, reason });
  });

  await emitGateSuspended(
    ctx,
    node,
    parentFrameId,
    gateInstance.schema,
    gateInstance.prompt ?? '',
    gateInstance.createdAt,
  );

  const abortHandler = (): void => {
    if (!pending.value) return;
    pending.value = false;
    deferred.reject('cancelled');
  };
  ctx.signal.addEventListener('abort', abortHandler, { once: true });
  if (ctx.signal.aborted) abortHandler();

  let response: EscalationGateResponse;
  try {
    response = await deferred.promise;
  } catch {
    unsubRespond();
    ctx.signal.removeEventListener('abort', abortHandler);
    await upsertGateInstance(ctx, { ...gateInstance, status: 'cancelled', resolvedAt: Date.now() }, false);
    await emitGateResolved(ctx, node.id, parentFrameId, { source: 'cancelled' });
    return { status: 'cancelled' };
  }

  unsubRespond();
  ctx.signal.removeEventListener('abort', abortHandler);

  return settleInProcessResponse(ctx, node.id, parentFrameId, gateInstance, response, gateOutcome, rounds, bodyOutputs);
}

/**
 * Persist the resolved gate state and emit lifecycle events after an
 * in-process escalation gate response.
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
    await ctx.bus.emit(WorkflowSubjects.gate.resumed, {
      executionId: ctx.executionId,
      frameId,
      nodeId,
      resumeData: response.resumeData,
    });
    await emitGateResolved(ctx, nodeId, frameId, {
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
 *   and waits for the response or cancellation
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
  await upsertGateInstance(ctx, gateInstance, requiresDurable);
  await ctx.updateFrame(parentFrameId, { status: 'waiting' }, { requireFrameStorage: requiresDurable });

  if (requiresDurable) {
    await emitGateSuspended(ctx, node, parentFrameId, schema, prompt, gateInstance.createdAt);
    return { status: 'paused', pausedAtGateId: node.id, pausedAtFrameId: parentFrameId };
  }

  return waitForInProcessResponse(node, ctx, parentFrameId, gateInstance, gateOutcome, rounds, bodyOutputs);
}

/**
 * Resolve an expired persisted loop escalation gate.
 * @param ctx - Runtime context.
 * @param node - Loop node with escalation config.
 * @param parentFrameId - Loop container frame ID used as the gate frame.
 * @param persistedGate - Waiting gate whose timeout deadline has elapsed.
 * @param gateOutcome - The escalation outcome for the loop output.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs collected so far.
 * @returns Terminal outcome for the expired gate.
 */
async function resolveExpiredEscalationGate(
  ctx: RuntimeContext,
  node: WorkflowLoopNode,
  parentFrameId: string,
  persistedGate: WorkflowGateInstance,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
): Promise<NodeOutcome> {
  const resolvedAt = Date.now();
  if (persistedGate.autoAction === 'approve') {
    const validation = validateGateResumeDataForSchema(node.id, persistedGate.schema, AUTO_APPROVE_TIMEOUT_RESUME_DATA);
    if (!validation.valid) {
      await upsertGateInstance(ctx, { ...persistedGate, status: 'timed-out', resolvedAt }, true);
      await emitGateResolved(ctx, node.id, parentFrameId, { action: 'reject', source: 'timeout' });
      return {
        status: 'failed',
        error: `Loop '${node.id}' escalation gate auto-approve timeout resume data does not match resumeSchema: ${validation.error}`,
      };
    }
    await upsertGateInstance(
      ctx,
      { ...persistedGate, status: 'resumed', resumeData: AUTO_APPROVE_TIMEOUT_RESUME_DATA, resolvedAt },
      true,
    );
    await emitGateResolved(ctx, node.id, parentFrameId, { action: 'approve', source: 'timeout' });
    return {
      status: 'completed',
      output: buildLoopOutput('escalate', rounds, gateOutcome, bodyOutputs, AUTO_APPROVE_TIMEOUT_RESUME_DATA),
    };
  }
  await upsertGateInstance(ctx, { ...persistedGate, status: 'timed-out', resolvedAt }, true);
  await emitGateResolved(ctx, node.id, parentFrameId, { action: 'reject', source: 'timeout' });
  return {
    status: 'failed',
    error: `Loop '${node.id}' escalation gate timed out after ${String(persistedGate.timeoutMs)}ms and auto-rejected`,
  };
}

/**
 * Load a persisted escalation gate instance for exit-strategy resume paths.
 * @param ctx - Runtime context.
 * @param nodeId - Loop node identifier.
 * @param frameId - Frame ID for the gate instance.
 * @returns The persisted gate instance, or `null` when absent.
 */
async function loadPersistedEscalationGate(
  ctx: RuntimeContext,
  nodeId: string,
  frameId: string,
): Promise<WorkflowGateInstance | null> {
  if (ctx.suspensionStrategy !== 'wait-in-process') {
    const result = await ctx.bus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: ctx.executionId,
      nodeId,
      frameId,
    });
    return result.gate;
  }

  const result = await ctx.bus.requestOptional(WorkflowStorageSubjects.getGateInstance, {
    executionId: ctx.executionId,
    nodeId,
    frameId,
  });
  return result.handled ? result.data.gate : null;
}

/**
 * Resolve a persisted escalation gate instance on re-dispatch.
 *
 * Handles three sub-cases:
 * - Resolved gate (`resumed`/`rejected`) with valid `resumeData`: complete.
 * - Still-waiting gate: return `paused` so the runner exits.
 * - Unresumable status: fail.
 * @param ctx - Runtime context.
 * @param node - Loop node with escalation config.
 * @param parentFrameId - Loop container frame ID used as the gate frame.
 * @param gateOutcome - The escalation outcome for the loop output.
 * @param rounds - Total rounds completed (1-based).
 * @param bodyOutputs - Per-round body outputs collected so far.
 * @returns Terminal outcome, or `undefined` when no persisted gate exists.
 */
export async function resolvePersistedEscalationGate(
  ctx: RuntimeContext,
  node: WorkflowLoopNode,
  parentFrameId: string,
  gateOutcome: LoopGateOutcome,
  rounds: number,
  bodyOutputs: readonly JsonValue[],
): Promise<NodeOutcome | undefined> {
  const persistedGate = await loadPersistedEscalationGate(ctx, node.id, parentFrameId);
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
      await ctx.bus.emit(WorkflowSubjects.gate.resumed, {
        executionId: ctx.executionId,
        frameId: parentFrameId,
        nodeId: node.id,
        resumeData: persistedGate.resumeData,
      });
    } catch (emitError) {
      console.error(`[LoopNode] gate.resumed emit failed for '${node.id}':`, emitError);
    }
    await emitGateResolved(ctx, node.id, parentFrameId, {
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
      return resolveExpiredEscalationGate(ctx, node, parentFrameId, persistedGate, gateOutcome, rounds, bodyOutputs);
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
