import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { CanUseToolCallback } from './types.js';

/**
 * Register a tool approval handler that bridges canUseTool callback to the bus.
 * @param bus - The bus instance to register on.
 * @param agentId - Agent ID to filter approval requests.
 * @param canUseTool - User-provided approval callback.
 * @returns Unsubscribe function that removes the handler.
 */
export function registerToolApprovalHandler(
  bus: IMakaioBus,
  agentId: string,
  canUseTool: CanUseToolCallback,
): () => void {
  return bus.on(
    AgentSubjects.toolApprove,
    async (ctx) => {
      const { toolName, args } = ctx.payload;
      const result = await canUseTool(toolName ?? '', (args as Record<string, unknown>) ?? {});
      if (result.behavior === 'allow') {
        ctx.setResult({
          action: 'allow' as const,
          updatedInput: result.updatedInput,
        });
      } else {
        ctx.setResult({
          action: 'deny' as const,
          message: result.message,
          shouldAbort: result.interrupt ?? false,
        });
      }
    },
    { filter: { agentId }, priority: 50 },
  );
}
