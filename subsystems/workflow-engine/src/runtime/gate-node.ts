/* eslint max-lines: ["error", { "max": 410, "skipBlankLines": true, "skipComments": true }] */
import { NoHandlerError } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { resolveTemplate } from '@makaio/expression';
import type { ValidateFunction } from 'ajv';
import type { JsonValue, WorkflowGateInstance, WorkflowGateNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import {
  compileGateResumeValidator,
  validateGateResumeData,
  validateGateResumeDataForSchema,
} from './gate-resume-validation.js';
import { buildDeferred } from './deferred.js';
import {
  AUTO_APPROVE_TIMEOUT_RESUME_DATA,
  maybeReason,
  raceGateSuspension,
  type GatePersistenceOptions,
  type GateRaceResult,
  type GateUserResponse,
} from './gate-suspension.js';

// ─────────────────────────────────────────────────────────────
// Gate node output
// ─────────────────────────────────────────────────────────────

/**
 * JSON-serializable output produced by a completed gate node.
 *
 * Exposes the validated resume data so downstream code steps and agent steps
 * can reference it via the expression context (e.g., `frames.myGate.output.resumeData`).
 */
export interface GateNodeOutput {
  readonly resumeData: JsonValue;
}

/**
 * Apply the settled gate race result, persist the final gate instance, and
 * return the terminal node outcome.
 *
 * A user response settles with the call context of its `gate.respond` message;
 * timeout and cancellation have no such message and settle with the run's call.
 * @param runCall - Call context of the message that drives this execution run.
 * @param ctx - Runtime context for bus and storage.
 * @param node - Gate node used for stable identity and emitted lifecycle subjects.
 * @param frameId - Gate frame ID.
 * @param gateInstance - The waiting gate instance to update.
 * @param resumeValidator - Optional compiled validator for the gate's resume schema.
 * @param raceResult - Settled race result from {@link raceGateSuspension}.
 * @returns Terminal node outcome.
 */
async function settleGateOutcome(
  runCall: CallContext,
  ctx: RuntimeContext,
  node: WorkflowGateNode,
  frameId: string,
  gateInstance: WorkflowGateInstance,
  resumeValidator: ValidateFunction | undefined,
  raceResult: GateRaceResult,
): Promise<NodeOutcome> {
  const call = raceResult.call ?? runCall;
  const persist = { required: ctx.suspensionStrategy !== 'wait-in-process' };
  if (raceResult.timedOut) {
    const resolvedAt = Date.now();
    if (gateInstance.autoAction === 'approve') {
      const validation = validateGateResumeData(resumeValidator, AUTO_APPROVE_TIMEOUT_RESUME_DATA);
      if (!validation.valid) {
        await upsertGateInstance(call, ctx, { ...gateInstance, status: 'timed-out', resolvedAt }, persist);
        await emitGateResolved(call, ctx, node.id, frameId, { action: 'reject', source: 'timeout' });
        return {
          status: 'failed',
          error: `Gate '${node.id}' auto-approve timeout resume data does not match resumeSchema: ${validation.error}`,
        };
      }
      await upsertGateInstance(
        call,
        ctx,
        {
          ...gateInstance,
          status: 'resumed',
          resumeData: AUTO_APPROVE_TIMEOUT_RESUME_DATA,
          resolvedAt,
        },
        persist,
      );
      await emitGateResolved(call, ctx, node.id, frameId, { action: 'approve', source: 'timeout' });
      return { status: 'completed', output: { resumeData: AUTO_APPROVE_TIMEOUT_RESUME_DATA } };
    }
    await upsertGateInstance(call, ctx, { ...gateInstance, status: 'timed-out', resolvedAt }, persist);
    await emitGateResolved(call, ctx, node.id, frameId, { action: 'reject', source: 'timeout' });
    return {
      status: 'failed',
      error: `Gate '${node.id}' timed out after ${String(gateInstance.timeoutMs)}ms and auto-rejected`,
    };
  }
  if (raceResult.wasCancelled || ctx.signal.aborted) {
    await upsertGateInstance(call, ctx, { ...gateInstance, status: 'cancelled', resolvedAt: Date.now() }, persist);
    await emitGateResolved(call, ctx, node.id, frameId, { source: 'cancelled' });
    return { status: 'cancelled' };
  }
  const resolvedAt = Date.now();
  await upsertGateInstance(
    call,
    ctx,
    {
      ...gateInstance,
      status: raceResult.action === 'reject' ? 'rejected' : 'resumed',
      resumeData: raceResult.resumeData,
      ...maybeReason(raceResult.reason),
      resolvedAt,
    },
    persist,
  );
  try {
    await ctx.bus.emit(call, WorkflowSubjects.gate.resumed, {
      executionId: ctx.executionId,
      frameId,
      nodeId: node.id,
      resumeData: raceResult.resumeData,
    });
    // User reject is lifecycle metadata for approval surfaces. The gate still
    // resumes with typed domain data so workflows can handle rejections in
    // ordinary downstream logic instead of forcing every reject to fail.
    await emitGateResolved(call, ctx, node.id, frameId, {
      action: raceResult.action,
      source: 'user',
      ...maybeReason(raceResult.reason),
    });
  } catch (emitError) {
    console.error(`[GateNode] gate.resumed emit failed for '${node.id}':`, emitError);
  }
  const output: GateNodeOutput = { resumeData: raceResult.resumeData };
  return { status: 'completed', output };
}

// ─────────────────────────────────────────────────────────────
// Gate node executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute a `gate` node by suspending execution until a valid `gate.respond`
 * event arrives or the gate's timeout expires.
 *
 * **Lifecycle:**
 * 1. Build a {@link WorkflowGateInstance} and persist it via the storage bus.
 * 2. Set the frame status to `'waiting'`.
 * 3. For exit-based suspension, emit `workflow.gate.suspended` and return a
 *    paused outcome without registering an in-process response handler.
 * 4. For in-process suspension, register a one-shot `workflow.gate.respond`
 *    handler filtered to this gate, emit `workflow.gate.suspended`, and race
 *    the resume promise against the optional timeout promise.
 * 5a. On in-process user response: validate `resumeData`, update the gate instance,
 *     emit `workflow.gate.resumed`, and return a `completed` outcome.
 *     The separate approve/reject action is recorded for lifecycle/audit views;
 *     domain routing lives in the typed `resumeData`.
 * 5b. On timeout: update the gate instance to `'timed-out'` and return a `failed`
 *     outcome with a descriptive message.
 * 5c. On abort: update the gate instance to `'cancelled'` and return a `cancelled`
 *     outcome.
 *
 * **Respond handler ownership:**
 * The in-process `gate.respond` subscription is torn down as soon as the gate
 * resolves (resume, timeout, or abort). Exit-based parking never registers this
 * transient handler; parked responses must flow through the durable executor
 * path after the runner has returned `paused`.
 *
 * **Resume data validation:**
 * The gate node accepts any `JsonValue` when no `resumeSchema` is declared. If
 * a schema is present, matching `gate.respond` calls are validated before the
 * gate is accepted so persisted gate state, `gate.resumed`, and frame output
 * carry the same schema-conformant payload. Exit-based redispatch validates
 * already-parked gate rows against the schema captured in that persisted gate
 * instance; the current node schema only gates opening a new waiter.
 *
 * **Frame state:**
 * The gate node's frame is transitioned to `'waiting'` while suspended. The
 * `primitive-runtime.ts` sequence loop handles the final terminal transition
 * (`completed` / `failed` / `cancelled`) from the returned outcome.
 * @param call - Call context of the message that drives this execution run.
 * @param node - The gate node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Expression evaluation context used to render the gate prompt.
 * @param frameId - The gate node's own execution frame ID (forwarded by the dispatcher).
 * @returns Terminal execution outcome for this gate node.
 */
export async function executeGateNode(
  call: CallContext,
  node: WorkflowGateNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const schema: WorkflowGateInstance['schema'] = node.resumeSchema ?? {};

  // For exit-based suspension strategies, check whether a persisted gate row
  // already exists from a previous run (resume path) or indicates we were
  // previously parked here (re-entry path).
  if (ctx.suspensionStrategy !== 'wait-in-process') {
    const earlyOutcome = await resolvePersistedGate(call, ctx, node, frameId);
    if (earlyOutcome !== undefined) {
      return earlyOutcome;
    }
  }

  const resumeValidator = compileGateResumeValidator(node.id, node.resumeSchema);
  if (resumeValidator.status === 'failed') {
    return { status: 'failed', error: resumeValidator.error };
  }

  return suspendGateInProcess(call, ctx, node, expressionCtx, frameId, schema, resumeValidator.validator);
}

/**
 * Open a gate suspension: persist the gate instance, emit `gate.suspended`,
 * and either park the runner for exit-based strategies or wait on an
 * in-process response handler.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Execution-wide runtime context.
 * @param node - Gate node being suspended.
 * @param expressionCtx - Expression evaluation context for prompt rendering.
 * @param frameId - Gate frame ID.
 * @param schema - Resolved resume schema (empty object when absent).
 * @param validator - Compiled resume schema validator.
 * @returns Terminal node outcome.
 */
async function suspendGateInProcess(
  call: CallContext,
  ctx: RuntimeContext,
  node: WorkflowGateNode,
  expressionCtx: PrimitiveExpressionContext,
  frameId: string,
  schema: WorkflowGateInstance['schema'],
  validator: ValidateFunction | undefined,
): Promise<NodeOutcome> {
  const prompt = resolveTemplate(node.prompt, buildRuntimeExpressionScope(expressionCtx));
  const gateInstance: WorkflowGateInstance = {
    executionId: ctx.executionId,
    ...(ctx.executionAttemptId !== undefined ? { executionAttemptId: ctx.executionAttemptId } : {}),
    nodeId: node.id,
    frameId,
    schema,
    prompt,
    status: 'waiting',
    autoAction: node.autoAction,
    timeoutMs: node.timeoutMs,
    createdAt: Date.now(),
  };

  const requiresDurableParkingState = ctx.suspensionStrategy !== 'wait-in-process';
  await upsertGateInstance(call, ctx, gateInstance, { required: requiresDurableParkingState });
  await ctx.updateFrame(call, frameId, { status: 'waiting' }, { requireFrameStorage: requiresDurableParkingState });

  // Exit-based gates are not owned by the in-process deferred response path.
  // Registering a local respond handler before emitting suspension would let a
  // synchronous listener accept a response before the runner has durably parked.
  if (requiresDurableParkingState) {
    await emitGateSuspended(call, ctx, node, frameId, schema, prompt, gateInstance.createdAt);
    return { status: 'paused', pausedAtGateId: node.id, pausedAtFrameId: frameId };
  }

  // The pending flag ensures at-most-once resolution.
  const pending = { value: true };
  const deferred = buildDeferred<GateUserResponse>();

  const unsubRespond = ctx.bus.on(WorkflowSubjects.gate.respond, async (respondCtx) => {
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
      (respondFrameId !== undefined && respondFrameId !== frameId)
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

  await emitGateSuspended(call, ctx, node, frameId, schema, prompt, gateInstance.createdAt);

  const raceResult = await raceGateSuspension(deferred, pending, ctx.signal, node.timeoutMs);
  unsubRespond();

  return settleGateOutcome(call, ctx, node, frameId, gateInstance, validator, raceResult);
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Emit the gate-suspended event with the rendered approval prompt.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context providing execution identity and bus access.
 * @param node - Gate node being suspended.
 * @param frameId - Runtime frame identifier for this gate instance.
 * @param schema - JSON Schema shown to gate responders.
 * @param prompt - Rendered prompt shown to the reviewer.
 * @param openedAt - Epoch milliseconds when the gate opened.
 */
async function emitGateSuspended(
  call: CallContext,
  ctx: RuntimeContext,
  node: WorkflowGateNode,
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
      ...(node.title !== undefined && { title: node.title }),
      autoAction: node.autoAction,
      timeoutMs: node.timeoutMs,
      openedAt,
    });
  } catch (emitError) {
    console.error(`[GateNode] gate.suspended emit failed for '${node.id}':`, emitError);
  }
}

/**
 * Load a persisted gate instance for exit-strategy resume paths.
 *
 * Returns `null` when no handler is registered (e.g., in-process test
 * environments without storage) or when no row exists for the given key.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context providing bus access and execution identity.
 * @param nodeId - Gate node identifier.
 * @param frameId - Frame ID for this gate instance.
 * @returns The persisted gate instance, or `null` when absent.
 */
async function loadGateInstance(
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

/**
 * Check a persisted gate instance and derive a terminal outcome for re-dispatch
 * or resume runs, or `undefined` when no early exit applies (fresh run).
 *
 * Handles three sub-cases:
 * - Resolved gate (`resumed`/`rejected`) with valid `resumeData`: complete immediately.
 * - Still-waiting gate past its timeout deadline: apply the same timeout
 *   outcome as the in-process race.
 * - Still-waiting gate before its deadline: return `paused` so the runner exits
 *   without re-opening.
 * - Gate in an unresumable status (e.g. `timed-out`, `cancelled`): fail fast.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context providing bus and execution identity.
 * @param node - Gate node being executed.
 * @param frameId - Frame ID for this gate instance.
 * @returns A terminal {@link NodeOutcome} when an early exit applies, or `undefined`
 *   when no persisted row exists and the gate should open fresh.
 */
async function resolvePersistedGate(
  call: CallContext,
  ctx: RuntimeContext,
  node: WorkflowGateNode,
  frameId: string,
): Promise<NodeOutcome | undefined> {
  const persistedGate = await loadGateInstance(call, ctx, node.id, frameId);
  if (
    (persistedGate?.status === 'resumed' || persistedGate?.status === 'rejected') &&
    persistedGate.resumeData !== undefined
  ) {
    const validation = validateGateResumeDataForSchema(node.id, persistedGate.schema, persistedGate.resumeData);
    if (!validation.valid) {
      return {
        status: 'failed',
        error: `Gate '${node.id}' persisted resumeData is invalid: ${validation.error}`,
      };
    }
    try {
      await ctx.bus.emit(call, WorkflowSubjects.gate.resumed, {
        executionId: ctx.executionId,
        frameId,
        nodeId: node.id,
        resumeData: persistedGate.resumeData,
      });
    } catch (emitError) {
      console.error(`[GateNode] gate.resumed emit failed for '${node.id}':`, emitError);
    }
    await emitGateResolved(call, ctx, node.id, frameId, {
      action: persistedGate.status === 'rejected' ? 'reject' : 'approve',
      source: 'user',
      ...maybeReason(persistedGate.reason),
    });
    return { status: 'completed', output: { resumeData: persistedGate.resumeData } };
  }
  if (persistedGate?.status === 'waiting') {
    if (persistedGate.timeoutMs !== null && Date.now() >= persistedGate.createdAt + persistedGate.timeoutMs) {
      const resumeValidator = compileGateResumeValidator(node.id, persistedGate.schema);
      if (resumeValidator.status === 'failed') {
        return { status: 'failed', error: resumeValidator.error };
      }
      return settleGateOutcome(call, ctx, node, frameId, persistedGate, resumeValidator.validator, {
        action: 'reject',
        resumeData: null,
        timedOut: true,
        wasCancelled: false,
      });
    }
    return { status: 'paused', pausedAtGateId: node.id, pausedAtFrameId: frameId };
  }
  if (
    (persistedGate?.status === 'resumed' || persistedGate?.status === 'rejected') &&
    persistedGate.resumeData === undefined
  ) {
    // The gate status indicates it was resumed or rejected, but the resume
    // payload was not stored. This is a data integrity problem — surface a
    // precise error instead of the misleading "cannot resume from status"
    // catch-all.
    return {
      status: 'failed',
      error: `Gate '${node.id}' has status '${persistedGate.status}' but resumeData is missing — cannot reconstruct output`,
    };
  }
  if (persistedGate !== null) {
    // Gate row exists but is in an unresumable status (e.g. 'timed-out' or 'cancelled').
    return {
      status: 'failed',
      error: `Gate '${node.id}' cannot resume from status '${persistedGate.status}'`,
    };
  }
  return undefined;
}

/**
 * Upsert a gate instance record via the storage bus.
 *
 * Errors are downgraded to console warnings in optional persistence paths so
 * unit tests and wait-in-process runs without storage can still execute. Exit-
 * based parking paths pass `required: true` because a paused remote run cannot
 * be resumed safely without the durable waiting gate row.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Runtime context providing the bus.
 * @param gate - Gate instance to upsert.
 * @param options - Persistence behavior for this write.
 */
async function upsertGateInstance(
  call: CallContext,
  ctx: RuntimeContext,
  gate: WorkflowGateInstance,
  options: GatePersistenceOptions = {},
): Promise<void> {
  try {
    if (options.required === true) {
      await ctx.bus.request(call, WorkflowStorageSubjects.setGateInstance, { gate });
    } else {
      await ctx.bus.requestOptional(call, WorkflowStorageSubjects.setGateInstance, { gate });
    }
  } catch (error) {
    if (options.required === true) {
      throw error;
    }
    console.warn(`[GateNode] Failed to upsert gate instance for '${gate.nodeId}':`, error);
  }
}

/**
 * Emit the gate-resolved lifecycle event for UI consumers that close approval
 * surfaces after a concrete gate frame has settled.
 * @param call - Call context of the message that caused the resolution.
 * @param ctx - Runtime context providing execution identity and bus access.
 * @param gateId - Gate node identifier.
 * @param frameId - Runtime frame identifier for this gate instance.
 * @param resolution - Resolution metadata. Cancellation has no approval action
 * because the workflow never resumed with user or timeout data.
 */
async function emitGateResolved(
  call: CallContext,
  ctx: RuntimeContext,
  gateId: string,
  frameId: string,
  resolution:
    | { readonly action: 'approve' | 'reject'; readonly source: 'user'; readonly reason?: string }
    | { readonly action: 'approve' | 'reject'; readonly source: 'timeout' }
    | { readonly source: 'cancelled' },
): Promise<void> {
  try {
    await ctx.bus.emit(call, WorkflowSubjects.gate.resolved, {
      executionId: ctx.executionId,
      stepId: gateId,
      stepType: 'gate',
      frameId,
      ...resolution,
    });
  } catch (error) {
    console.error(`[GateNode] gate.resolved emit failed for '${gateId}':`, error);
  }
}
