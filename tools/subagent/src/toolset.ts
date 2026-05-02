import type { z } from 'zod';
import { defineToolset, type AnyToolDefinition, type ToolDefinition } from '@makaio/tools-core';
import {
  spawnSubagentTool,
  checkSubagentTool,
  sendToSubagentTool,
  awaitSubagentTool,
  killSubagentTool,
} from './tools/parent/index.js';
import { reportProgressTool, requestInputTool, completeTaskTool } from './tools/child/index.js';

/**
 * Widens a specific ToolDefinition to AnyToolDefinition for toolset arrays.
 * This is needed because defineToolset expects AnyToolDefinition[] to avoid
 * TypeScript variance issues with heterogeneous tool collections.
 * @param tool - Specific tool definition with typed input/output schemas
 * @returns Tool widened to AnyToolDefinition
 */
function widenTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  tool: ToolDefinition<TInput, TOutput>,
): AnyToolDefinition {
  return tool;
}

/**
 * Creates the parent-side subagent toolset.
 *
 * These tools are available to agents that spawn and manage subagents:
 * - spawn_subagent: Spawn a new subagent to perform a task
 * - check_subagent: Check status and progress of a subagent
 * - send_to_subagent: Send a message or response to a subagent
 * - await_subagent: Block until subagent reaches terminal state or needs input
 * - kill_subagent: Terminate a running subagent
 *
 * Tools communicate with SubagentService via bus.request() - no local state.
 * @returns Toolset definition for parent-side subagent tools
 * @example
 * ```typescript
 * const toolset = createParentSubagentToolset();
 * ```
 */
export function createParentSubagentToolset() {
  return defineToolset({
    name: 'subagent-parent',
    description: 'Tools for spawning and managing subagents',
    version: '0.1.0',
    tools: [
      widenTool(spawnSubagentTool()),
      widenTool(checkSubagentTool()),
      widenTool(sendToSubagentTool()),
      widenTool(awaitSubagentTool()),
      widenTool(killSubagentTool()),
    ],
  });
}

/**
 * Creates the child-side subagent toolset.
 *
 * These tools are injected for agents running as subagents:
 * - report_progress: Report progress updates to parent
 * - request_input: Ask blocking question to parent
 * - complete_task: Signal task completion with result
 *
 * Tools communicate with SubagentService via bus.request() - no local state.
 * @returns Toolset definition for child-side subagent tools
 * @example
 * ```typescript
 * const toolset = createChildSubagentToolset();
 * ```
 */
export function createChildSubagentToolset() {
  return defineToolset({
    name: 'subagent-child',
    description: 'Tools for subagents to communicate with their parent',
    version: '0.1.0',
    tools: [widenTool(reportProgressTool()), widenTool(requestInputTool()), widenTool(completeTaskTool())],
  });
}
