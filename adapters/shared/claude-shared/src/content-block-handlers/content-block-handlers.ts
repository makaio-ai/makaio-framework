import { defineDiscriminatedHandlers, type DiscriminatedHandlersMap } from '@makaio/ai-adapters-core';
import { AgentSubjects } from '@makaio/contracts';
import type { BetaContentBlock } from '@makaio/client-claude-code';

/**
 * Shared content block handlers for Claude Code.
 *
 * Used by both live agent and log importer to map BetaContentBlock
 * union members to AgentSubjects.* events.
 */
export const CONTENT_BLOCK_HANDLERS = defineDiscriminatedHandlers<BetaContentBlock>('type', {
  text: (block, emit) => emit(AgentSubjects.message, { content: block.text }),

  thinking: (block, emit) => emit(AgentSubjects.reasoning, { content: block.thinking }),

  tool_use: (block, emit) =>
    emit(AgentSubjects.tool.use, {
      toolName: block.name,
      args: block.input,
      toolCallId: block.id,
    }),

  server_tool_use: (block, emit) =>
    emit(AgentSubjects.tool.started, {
      toolName: block.name,
      toolCallId: block.id,
    }),

  web_search_tool_result: (block, emit) => {
    const isError = !Array.isArray(block.content);
    return emit(AgentSubjects.tool.completed, {
      toolName: 'web_search',
      result: block.content,
      success: !isError,
      toolCallId: block.tool_use_id,
    });
  },

  code_execution_tool_result: (block, emit) => {
    const content = block.content;
    const success = content.type === 'code_execution_result' && content.return_code === 0;
    return emit(AgentSubjects.tool.completed, {
      toolName: 'code_execution',
      result: content,
      success,
      toolCallId: block.tool_use_id,
    });
  },

  // Explicit no-ops for exhaustiveness (no agent events emitted)
  redacted_thinking: (_block, _emit) => {}, // No meaningful content
  mcp_tool_use: (_block, _emit) => {}, // Handled by MCP infrastructure
  mcp_tool_result: (_block, _emit) => {}, // Handled by MCP infrastructure
  container_upload: (_block, _emit) => {}, // Not part of agent event model
} satisfies Required<DiscriminatedHandlersMap<BetaContentBlock, 'type'>>);
