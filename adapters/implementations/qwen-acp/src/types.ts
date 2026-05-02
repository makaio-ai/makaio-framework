import type { BaseAgentConnectorConfig, LedgerSessionContext } from '@makaio/ai-adapters-core';
import type { McpSessionContext } from '@makaio/contracts';
import type { QwenAcpBus } from './namespaces/index.js';

/**
 * Qwen ACP connector configuration.
 *
 * Overrides the inherited `mcpSessionContext` to accept the full
 * {@link McpSessionContext} shape so the connector can extract `servers`
 * for ACP session setup. Follows the same Omit + intersection pattern
 * as ClaudeAgentConfig and BaseStreamConnectorConfig.
 */
export type QwenAcpConnectorConfig = Omit<BaseAgentConnectorConfig<QwenAcpBus>, 'mcpSessionContext'> & {
  adapterId: string;
  /**
   * MCP session context — accepts both the full {@link McpSessionContext}
   * (with `servers` for ACP passthrough) and the narrower
   * {@link LedgerSessionContext} for standalone ledger scenarios.
   */
  mcpSessionContext?: McpSessionContext | LedgerSessionContext;
};
