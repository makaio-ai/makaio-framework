/* eslint max-lines: ["error", { "max": 430, "skipBlankLines": true, "skipComments": true }] */
import { evaluateSync, resolveTemplate } from '@makaio/expression';
import {
  type ResponseSchemaDescriptor,
  type WorkflowDelegateAgentNode,
  type WorkflowDelegateRoleNode,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { executeResolvedSubagentNode } from './role-subagent-node.js';
import { resolveDelegateAgentConfig, resolveDelegateRoleConfig } from './delegate-execution-policy.js';

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
  const resolvedConfig = resolveDelegateAgentConfig(node, agentResult.data);
  return executeResolvedSubagentNode(
    {
      nodeId: node.id,
      nodeLabel: 'Delegate-agent node',
      task: taskResult.task,
      resolvedConfig,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      unavailableRuntimeError: `Subagent runtime is not available for delegate-agent node '${node.id}'`,
      unavailableAwaitError: `Subagent runtime cannot await delegate-agent node '${node.id}'`,
      cancellationLabel: 'delegate-agent',
      ...(frameId !== undefined ? { frameId } : {}),
      ...(node.resultFinalizerId !== undefined ? { resultFinalizerId: node.resultFinalizerId } : {}),
      delegateNodeType: 'delegate-agent',
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
      ...(node.resultFinalizerId !== undefined ? { resultFinalizerId: node.resultFinalizerId } : {}),
      delegateNodeType: 'delegate-role',
    },
    ctx,
  );
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

type DelegateAgentTaskResult = { status: 'completed'; task: string } | { status: 'failed'; error: string };

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
