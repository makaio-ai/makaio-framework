/* eslint max-lines: ["error", { "max": 430, "skipBlankLines": true, "skipComments": true }] */
import { renderPromptTemplate, TemplatePlaceholderError } from '@makaio/expression';
import type { CallContext } from '@makaio/core';
import { type ResponseSchemaDescriptor, type WorkflowAgentStepNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { executeResolvedSubagentNode } from './role-subagent-node.js';
import { resolveAgentStepConfig } from './delegate-execution-policy.js';

// ─────────────────────────────────────────────────────────────
// Agent step executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute an `agent-step` node by resolving the named role and running a
 * workflow-owned session turn.
 *
 * The prompt is rendered strictly ({@link renderPromptTemplate}): structured
 * values render as JSON, a missing path renders as an empty string, and a
 * placeholder that fails to evaluate fails the node visibly before a
 * subagent is spawned.
 * @param call - Call context of the handled message this node execution serves.
 * @param node - The agent step node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param frameId - Frame ID of this node's frame, forwarded for session link emission.
 * @returns Terminal execution outcome for this agent step.
 */
export async function executeAgentStepNode(
  call: CallContext,
  node: WorkflowAgentStepNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId?: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const roleResult = await ctx.bus.requestOptional(call, WorkflowSubjects.resolveRole, {
    roleId: node.role,
  });
  if (!roleResult.handled) {
    return {
      status: 'failed',
      error: `Role '${node.role}' could not be resolved for agent step '${node.id}'`,
    };
  }

  let task: string;
  try {
    task = renderPromptTemplate(node.prompt, buildRuntimeExpressionScope(expressionCtx));
  } catch (error) {
    if (error instanceof TemplatePlaceholderError) {
      return { status: 'failed', error: `agent step '${node.id}': ${error.message}` };
    }
    throw error;
  }

  const outputSchema: ResponseSchemaDescriptor | undefined =
    node.outputSchema !== undefined ? { schema: node.outputSchema } : undefined;
  const resolvedConfig = resolveAgentStepConfig(node, roleResult.data);
  return executeResolvedSubagentNode(
    call,
    {
      nodeId: node.id,
      nodeLabel: 'Agent step',
      task,
      resolvedConfig,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
      unavailableRuntimeError: `Subagent runtime is not available for agent step '${node.id}'`,
      unavailableAwaitError: `Subagent runtime cannot await agent step '${node.id}'`,
      cancellationLabel: 'agent-step',
      ...(frameId !== undefined ? { frameId } : {}),
      ...(node.resultFinalizerId !== undefined ? { resultFinalizerId: node.resultFinalizerId } : {}),
    },
    ctx,
  );
}
