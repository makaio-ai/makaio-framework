import { resolveTemplate } from '@makaio/expression';
import { SubagentSubjects, type AwaitSubagentResponse, type WorkflowResolvedRole } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';

type ResolvedSubagentAwaitResult = { handled: true; data: AwaitSubagentResponse } | { handled: false };
type ChildStatusResult = { handled: true; data: { childSessionId?: string } } | { handled: false };

// Best-effort session linking uses a short pre-await polling window; a final
// single status check runs after await for slow child session creation.
const SESSION_LINK_POLL_ATTEMPTS = 5;
const SESSION_LINK_POLL_DELAY_MS = 20;
const SESSION_LINK_POLL_TIMEOUT_MS = 25;

interface ResolvedSubagentConfigInput {
  readonly task: string;
  readonly adapterName: string;
  readonly model?: string;
  readonly harnessId?: string;
  readonly systemPrompt?: string;
  readonly contextMode?: WorkflowResolvedRole['contextMode'];
  readonly providerContext?: WorkflowResolvedRole['providerContext'];
  readonly responseSchema?: Record<string, unknown>;
}

export interface ExecuteRoleSubagentNodeParams {
  /** Node identifier used in diagnostics and child cancellation reasons. */
  readonly nodeId: string;
  /** Human-readable node type label, e.g. `station node` or `delegate-role node`. */
  readonly nodeLabel: string;
  /** Role ID resolved through the workflow role registry. */
  readonly roleId: string;
  /** Prompt template resolved against the current workflow expression scope. */
  readonly prompt: string;
  /** Optional structured-output schema forwarded to the subagent runtime. */
  readonly outputSchema?: Record<string, unknown>;
  /** Optional await timeout for the spawned subagent. */
  readonly timeoutMs?: number;
  /** Error emitted when no role resolver handles the requested role. */
  readonly unresolvedRoleError: string;
  /** Error emitted when the subagent spawn subject has no runtime handler. */
  readonly unavailableRuntimeError: string;
  /** Error emitted when the subagent await subject has no runtime handler. */
  readonly unavailableAwaitError: string;
  /** Label included in best-effort child cancellation reasons. */
  readonly cancellationLabel: string;
  /** Runtime frame that owns the spawned child session. */
  readonly frameId?: string;
}

export interface ExecuteResolvedSubagentNodeParams {
  /** Node identifier used in diagnostics and child cancellation reasons. */
  readonly nodeId: string;
  /** Human-readable node type label, e.g. `station node` or `delegate-role node`. */
  readonly nodeLabel: string;
  /** Fully resolved task prompt for the child subagent. */
  readonly task: string;
  /** Resolved adapter/model/provider configuration for the child subagent. */
  readonly resolvedConfig: WorkflowResolvedRole;
  /** Optional structured-output schema forwarded to the subagent runtime. */
  readonly outputSchema?: Record<string, unknown>;
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
}

/**
 * Resolve a workflow role, spawn a subagent for the node prompt, and await its
 * terminal result.
 *
 * Serialized station nodes and delegate-role nodes share the same executable
 * invariant: a role reference is resolved by the workflow seam, then execution
 * happens through the framework subagent runtime. Keeping that path centralized
 * prevents role-backed stations and delegate-role primitives from drifting.
 * @param params - Node-specific labels, role, prompt, and output options.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current primitive expression context.
 * @returns Terminal node outcome derived from the child subagent result.
 */
export async function executeRoleSubagentNode(
  params: ExecuteRoleSubagentNodeParams,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const roleResult = await ctx.bus.requestOptional(WorkflowSubjects.resolveRole, {
    roleId: params.roleId,
  });
  if (!roleResult.handled) {
    return {
      status: 'failed',
      error: params.unresolvedRoleError,
    };
  }

  const task = resolveTemplate(params.prompt, buildRuntimeExpressionScope(expressionCtx));
  return executeResolvedSubagentNode(
    {
      ...params,
      task,
      resolvedConfig: roleResult.data,
    },
    ctx,
  );
}

/**
 * Spawn a subagent from an already-resolved workflow role/agent config and
 * await its terminal result.
 *
 * This lower-level helper is shared by `delegate-agent` and role-backed nodes:
 * both paths differ only in how they resolve the adapter configuration and
 * build the task prompt.
 * @param params - Resolved execution config, task, labels, and timeout.
 * @param ctx - Execution-wide runtime context.
 * @returns Terminal node outcome derived from the child subagent result.
 */
export async function executeResolvedSubagentNode(
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const spawnResult = await ctx.bus.requestOptional(SubagentSubjects.spawn, {
    parentSessionId: ctx.execution.coordinatorSessionId ?? ctx.executionId,
    depth: 1,
    config: buildSubagentConfig(params.task, params.resolvedConfig, params.outputSchema),
  });
  if (!spawnResult.handled) {
    return {
      status: 'failed',
      error: params.unavailableRuntimeError,
    };
  }

  const sessionLinkEmitted = await emitFrameSessionLink(params, ctx, spawnResult.data.subagentId, {
    attempts: SESSION_LINK_POLL_ATTEMPTS,
  });

  const awaitResult = await awaitResolvedSubagent(params, ctx, spawnResult.data.subagentId);
  if (awaitResult === 'aborted') {
    return { status: 'cancelled' };
  }
  if (!sessionLinkEmitted) {
    await emitFrameSessionLink(params, ctx, spawnResult.data.subagentId, { attempts: 1 });
  }
  if (!awaitResult.handled) {
    return {
      status: 'failed',
      error: params.unavailableAwaitError,
    };
  }

  if (ctx.signal.aborted || awaitResult.data.status === 'cancelled') {
    return { status: 'cancelled' };
  }
  if (awaitResult.data.status === 'completed') {
    return { status: 'completed', output: awaitResult.data.result ?? null };
  }
  return {
    status: 'failed',
    error: `${params.nodeLabel} '${params.nodeId}' subagent ${awaitResult.data.status}: ${
      awaitResult.data.error ?? 'no result'
    }`,
  };
}

/**
 * Best-effort emission of a `frame.sessionLinked` bus event after a subagent
 * spawns, linking the runtime frame to the child session.
 *
 * Polls `SubagentSubjects.getStatus` with bounded requests and short
 * abort-aware delays to allow the subagent runtime to populate the
 * `childSessionId`. Failures at any step are swallowed so that session link
 * emission never affects workflow execution outcomes.
 * @param params - Resolved execution params carrying the optional frame ID.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @param options - Polling bounds for this emission attempt.
 * @returns True when a frame-session link was emitted.
 */
async function emitFrameSessionLink(
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
  subagentId: string,
  options: { readonly attempts: number },
): Promise<boolean> {
  if (params.frameId === undefined) {
    return true;
  }

  try {
    const childSessionId = await resolveChildSessionId(ctx, subagentId, options.attempts);
    if (childSessionId === undefined) {
      return false;
    }

    await ctx.bus.emit(WorkflowSubjects.frame.sessionLinked, {
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
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @param attempts - Maximum status requests to issue.
 * @returns The child session ID, or `undefined` if it could not be resolved.
 */
async function resolveChildSessionId(
  ctx: RuntimeContext,
  subagentId: string,
  attempts: number,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (ctx.signal?.aborted) {
      return undefined;
    }
    const statusResult = await requestChildStatus(ctx, subagentId);
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
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @returns Optional status result, or `undefined` when polling should stop.
 */
async function requestChildStatus(ctx: RuntimeContext, subagentId: string): Promise<ChildStatusResult | undefined> {
  try {
    return await ctx.bus.requestOptional(
      SubagentSubjects.getStatus,
      { subagentId },
      { timeout: SESSION_LINK_POLL_TIMEOUT_MS, signal: ctx.signal },
    );
  } catch {
    return undefined;
  }
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
 * @param outputSchema - Optional structured response JSON Schema.
 * @returns Subagent spawn configuration.
 */
function buildSubagentConfig(
  task: string,
  role: WorkflowResolvedRole,
  outputSchema?: Record<string, unknown>,
): ResolvedSubagentConfigInput {
  return {
    task,
    adapterName: role.adapterName,
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.harnessId !== undefined ? { harnessId: role.harnessId } : {}),
    ...(role.systemPrompt !== undefined ? { systemPrompt: role.systemPrompt } : {}),
    ...(role.contextMode !== undefined ? { contextMode: role.contextMode } : {}),
    ...(role.providerContext !== undefined ? { providerContext: role.providerContext } : {}),
    ...(outputSchema !== undefined ? { responseSchema: outputSchema } : {}),
  };
}

/**
 * Await a role-backed subagent while honoring workflow cancellation.
 *
 * The await RPC may block until the child reaches a terminal state. Workflow
 * cancellation owns the parent execution lifetime, so the runtime races the
 * await against the abort signal and best-effort cancels the child first.
 * @param params - Node labels and timeout used for diagnostics and await input.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 * @returns Await RPC result, or `'aborted'` when workflow cancellation wins.
 */
async function awaitResolvedSubagent(
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
  subagentId: string,
): Promise<ResolvedSubagentAwaitResult | 'aborted'> {
  if (ctx.signal.aborted) {
    await killResolvedSubagent(params, ctx, subagentId);
    return 'aborted';
  }

  const awaitPromise = ctx.bus.requestOptional(SubagentSubjects.await, {
    subagentId,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });
  if (ctx.signal.aborted) {
    await killResolvedSubagent(params, ctx, subagentId);
    return 'aborted';
  }
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<'aborted'>((resolve) => {
    abortListener = () => resolve('aborted');
    ctx.signal.addEventListener('abort', abortListener, { once: true });
  });
  const result = await Promise.race([awaitPromise, abortPromise]);
  if (abortListener !== undefined) {
    ctx.signal.removeEventListener('abort', abortListener);
  }
  if (result === 'aborted') {
    await killResolvedSubagent(params, ctx, subagentId);
  }
  return result;
}

/**
 * Best-effort child cancellation for role-backed workflow nodes.
 * @param params - Node labels used in the cancellation reason.
 * @param ctx - Execution-wide runtime context.
 * @param subagentId - Spawned subagent identifier.
 */
async function killResolvedSubagent(
  params: ExecuteResolvedSubagentNodeParams,
  ctx: RuntimeContext,
  subagentId: string,
): Promise<void> {
  try {
    await ctx.bus.requestOptional(SubagentSubjects.kill, {
      subagentId,
      reason: `Workflow execution '${ctx.executionId}' cancelled ${params.cancellationLabel} '${params.nodeId}'`,
    });
  } catch (error) {
    // Child kill is cancellation cleanup: missing handlers, handler failures,
    // and timeouts must not mask the parent workflow's cancelled outcome.
    console.warn(
      `[workflow-engine] Best-effort subagent kill failed for '${subagentId}' ` +
        `(${params.cancellationLabel} '${params.nodeId}')`,
      error,
    );
  }
}
