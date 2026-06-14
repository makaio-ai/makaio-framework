import { evaluateSync, resolveTemplate } from '@makaio/expression';
import {
  AgentSubjects,
  SessionSubjects,
  type AdapterSelection,
  type ResponseSchemaDescriptor,
  type WorkflowDelegateAgentNode,
  type WorkflowDelegateRoleNode,
  type WorkflowResolvedRole,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { executeResolvedSubagentNode } from './role-subagent-node.js';

const DEFAULT_ROLE_SESSION_TIMEOUT_MS = 300_000;

// ─────────────────────────────────────────────────────────────
// Delegate-agent executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute a `delegate-agent` node through the workflow agent resolver seam.
 * @param node - The delegate-agent node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param frameId - Frame ID of this node's frame, forwarded for session link emission.
 * @returns Terminal execution outcome for this delegation.
 */
export async function executeDelegateAgentNode(
  node: WorkflowDelegateAgentNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId?: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const agentResult = await ctx.bus.requestOptional(WorkflowSubjects.resolveAgent, {
    agentId: node.agentId,
  });
  if (!agentResult.handled) {
    return {
      status: 'failed',
      error: `Agent '${node.agentId}' could not be resolved for delegate-agent node '${node.id}'`,
    };
  }

  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const taskResult = evaluateDelegateAgentTask(node, expressionCtx);
  if (taskResult.status === 'failed') {
    return taskResult;
  }

  const outputSchema: ResponseSchemaDescriptor | undefined =
    node.outputSchema !== undefined ? { schema: node.outputSchema } : undefined;
  return executeResolvedSubagentNode(
    {
      nodeId: node.id,
      nodeLabel: 'Delegate-agent node',
      task: taskResult.task,
      resolvedConfig: agentResult.data,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      unavailableRuntimeError: `Subagent runtime is not available for delegate-agent node '${node.id}'`,
      unavailableAwaitError: `Subagent runtime cannot await delegate-agent node '${node.id}'`,
      cancellationLabel: 'delegate-agent',
      ...(frameId !== undefined ? { frameId } : {}),
    },
    ctx,
  );
}

// ─────────────────────────────────────────────────────────────
// Delegate-role executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute a `delegate-role` node by resolving the named role and running a
 * workflow-owned session turn.
 * @param node - The delegate-role node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param frameId - Frame ID of this node's frame, forwarded for session link emission.
 * @returns Terminal execution outcome for this delegation.
 */
export async function executeDelegateRoleNode(
  node: WorkflowDelegateRoleNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId?: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const roleResult = await ctx.bus.requestOptional(WorkflowSubjects.resolveRole, {
    roleId: node.role,
  });
  if (!roleResult.handled) {
    return {
      status: 'failed',
      error: `Role '${node.role}' could not be resolved for delegate-role node '${node.id}'`,
    };
  }

  const outputSchema: ResponseSchemaDescriptor | undefined =
    node.outputSchema !== undefined ? { schema: node.outputSchema } : undefined;
  const task = resolveTemplate(node.prompt, buildRuntimeExpressionScope(expressionCtx));
  const resolvedRole = resolveDelegateRoleConfig(node, roleResult.data);
  const roleExecutionParams = {
    node,
    task,
    resolvedRole,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(frameId !== undefined ? { frameId } : {}),
  };

  if (shouldUseSessionTurnForDelegateRole(resolvedRole)) {
    return executeDelegateRoleSessionTurn(roleExecutionParams, ctx);
  }

  return executeResolvedSubagentNode(
    {
      nodeId: node.id,
      nodeLabel: 'Delegate-role node',
      task,
      resolvedConfig: resolvedRole,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
      unavailableRuntimeError: `Subagent runtime is not available for delegate-role node '${node.id}'`,
      unavailableAwaitError: `Subagent runtime cannot await delegate-role node '${node.id}'`,
      cancellationLabel: 'delegate-role',
      ...(frameId !== undefined ? { frameId } : {}),
    },
    ctx,
  );
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

type DelegateAgentTaskResult = { status: 'completed'; task: string } | { status: 'failed'; error: string };

interface DelegateRoleSessionTurnParams {
  readonly node: WorkflowDelegateRoleNode;
  readonly task: string;
  readonly resolvedRole: WorkflowResolvedRole;
  readonly outputSchema?: ResponseSchemaDescriptor;
  readonly frameId?: string;
}

interface DelegateRoleSessionStart {
  readonly sessionId: string;
}

interface LinkedAbortSignal {
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

/**
 * Resolve a delegate-role node and execute its prompt through the session subsystem.
 * @param params - Resolved node prompt plus optional output/frame metadata.
 * @param ctx - Execution-wide runtime context.
 * @returns Terminal node outcome derived from the child session turn.
 */
async function executeDelegateRoleSessionTurn(
  params: DelegateRoleSessionTurnParams,
  ctx: RuntimeContext,
): Promise<NodeOutcome> {
  const { node } = params;
  const timeoutMs = node.timeoutMs ?? DEFAULT_ROLE_SESSION_TIMEOUT_MS;
  let childSessionId: string | undefined;
  const abortLink = linkAbortSignal(ctx.signal);

  try {
    const start = await startDelegateRoleSession(params, ctx);
    if ('status' in start) return start;
    childSessionId = start.sessionId;

    if (ctx.signal.aborted) {
      return { status: 'cancelled' };
    }

    return await runDelegateRoleSessionTurn(params, ctx, {
      abortLink,
      childSessionId,
      role: params.resolvedRole,
      timeoutMs,
    });
  } catch (error) {
    if (ctx.signal.aborted) {
      return { status: 'cancelled' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: `Delegate-role node '${node.id}' session turn failed: ${message}`,
    };
  } finally {
    abortLink.controller.abort();
    abortLink.cleanup();
    if (childSessionId !== undefined) {
      await closeDelegateRoleSession(ctx, node.id, childSessionId);
    }
  }
}

type DelegateRoleSessionStartResult = DelegateRoleSessionStart | NodeOutcome;

/**
 * Create the child session for a delegate-role node and emit the frame link.
 * @param params - Delegate-role session execution parameters.
 * @param ctx - Execution-wide runtime context.
 * @returns Created session identity or a failed node outcome.
 */
async function startDelegateRoleSession(
  params: DelegateRoleSessionTurnParams,
  ctx: RuntimeContext,
): Promise<DelegateRoleSessionStartResult> {
  const createResult = await ctx.bus.requestOptional(SessionSubjects.create, {
    sessionId: buildDelegateRoleSessionId(ctx, params),
    parentSessionId: ctx.execution.coordinatorSessionId ?? ctx.executionId,
    branchKind: 'subagent',
    title: `Workflow delegate-role '${params.node.id}'`,
  });
  if (!createResult.handled) {
    return {
      status: 'failed',
      error: `Session runtime is not available for delegate-role node '${params.node.id}'`,
    };
  }

  const sessionId = createResult.data.sessionId;
  await emitDelegateRoleSessionLink(params, ctx, sessionId);
  return { sessionId };
}

interface DelegateRoleSessionTurnRuntime {
  readonly abortLink: LinkedAbortSignal;
  readonly childSessionId: string;
  readonly role: WorkflowResolvedRole;
  readonly timeoutMs: number;
}

/**
 * Send the delegate-role prompt into the child session and await terminal output.
 * @param params - Delegate-role session execution parameters.
 * @param ctx - Execution-wide runtime context.
 * @param runtime - Runtime state for the active child session.
 * @returns Terminal node outcome for the delegated session turn.
 */
async function runDelegateRoleSessionTurn(
  params: DelegateRoleSessionTurnParams,
  ctx: RuntimeContext,
  runtime: DelegateRoleSessionTurnRuntime,
): Promise<NodeOutcome> {
  const agentCompletion = ctx.bus.once(AgentSubjects.complete, {
    timeoutMs: runtime.timeoutMs,
    filter: { sessionId: runtime.childSessionId },
    signal: runtime.abortLink.controller.signal,
  });
  agentCompletion.catch(() => undefined);

  const sendResult = await sendDelegateRoleMessage(params, ctx, runtime);
  if ('status' in sendResult) return sendResult;

  const turnResult = await awaitDelegateRoleTurn(params, ctx, runtime, sendResult.turnId);
  if (turnResult.status === 'failed') return turnResult;

  const completionEvent = await agentCompletion;
  if (ctx.signal.aborted) return { status: 'cancelled' };
  if (completionEvent.payload.outcome === 'error') {
    return {
      status: 'failed',
      error: `Delegate-role node '${params.node.id}' agent error: ${completionEvent.payload.error ?? 'no result'}`,
    };
  }
  return { status: 'completed', output: completionEvent.payload.message ?? null };
}

interface DelegateRoleSendResult {
  readonly turnId: string;
}

type DelegateRoleSendOutcome = DelegateRoleSendResult | NodeOutcome;

/**
 * Send the resolved role prompt through session.sendMessage.
 * @param params - Delegate-role session execution parameters.
 * @param ctx - Execution-wide runtime context.
 * @param runtime - Runtime state for the active child session.
 * @returns Sent turn ID or a failed node outcome.
 */
async function sendDelegateRoleMessage(
  params: DelegateRoleSessionTurnParams,
  ctx: RuntimeContext,
  runtime: DelegateRoleSessionTurnRuntime,
): Promise<DelegateRoleSendOutcome> {
  const sendResult = await ctx.bus.requestOptional(
    SessionSubjects.sendMessage,
    {
      sessionId: runtime.childSessionId,
      message: params.task,
      agent: buildDelegateRoleAgentSelection(runtime.role),
      ...(params.outputSchema !== undefined ? { responseSchema: params.outputSchema } : {}),
      source: 'system',
    },
    { signal: ctx.signal },
  );
  if (!sendResult.handled) {
    runtime.abortLink.controller.abort();
    return {
      status: 'failed',
      error: `Session runtime cannot send delegate-role node '${params.node.id}'`,
    };
  }
  return { turnId: sendResult.data.turnId };
}

/**
 * Await child session turn completion and convert failed turns to node failures.
 * @param params - Delegate-role session execution parameters.
 * @param ctx - Execution-wide runtime context.
 * @param runtime - Runtime state for the active child session.
 * @param turnId - Session turn ID returned by sendMessage.
 * @returns Completed or failed node outcome for the turn lifecycle.
 */
async function awaitDelegateRoleTurn(
  params: DelegateRoleSessionTurnParams,
  ctx: RuntimeContext,
  runtime: DelegateRoleSessionTurnRuntime,
  turnId: string,
): Promise<NodeOutcome> {
  const turnResult = await ctx.bus.requestOptional(
    SessionSubjects.turn.await,
    {
      sessionId: runtime.childSessionId,
      turnId,
      timeoutMs: runtime.timeoutMs,
    },
    { timeout: 0, signal: ctx.signal },
  );
  if (!turnResult.handled) {
    runtime.abortLink.controller.abort();
    return {
      status: 'failed',
      error: `Session runtime cannot await delegate-role node '${params.node.id}'`,
    };
  }
  if (!turnResult.data.completion.success) {
    return {
      status: 'failed',
      error: `Delegate-role node '${params.node.id}' session turn failed: ${
        turnResult.data.completion.error ?? 'no result'
      }`,
    };
  }
  return { status: 'completed' };
}

/**
 * Build the deterministic child session ID for a delegate-role execution.
 * @param ctx - Execution-wide runtime context.
 * @param params - Delegate-role session execution parameters.
 * @returns Session ID owned by the workflow frame or node.
 */
function buildDelegateRoleSessionId(ctx: RuntimeContext, params: DelegateRoleSessionTurnParams): string {
  return `session-workflow-${ctx.executionId}-${params.frameId ?? params.node.id}`;
}

/**
 * Convert the resolved workflow role to the adapter selection accepted by session.sendMessage.
 * @param role - Workflow role resolution result.
 * @returns Direct adapter selection for the session orchestrator.
 */
function buildDelegateRoleAgentSelection(role: WorkflowResolvedRole): AdapterSelection {
  return {
    kind: 'adapter',
    adapterName: role.adapterName,
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.reasoningEffort !== undefined ? { reasoningEffort: role.reasoningEffort } : {}),
    ...(role.systemPrompt !== undefined ? { systemPrompt: role.systemPrompt } : {}),
    ...(role.providerContext !== undefined ? { providerConfigId: role.providerContext.providerConfigId } : {}),
  };
}

/**
 * Merge node-owned execution options into the resolved role config.
 * @param node - Delegate-role node definition.
 * @param role - Resolved role configuration.
 * @returns Effective role execution configuration.
 */
function resolveDelegateRoleConfig(node: WorkflowDelegateRoleNode, role: WorkflowResolvedRole): WorkflowResolvedRole {
  return node.completion !== undefined ? { ...role, completion: node.completion } : role;
}

/**
 * Decide whether a delegate-role can use the session-turn primitive.
 *
 * The session path only preserves roles that are explicit one-shot turn
 * delegates and do not carry subagent-only governance fields. Default `tool`
 * completion and harness/context roles must keep the subagent runtime contract.
 * @param role - Effective resolved role configuration.
 * @returns True when session.sendMessage preserves the role's semantics.
 */
function shouldUseSessionTurnForDelegateRole(role: WorkflowResolvedRole): boolean {
  return role.completion === 'turn' && role.harnessId === undefined && role.contextMode === undefined;
}

/**
 * Emit the workflow frame-to-session link once the child session is known.
 * @param params - Delegate-role session execution parameters.
 * @param ctx - Execution-wide runtime context.
 * @param sessionId - Child session ID.
 */
async function emitDelegateRoleSessionLink(
  params: DelegateRoleSessionTurnParams,
  ctx: RuntimeContext,
  sessionId: string,
): Promise<void> {
  if (params.frameId === undefined) {
    return;
  }
  try {
    await ctx.bus.emit(WorkflowSubjects.frame.sessionLinked, {
      executionId: ctx.executionId,
      frameId: params.frameId,
      sessionId,
    });
  } catch (error) {
    console.warn(
      `[workflow-engine] Failed to emit frame.sessionLinked for frame '${params.frameId}' and session '${sessionId}'`,
      error,
    );
  }
}

/**
 * Close a delegate-role child session without masking the workflow outcome.
 * @param ctx - Execution-wide runtime context.
 * @param nodeId - Delegate-role node ID used in diagnostics.
 * @param sessionId - Child session to close.
 */
async function closeDelegateRoleSession(ctx: RuntimeContext, nodeId: string, sessionId: string): Promise<void> {
  try {
    await ctx.bus.requestOptional(SessionSubjects.close, { sessionId });
  } catch (error) {
    console.warn(`[workflow-engine] Failed to close delegate-role session '${sessionId}' for node '${nodeId}'`, error);
  }
}

/**
 * Create an abort controller linked to the workflow execution signal.
 * @param signal - Parent workflow cancellation signal.
 * @returns Abort controller cancelled when the parent signal aborts, plus listener cleanup.
 */
function linkAbortSignal(signal: AbortSignal): LinkedAbortSignal {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return { controller, cleanup: () => undefined };
  }
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener('abort', abort),
  };
}

/**
 * Evaluate a delegate-agent input expression and convert the payload into the
 * task string consumed by the subagent runtime.
 * @param node - Delegate-agent node being executed.
 * @param expressionCtx - Current primitive expression context.
 * @returns Resolved task string or a failed outcome with the expression error.
 */
function evaluateDelegateAgentTask(
  node: WorkflowDelegateAgentNode,
  expressionCtx: PrimitiveExpressionContext,
): DelegateAgentTaskResult {
  try {
    const scope = buildRuntimeExpressionScope(expressionCtx);
    const input = node.inputExpression === undefined ? scope : evaluateSync(node.inputExpression, scope);
    return { status: 'completed', task: stringifyDelegateAgentInput(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: `delegate-agent node '${node.id}': input expression evaluation failed: ${message}`,
    };
  }
}

/**
 * Convert a delegate-agent payload into the prompt/task channel supported by
 * the current subagent runtime.
 * @param input - Resolved delegate-agent input payload.
 * @returns String task for subagent spawn.
 */
function stringifyDelegateAgentInput(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input === undefined) {
    return '';
  }
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}
