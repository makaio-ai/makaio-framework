/* eslint max-lines: ["error", { "max": 430, "skipBlankLines": true, "skipComments": true }] */
import type { CallContext } from '@makaio/core';
import {
  JsonValueSchema,
  type JsonValue,
  type ResponseSchemaDescriptor,
  type WorkflowAgentStepNode,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import type { RuntimeContext } from './runtime-context.js';
import type { CallerLocalStepOutcome } from './caller-local-step-runner.js';
import { executeResolvedSubagentNode } from './role-subagent-node.js';
import { resolveAgentStepConfig } from './delegate-execution-policy.js';

/**
 * Decode structured output carried by the subagent's text-only result.
 * @param text - Successful subagent result.
 * @returns The decoded JSON value, or the original plain-text result.
 */
function decodeStructuredOutput(text: string): JsonValue {
  try {
    const decoded = JsonValueSchema.safeParse(JSON.parse(text));
    if (decoded.success) return decoded.data;
  } catch {
    // Some adapters return plain text even for a declared string schema.
  }
  return text;
}

// ─────────────────────────────────────────────────────────────
// Agent step executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute an `agent-step` node by resolving the named role and running a
 * workflow-owned session turn.
 * @param call - Call context of the handled message this node execution serves.
 * @param node - The agent step node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param task - Rendered prompt for the local session.
 * @param frameId - Frame ID of this node's frame, forwarded for session link emission.
 * @returns Terminal execution outcome for this agent step.
 */
export async function executeCallerLocalAgentStep(
  call: CallContext,
  node: WorkflowAgentStepNode,
  ctx: RuntimeContext,
  task: string,
  frameId?: string,
): Promise<CallerLocalStepOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const roleResult = await ctx.bus.requestOptional(call, WorkflowSubjects.resolveRole, {
    roleId: node.role,
  });
  if (!roleResult.handled) {
    return {
      status: 'failed',
      error: 'unknownRole',
      detail: `Role '${node.role}' could not be resolved for agent step '${node.id}'`,
    };
  }

  const outputSchema: ResponseSchemaDescriptor | undefined =
    node.outputSchema !== undefined ? { schema: node.outputSchema } : undefined;
  const resolvedConfig = resolveAgentStepConfig(node, roleResult.data);
  const outcome = await executeResolvedSubagentNode(
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
  // A finalizer receives the raw subagent result and owns the shape of its reply.
  if (
    outcome.status === 'completed' &&
    outputSchema !== undefined &&
    node.resultFinalizerId === undefined &&
    typeof outcome.output === 'string'
  ) {
    return { ...outcome, output: decodeStructuredOutput(outcome.output) };
  }
  return outcome;
}
