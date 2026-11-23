import type { CallContext } from '@makaio/core';
import {
  SubagentSubjects,
  createWorkflowDelegateResultFinalizerNamespace,
  type AwaitSubagentResponse,
  type JsonValue,
  type ResponseSchemaDescriptor,
  type WorkflowDelegateToolObservation,
  type WorkflowResolvedRole,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import type { RuntimeContext } from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { buildDelegateEconomics } from './delegate-economics.js';

type ResolvedSubagentAwaitResult = { handled: true; data: AwaitSubagentResponse } | { handled: false };
type ChildStatusResult = { handled: true; data: { childSessionId?: string } } | { handled: false };

// Best-effort session linking uses a short pre-await polling window; a final
// single status check runs after await for slow child session creation.
const SESSION_LINK_POLL_ATTEMPTS = 5;
const SESSION_LINK_POLL_DELAY_MS = 20;
const SESSION_LINK_POLL_TIMEOUT_MS = 25;

export interface ExecuteResolvedSubagentNodeParams {
  /** Node identifier used in diagnostics and child cancellation reasons. */
  readonly nodeId: string;
  /** Human-readable node type label, e.g. `Agent step`. */
  readonly nodeLabel: string;
  /** Fully resolved task prompt for the child subagent. */
  readonly task: string;
  /** Resolved adapter/model/provider configuration for the child subagent. */
  readonly resolvedConfig: WorkflowResolvedRole;
  /** Optional structured-output schema forwarded to the subagent runtime. */
  readonly outputSchema?: ResponseSchemaDescriptor;
  /** Optional await timeout for the spawned subagent. */
  readonly timeoutMs?: number;
  /** Error emitted when the subagent spawn subject has no runtime handler. */
  readonly unavailableRuntimeError: string;
  /** Error emitted when the subagent await subject has no runtime handler. */
  readonly unavailableAwaitError: string;
  /** Label included in best-effort child cancellation reasons. */
  readonly cancellationLabel: string;
  /** Runtime frame that owns the spawned child session. */
  readonly frameId?: string;
  /** Authority-owned finalizer selected by the serialized agent step node. */
  readonly resultFinalizerId?: string;
}

/** Identity and authority policy for one delegate result finalization. */
export interface DelegateResultFinalizationParams {
  /** Agent step node identifier. */
  readonly nodeId: string;
  /** Runtime frame that owns the delegate. */
  readonly frameId?: string;
  /** Authority-owned finalizer selected by the serialized agent step node. */
  readonly resultFinalizerId?: string;
  /** Actual resolved runtime binding used for this delegate execution. */
  readonly resolvedConfig?: WorkflowResolvedRole;
  /** Authoritative child-runtime tool outcomes carried by the await contract. */
  readonly toolObservations?: readonly WorkflowDelegateToolObservation[];
  /** Frozen child-session measurement snapshot returned by the subagent runtime. */
  readonly usage?: AwaitSubagentResponse['usage'];
}

/**
 * Spawn a subagent from an already-resolved workflow role config and await
 * its terminal result.
 *
 * This lower-level helper is the shared execution path for the agent step
 * node: `delegate-node.ts` resolves the role and renders the prompt, then
 * hands the resolved config and task off here for spawn, await, and result
 * finalization.
 * @param call - Call context of the handled message this node execution serves.
 * @param params - Resolved execution config, task, labels, and timeout.
 * @param ctx - Execution-wide runtime context.
 * @returns Terminal node outcome derived from the child subagent result.
 */
export async function executeResolvedSubagentNode(
  call: CallContext,
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const delegateStartedAt = performance.now();
  const spawnResult = await ctx.bus.requestOptional(call, SubagentSubjects.spawn, {
    parentSessionId: ctx.execution.coordinatorSessionId ?? ctx.executionId,
    depth: 1,
    config: buildSubagentConfig(params.task, params.resolvedConfig, params.outputSchema),
  });
  if (!spawnResult.handled) {
    return { status: 'failed', error: params.unavailableRuntimeError };
  }

  const sessionLinkEmitted = await emitFrameSessionLink(call, params, ctx, spawnResult.data.subagentId, {
    attempts: SESSION_LINK_POLL_ATTEMPTS,
  });

  const awaitResult = await awaitResolvedSubagent(call, params, ctx, spawnResult.data.subagentId);
  if (awaitResult === 'aborted') {
    return { status: 'cancelled' };
  }
  if (!sessionLinkEmitted) {
    await emitFrameSessionLink(call, params, ctx, spawnResult.data.subagentId, { attempts: 1 });
  }
  if (!awaitResult.handled) {
    await killResolvedSubagent(
      call,
      params,
      ctx,
      spawnResult.data.subagentId,
      `Workflow execution '${ctx.executionId}' could not await ${params.cancellationLabel} '${params.nodeId}'`,
    );
    return { status: 'failed', error: params.unavailableAwaitError };
  }

  if (ctx.signal.aborted || awaitResult.data.status === 'cancelled') {
    return { status: 'cancelled' };
  }
  if (awaitResult.data.status === 'completed') {
    const rawResult = awaitResult.data.result ?? null;
    try {
      const finalOutput = await finalizeDelegateResult(
        call,
        { ...params, toolObservations: awaitResult.data.toolObservations, usage: awaitResult.data.usage },
        ctx,
        rawResult,
        elapsedDelegateDuration(delegateStartedAt),
      );
      return { status: 'completed', output: finalOutput };
    } catch (error) {
      if (ctx.signal.aborted) return { status: 'cancelled' };
      throw error;
    }
  }
  if (awaitResult.data.status === 'timeout' || awaitResult.data.status === 'waiting_input') {
    await killResolvedSubagent(
      call,
      params,
      ctx,
      spawnResult.data.subagentId,
      `Workflow execution '${ctx.executionId}' abandoned non-terminal ${params.cancellationLabel} '${params.nodeId}'`,
    );
  }
  return {
    status: 'failed',
    error: `${params.nodeLabel} '${params.nodeId}' subagent ${awaitResult.data.status}: ${
      awaitResult.data.error ?? 'no result'
    }`,
  };
}

/**
 * Request authority-owned finalization of a successful delegate result.
 *
 * The subagent contract exposes only its terminal result today, so successful
 * tool observations are explicitly empty instead of inferred from unrelated
 * session events. Finalizer failures deliberately propagate: callers selected
 * the finalizer as part of the execution contract and retrying could duplicate
 * authority-side effects.
 * @param call - Call context of the handled message this node execution serves.
 * @param params - Delegate identity and optional finalizer selector.
 * @param ctx - Execution-wide runtime context.
 * @param rawResult - Successful raw subagent result.
 * @param durationMs - Measured delegate runtime duration available at completion.
 * @returns Raw result when no finalizer is selected, otherwise authority output.
 */
export async function finalizeDelegateResult(
  call: CallContext,
  params: DelegateResultFinalizationParams,
  ctx: RuntimeContext,
  rawResult: JsonValue,
  durationMs = 0,
): Promise<JsonValue> {
  if (params.resultFinalizerId === undefined) return rawResult;
  if (params.frameId === undefined) {
    throw new Error(`Delegate result finalizer '${params.resultFinalizerId}' requires frame identity`);
  }
  const request = {
    finalizerId: params.resultFinalizerId,
    executionId: ctx.executionId,
    workflowId: ctx.workflowId,
    frameId: params.frameId,
    nodeId: params.nodeId,
    rawResult,
    toolObservations: [...(params.toolObservations ?? [])],
    ...(params.resolvedConfig === undefined
      ? {}
      : { economics: buildDelegateEconomics(params.resolvedConfig, durationMs, params.usage) }),
  };
  const gatewayResult = await ctx.bus.requestOptional(call, WorkflowSubjects.finalizeDelegateResult, request, {
    signal: ctx.signal,
  });
  if (gatewayResult.handled) return gatewayResult.data.output;

  // In-process embedders may register a delegate finalizer without booting the
  // workflow Authority. Remote attempts cannot use this dynamic fallback:
  // their static transport allowlist admits only the gateway subject.
  const { subjects } = createWorkflowDelegateResultFinalizerNamespace(params.resultFinalizerId);
  const { finalizerId: _finalizerId, ...finalizerRequest } = request;
  const result = await ctx.bus.request(call, subjects.finalize, finalizerRequest, { signal: ctx.signal });
  return result.output;
}

/**
 * Convert a monotonic high-resolution start timestamp into a contract-safe duration.
 * @param startedAt - Timestamp previously returned by `performance.now()`.
 * @returns Rounded, clamped, non-negative safe-integer milliseconds.
 */
export function elapsedDelegateDuration(startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsed));
}

/**
 * Best-effort emission of a `frame.sessionLinked` bus event after a subagent
 * spawns, linking the runtime frame to the child session.
 *
 * Polls `SubagentSubjects.getStatus` with bounded requests and short
 * abort-aware delays to allow the subagent runtime to populate the
 * `childSessionId`. Failures at any step are swallowed so that session link
 * emission never affects workflow execution outcomes.
 * @param call - Call context of the handled message this node execution serves.
 * @param params - Resolved execution params carrying the optional frame ID.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @param options - Polling bounds for this emission attempt.
 * @returns True when a frame-session link was emitted.
 */
async function emitFrameSessionLink(
  call: CallContext,
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
  subagentId: string,
  options: { readonly attempts: number },
): Promise<boolean> {
  if (params.frameId === undefined) {
    return true;
  }

  try {
    const childSessionId = await resolveChildSessionId(call, ctx, subagentId, options.attempts);
    if (childSessionId === undefined) {
      return false;
    }

    await ctx.bus.emit(call, WorkflowSubjects.frame.sessionLinked, {
      executionId: ctx.executionId,
      frameId: params.frameId,
      sessionId: childSessionId,
    });
    return true;
  } catch (error) {
    console.warn(
      `[workflow-engine] Failed to emit frame.sessionLinked for frame '${params.frameId}' and subagent '${subagentId}'`,
      error,
    );
    return false;
  }
}

/**
 * Poll `SubagentSubjects.getStatus` until a `childSessionId` is available or
 * the maximum number of attempts is reached.
 *
 * Stops immediately when no handler is registered for the subject — no retry
 * makes sense if the subagent runtime is absent. Timeout, abort, and handler
 * failures also return `undefined` because frame-session linking is
 * best-effort telemetry. Only retries when a handler is present but the child
 * session ID is not yet populated, covering the race between spawn and the
 * runtime wiring up the session.
 * @param call - Call context of the handled message this node execution serves.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @param attempts - Maximum status requests to issue.
 * @returns The child session ID, or `undefined` if it could not be resolved.
 */
async function resolveChildSessionId(
  call: CallContext,
  ctx: RuntimeContext,
  subagentId: string,
  attempts: number,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (ctx.signal?.aborted) {
      return undefined;
    }
    const statusResult = await requestChildStatus(call, ctx, subagentId);
    if (statusResult === undefined) {
      return undefined;
    }
    if (!statusResult.handled) {
      // No handler registered — the subagent runtime is absent. Retrying will
      // not help, so bail out immediately without sleeping.
      return undefined;
    }
    if (statusResult.data.childSessionId !== undefined) {
      return statusResult.data.childSessionId;
    }
    if (attempt < attempts - 1) {
      const elapsed = await waitForSessionLinkPollDelay(ctx.signal, SESSION_LINK_POLL_DELAY_MS);
      if (!elapsed) {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Request the child subagent status with a short best-effort budget.
 * @param call - Call context of the handled message this node execution serves.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @returns Optional status result, or `undefined` when polling should stop.
 */
async function requestChildStatus(
  call: CallContext,
  ctx: RuntimeContext,
  subagentId: string,
): Promise<ChildStatusResult | undefined> {
  try {
    return await ctx.bus.requestOptional(
      call,
      SubagentSubjects.getStatus,
      { subagentId },
      { timeout: SESSION_LINK_POLL_TIMEOUT_MS, signal: ctx.signal },
    );
  } catch {
    return undefined;
  }
}

/**
 * Await an agent-step subagent while honoring workflow cancellation.
 *
 * The await RPC may block until the child reaches a terminal state. Workflow
 * cancellation owns the parent execution lifetime, so the runtime races the
 * await against the abort signal and best-effort cancels the child first.
 * @param call - Call context of the handled message this node execution serves.
 * @param params - Node labels and timeout used for diagnostics and await input.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @returns Await RPC result, or `'aborted'` when workflow cancellation wins.
 */
async function awaitResolvedSubagent(
  call: CallContext,
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
  subagentId: string,
): Promise<ResolvedSubagentAwaitResult | 'aborted'> {
  if (ctx.signal.aborted) {
    await killResolvedSubagent(call, params, ctx, subagentId);
    return 'aborted';
  }

  // `timeout: 0` disables the bus request envelope's 60s default
  // (DEFAULT_REQUEST_TIMEOUT_MS), which would otherwise kill every await
  // longer than 60s regardless of `params.timeoutMs`. The await deadline
  // belongs to the subagent service: the handler resolves with
  // `{ status: 'timeout' }` after `payload.timeoutMs` (or
  // `constraints.defaultAwaitTimeoutMs`, default 300s), so the request never
  // dangles. Workflow cancellation stays covered by the abort race below.
  // `0` is honored end-to-end: in-process (awaitWithTimeoutAndSignal), relay
  // hops (`message.timeout ?? DEFAULT` preserves 0), and transport
  // correlation tracking (CorrelationTracker skips the timer for 0).
  const awaitPromise = ctx.bus.requestOptional(
    call,
    SubagentSubjects.await,
    {
      subagentId,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    },
    { timeout: 0 },
  );
  if (ctx.signal.aborted) {
    await killResolvedSubagent(call, params, ctx, subagentId);
    return 'aborted';
  }
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<'aborted'>((resolve) => {
    abortListener = () => resolve('aborted');
    ctx.signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    const result = await Promise.race([awaitPromise, abortPromise]);
    if (result === 'aborted') {
      await killResolvedSubagent(call, params, ctx, subagentId);
    }
    return result;
  } catch (error) {
    await killResolvedSubagent(
      call,
      params,
      ctx,
      subagentId,
      `Workflow execution '${ctx.executionId}' failed awaiting ${params.cancellationLabel} '${params.nodeId}'`,
    );
    throw error;
  } finally {
    if (abortListener !== undefined) {
      ctx.signal.removeEventListener('abort', abortListener);
    }
  }
}

/**
 * Best-effort child cancellation for agent-step workflow nodes.
 * @param call - Call context of the handled message this node execution serves.
 * @param params - Node labels used in the cancellation reason.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @param reason - Optional lifecycle-specific cancellation reason.
 */
async function killResolvedSubagent(
  call: CallContext,
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
  subagentId: string,
  reason?: string,
): Promise<void> {
  try {
    await ctx.bus.requestOptional(call, SubagentSubjects.kill, {
      subagentId,
      reason:
        reason ?? `Workflow execution '${ctx.executionId}' cancelled ${params.cancellationLabel} '${params.nodeId}'`,
    });
  } catch (error) {
    // Child kill is best-effort lifecycle cleanup: missing handlers, handler
    // failures, and timeouts must not mask the parent workflow outcome.
    console.warn(
      `[workflow-engine] Best-effort subagent kill failed for '${subagentId}' ` +
        `(${params.cancellationLabel} '${params.nodeId}')`,
      error,
    );
  }
}

/** Spawn configuration used only by the resolved workflow subagent path. */
interface ResolvedSubagentConfigInput {
  readonly task: string;
  readonly adapterName: string;
  readonly providerConfigId?: string;
  readonly model?: string;
  readonly reasoningEffort?: WorkflowResolvedRole['reasoningEffort'];
  readonly harnessId?: string;
  readonly systemPrompt?: string;
  readonly contextMode?: WorkflowResolvedRole['contextMode'];
  readonly providerContext?: WorkflowResolvedRole['providerContext'];
  readonly adapterConfig?: WorkflowResolvedRole['adapterConfig'];
  readonly tools?: WorkflowResolvedRole['tools'];
  readonly disallowedTools?: WorkflowResolvedRole['disallowedTools'];
  readonly allowedDirectories?: WorkflowResolvedRole['allowedDirectories'];
  readonly responseSchema?: ResponseSchemaDescriptor;
  readonly completion?: WorkflowResolvedRole['completion'];
}

/**
 * Wait between child-session status polls while honoring workflow abort.
 * @param signal - Workflow cancellation signal.
 * @param delayMs - Delay in milliseconds.
 * @returns `true` when the delay elapsed, `false` when aborted first.
 */
function waitForSessionLinkPollDelay(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (elapsed: boolean): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal.removeEventListener('abort', abort);
      resolve(elapsed);
    };
    const abort = (): void => finish(false);

    timeout = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      finish(false);
    }
  });
}

/**
 * Build the subagent config from a resolved workflow role and node output
 * contract.
 * @param task - Fully resolved task prompt for the child subagent.
 * @param role - Resolved workflow role configuration.
 * @param outputSchema - Optional structured output descriptor.
 * @returns Subagent spawn configuration.
 */
function buildSubagentConfig(
  task: string,
  role: WorkflowResolvedRole,
  outputSchema?: ResponseSchemaDescriptor,
): ResolvedSubagentConfigInput {
  return {
    task,
    adapterName: role.adapterName,
    ...(role.providerConfigId !== undefined ? { providerConfigId: role.providerConfigId } : {}),
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.reasoningEffort !== undefined ? { reasoningEffort: role.reasoningEffort } : {}),
    ...(role.harnessId !== undefined ? { harnessId: role.harnessId } : {}),
    ...(role.systemPrompt !== undefined ? { systemPrompt: role.systemPrompt } : {}),
    ...(role.contextMode !== undefined ? { contextMode: role.contextMode } : {}),
    ...(role.providerContext !== undefined ? { providerContext: role.providerContext } : {}),
    ...(role.adapterConfig !== undefined ? { adapterConfig: role.adapterConfig } : {}),
    ...(role.tools !== undefined ? { tools: role.tools } : {}),
    ...(role.disallowedTools !== undefined ? { disallowedTools: role.disallowedTools } : {}),
    ...(role.allowedDirectories !== undefined ? { allowedDirectories: role.allowedDirectories } : {}),
    ...(role.completion !== undefined ? { completion: role.completion } : {}),
    ...(outputSchema !== undefined ? { responseSchema: outputSchema } : {}),
  };
}
