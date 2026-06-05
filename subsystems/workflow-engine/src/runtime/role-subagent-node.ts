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

  const awaitResult = await awaitResolvedSubagent(params, ctx, spawnResult.data.subagentId);
  if (awaitResult === 'aborted') {
    return { status: 'cancelled' };
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
