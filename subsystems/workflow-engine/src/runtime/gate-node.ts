import { NoHandlerError } from '@makaio/bus-core';
import { resolveTemplate } from '@makaio/expression';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { JsonValue, WorkflowGateInstance, WorkflowGateNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';

// ─────────────────────────────────────────────────────────────
// Gate node output
// ─────────────────────────────────────────────────────────────

/**
 * JSON-serializable output produced by a completed gate node.
 *
 * Exposes the validated resume data so downstream station and delegate nodes
 * can reference it via the expression context (e.g., `frames.myGate.output.resumeData`).
 */
export interface GateNodeOutput {
  readonly resumeData: JsonValue;
}

// ─────────────────────────────────────────────────────────────
// Internal gate suspension helpers
// ─────────────────────────────────────────────────────────────

/**
 * Result type from {@link raceGateSuspension}.
 */
interface GateRaceResult {
  readonly action: 'approve' | 'reject';
  readonly resumeData: JsonValue;
  readonly timedOut: boolean;
  readonly wasCancelled: boolean;
}

/** User response payload accepted by the gate suspension race. */
interface GateUserResponse {
  readonly action: 'approve' | 'reject';
  readonly resumeData: JsonValue;
}

/** Resume payload produced when a gate timeout auto-approves. */
const AUTO_APPROVE_TIMEOUT_RESUME_DATA = { action: 'approve', source: 'timeout' } as const satisfies JsonValue;

/** JSON Schema validator used for persisted gate resume contracts. */
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Race the gate resume promise against an optional timeout and abort signal.
 *
 * Sets up the abort handler and optional timeout, races the promises, and
 * returns the settled result so the caller can apply the correct gate outcome
 * without duplicating the try-catch / cleanup pattern.
 * @param deferred - The resume deferred promise to race.
 * @param pending - Mutable at-most-once flag shared with the respond handler.
 * @param signal - Cancellation signal.
 * @param timeoutMs - Optional timeout in milliseconds (`null` means no timeout).
 * @returns Settled race result indicating resume data, timeout, or cancellation.
 */
async function raceGateSuspension(
  deferred: Deferred<GateUserResponse>,
  pending: { value: boolean },
  signal: AbortSignal,
  timeoutMs: number | null,
): Promise<GateRaceResult> {
  const abortHandler = (): void => {
    if (!pending.value) return;
    pending.value = false;
    deferred.reject('cancelled');
  };
  signal.addEventListener('abort', abortHandler, { once: true });
  if (signal.aborted) {
    abortHandler();
  }

  const racePromises: Promise<GateUserResponse>[] = [deferred.promise];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs !== null) {
    const timeoutDeferred = buildDeferred<GateUserResponse>();
    timeoutHandle = setTimeout(() => {
      if (!pending.value) return;
      pending.value = false;
      signal.removeEventListener('abort', abortHandler);
      timeoutDeferred.reject('timed-out');
    }, timeoutMs);
    racePromises.push(timeoutDeferred.promise);
  }

  try {
    const response = await Promise.race(racePromises);
    signal.removeEventListener('abort', abortHandler);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    return { action: response.action, resumeData: response.resumeData, timedOut: false, wasCancelled: false };
  } catch (reason) {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', abortHandler);
    if (reason === 'timed-out') {
      return { action: 'reject', resumeData: null, timedOut: true, wasCancelled: false };
    }
    return { action: 'reject', resumeData: null, timedOut: false, wasCancelled: true };
  }
}

/**
 * Apply the settled gate race result, persist the final gate instance, and
 * return the terminal node outcome.
 * @param ctx - Runtime context for bus and storage.
 * @param node - Gate node (id, timeoutMs used for messages and persistence).
 * @param frameId - Gate frame ID.
 * @param gateInstance - The waiting gate instance to update.
 * @param resumeValidator - Optional compiled validator for the gate's resume schema.
 * @param raceResult - Settled race result from {@link raceGateSuspension}.
 * @returns Terminal node outcome.
 */
async function settleGateOutcome(
  ctx: RuntimeContext,
  node: WorkflowGateNode,
  frameId: string,
  gateInstance: WorkflowGateInstance,
  resumeValidator: ValidateFunction | undefined,
  raceResult: GateRaceResult,
): Promise<NodeOutcome> {
  if (raceResult.timedOut) {
    const resolvedAt = Date.now();
    if (node.autoAction === 'approve') {
      const validation = validateGateResumeData(resumeValidator, AUTO_APPROVE_TIMEOUT_RESUME_DATA);
      if (!validation.valid) {
        await upsertGateInstance(ctx, { ...gateInstance, status: 'timed-out', resolvedAt });
        await emitGateResolved(ctx, node.id, frameId, { action: 'reject', source: 'timeout' });
        return {
          status: 'failed',
          error: `Gate '${node.id}' auto-approve timeout resume data does not match resumeSchema: ${validation.error}`,
        };
      }
      await upsertGateInstance(ctx, {
        ...gateInstance,
        status: 'resumed',
        resumeData: AUTO_APPROVE_TIMEOUT_RESUME_DATA,
        resolvedAt,
      });
      await emitGateResolved(ctx, node.id, frameId, { action: 'approve', source: 'timeout' });
      return { status: 'completed', output: { resumeData: AUTO_APPROVE_TIMEOUT_RESUME_DATA } };
    }
    await upsertGateInstance(ctx, { ...gateInstance, status: 'timed-out', resolvedAt });
    await emitGateResolved(ctx, node.id, frameId, { action: 'reject', source: 'timeout' });
    return {
      status: 'failed',
      error: `Gate '${node.id}' timed out after ${String(node.timeoutMs)}ms and auto-rejected`,
    };
  }
  if (raceResult.wasCancelled || ctx.signal.aborted) {
    await upsertGateInstance(ctx, { ...gateInstance, status: 'cancelled', resolvedAt: Date.now() });
    await emitGateResolved(ctx, node.id, frameId, { source: 'cancelled' });
    return { status: 'cancelled' };
  }
  const resolvedAt = Date.now();
  await upsertGateInstance(ctx, {
    ...gateInstance,
    status: raceResult.action === 'reject' ? 'rejected' : 'resumed',
    resumeData: raceResult.resumeData,
    resolvedAt,
  });
  try {
    await ctx.bus.emit(WorkflowSubjects.gate.resumed, {
      executionId: ctx.executionId,
      frameId,
      nodeId: node.id,
      resumeData: raceResult.resumeData,
    });
    // User reject is lifecycle metadata for approval surfaces. The gate still
    // resumes with typed domain data so workflows can handle rejections in
    // ordinary downstream logic instead of forcing every reject to fail.
    await emitGateResolved(ctx, node.id, frameId, { action: raceResult.action, source: 'user' });
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
 * 2. Register a one-shot `workflow.gate.respond` handler filtered to this gate.
 * 3. Set the frame status to `'waiting'` and emit `workflow.gate.suspended`.
 * 4. Race the resume promise against the optional timeout promise.
 * 5a. On user response: validate `resumeData`, update the gate instance,
 *     emit `workflow.gate.resumed`, and return a `completed` outcome.
 *     The separate approve/reject action is recorded for lifecycle/audit views;
 *     domain routing lives in the typed `resumeData`.
 * 5b. On timeout: update the gate instance to `'timed-out'` and return a `failed`
 *     outcome with a descriptive message.
 * 5c. On abort: update the gate instance to `'cancelled'` and return a `cancelled`
 *     outcome.
 *
 * **Respond handler ownership:**
 * The `gate.respond` subscription is torn down as soon as the gate resolves
 * (resume, timeout, or abort). The handler returns `{ accepted: false }` for
 * any response arriving after the gate has already resolved.
 *
 * **Resume data validation:**
 * The gate node accepts any `JsonValue` when no `resumeSchema` is declared. If
 * a schema is present, matching `gate.respond` calls are validated before the
 * gate is accepted so persisted gate state, `gate.resumed`, and frame output
 * carry the same schema-conformant payload.
 *
 * **Frame state:**
 * The gate node's frame is transitioned to `'waiting'` while suspended. The
 * `primitive-runtime.ts` sequence loop handles the final terminal transition
 * (`completed` / `failed` / `cancelled`) from the returned outcome.
 * @param node - The gate node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Expression evaluation context used to render the gate prompt.
 * @param frameId - The gate node's own execution frame ID (forwarded by the dispatcher).
 * @returns Terminal execution outcome for this gate node.
 */
export async function executeGateNode(
  node: WorkflowGateNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const schema: WorkflowGateInstance['schema'] = node.resumeSchema ?? {};
  const resumeValidator = compileGateResumeValidator(node);
  if (resumeValidator.status === 'failed') {
    return { status: 'failed', error: resumeValidator.error };
  }
  const prompt = resolveTemplate(node.prompt, buildRuntimeExpressionScope(expressionCtx));
  const gateInstance: WorkflowGateInstance = {
    executionId: ctx.executionId,
    nodeId: node.id,
    frameId,
    schema,
    prompt,
    status: 'waiting',
    createdAt: Date.now(),
  };

  await upsertGateInstance(ctx, gateInstance);
  await ctx.updateFrame(frameId, { status: 'waiting' });

  // The pending flag ensures at-most-once resolution.
  const pending = { value: true };
  const deferred = buildDeferred<GateUserResponse>();

  const unsubRespond = ctx.bus.on(WorkflowSubjects.gate.respond, async (respondCtx) => {
    const { executionId, gateId, frameId: respondFrameId, action, resumeData } = respondCtx.payload;
    if (executionId !== ctx.executionId || gateId !== node.id) {
      try {
        await respondCtx.next();
      } catch (e) {
        if (e instanceof NoHandlerError) respondCtx.setResult({ accepted: false });
        else throw e;
      }
      return;
    }
    if (respondFrameId !== undefined && respondFrameId !== frameId) {
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
    deferred.resolve({ action, resumeData: resumeData as JsonValue });
  });

  await emitGateSuspended(ctx, node, frameId, schema, prompt, gateInstance.createdAt);

  const raceResult = await raceGateSuspension(deferred, pending, ctx.signal, node.timeoutMs);
  unsubRespond();

  return settleGateOutcome(ctx, node, frameId, gateInstance, resumeValidator.validator, raceResult);
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Lightweight deferred promise pair.
 *
 * Encapsulates a Promise together with its `resolve` and `reject` callbacks so
 * they can be called from outside the Promise constructor body without relying
 * on definite-assignment assertions.
 * @typeParam T - The resolved value type.
 */
interface Deferred<T> {
  /** The underlying promise. */
  readonly promise: Promise<T>;
  /** Resolve the promise with `value`. */
  readonly resolve: (value: T) => void;
  /** Reject the promise with `reason`. */
  readonly reject: (reason: string) => void;
}

/**
 * Create a {@link Deferred} promise pair.
 * @typeParam T - The resolved value type.
 * @returns A deferred promise with external resolve/reject handles.
 */
function buildDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: string) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Emit the gate-suspended event with the rendered approval prompt.
 * @param ctx - Runtime context providing execution identity and bus access.
 * @param node - Gate node being suspended.
 * @param frameId - Runtime frame identifier for this gate instance.
 * @param schema - JSON Schema shown to gate responders.
 * @param prompt - Rendered prompt shown to the reviewer.
 * @param openedAt - Epoch milliseconds when the gate opened.
 */
async function emitGateSuspended(
  ctx: RuntimeContext,
  node: WorkflowGateNode,
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
 * Compile a gate node's JSON Schema once before the gate is opened.
 * @param node - Gate node carrying the optional resume schema.
 * @returns Compiled validator, or a failed result for invalid schema documents.
 */
function compileGateResumeValidator(
  node: WorkflowGateNode,
):
  | { readonly status: 'ok'; readonly validator?: ValidateFunction }
  | { readonly status: 'failed'; readonly error: string } {
  if (node.resumeSchema === undefined) {
    return { status: 'ok' };
  }
  try {
    return { status: 'ok', validator: ajv.compile(node.resumeSchema) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', error: `Gate '${node.id}' has an invalid resumeSchema: ${message}` };
  }
}

/**
 * Validate resume data against a compiled gate resume schema, when declared.
 * @param validator - Compiled JSON Schema validator, if the gate declared one.
 * @param resumeData - Submitted resume payload.
 * @returns Validation outcome and a human-readable error when invalid.
 */
function validateGateResumeData(
  validator: ValidateFunction | undefined,
  resumeData: JsonValue,
): { readonly valid: true } | { readonly valid: false; readonly error: string } {
  if (validator === undefined) {
    return { valid: true };
  }
  if (validator(resumeData)) {
    return { valid: true };
  }
  return { valid: false, error: formatAjvErrors(validator.errors ?? []) };
}

/**
 * Format AJV errors into a compact message suitable for node failure output.
 * @param errors - AJV validation errors.
 * @returns Joined validation error summary.
 */
function formatAjvErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) {
    return 'schema validation failed';
  }
  return errors
    .map((error) => {
      const path = error.instancePath.length > 0 ? error.instancePath : '/';
      return `${path} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

/**
 * Upsert a gate instance record via the storage bus.
 *
 * Errors are downgraded to console warnings so a missing or failing storage
 * handler (e.g., in unit tests without a DB) does not abort execution. Gate
 * instances are an observability aid — their absence must not break execution
 * flow.
 * @param ctx - Runtime context providing the bus.
 * @param gate - Gate instance to upsert.
 */
async function upsertGateInstance(ctx: RuntimeContext, gate: WorkflowGateInstance): Promise<void> {
  try {
    await ctx.bus.requestOptional(WorkflowStorageSubjects.setGateInstance, { gate });
  } catch (error) {
    console.warn(`[GateNode] Failed to upsert gate instance for '${gate.nodeId}':`, error);
  }
}

/**
 * Emit the gate-resolved lifecycle event for UI consumers that close approval
 * surfaces after a concrete gate frame has settled.
 * @param ctx - Runtime context providing execution identity and bus access.
 * @param gateId - Gate node identifier.
 * @param frameId - Runtime frame identifier for this gate instance.
 * @param resolution - Resolution metadata. Cancellation has no approval action
 * because the workflow never resumed with user or timeout data.
 */
async function emitGateResolved(
  ctx: RuntimeContext,
  gateId: string,
  frameId: string,
  resolution:
    | { readonly action: 'approve' | 'reject'; readonly source: 'user' | 'timeout' }
    | { readonly source: 'cancelled' },
): Promise<void> {
  try {
    await ctx.bus.emit(WorkflowSubjects.gate.resolved, {
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
