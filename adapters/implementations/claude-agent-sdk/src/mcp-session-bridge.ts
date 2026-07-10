import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import type { ClaudeSessionConfig } from './types/index.js';

/**
 * Register an adapter session with the singleton MCP bridge service via bus RPC.
 *
 * MakaioBus (global singleton) is intentional here — MCP subjects live in the
 * `mcp` namespace, which is unreachable from the adapter's scoped bus. Same
 * pattern used by ToolSubjects.execute and AgentSubjects throughout the
 * adapter layer for all cross-namespace RPCs.
 * @param adapterSessionId - Provider session ID to register
 * @param config - Session config supplying agent/adapter identity and context overrides
 * @returns The bridge's MCP server port, or `undefined` when the bridge service is not running
 */
export async function registerMcpSession(
  adapterSessionId: string,
  config: ClaudeSessionConfig,
): Promise<number | undefined> {
  const makaioSessionId = config.sessionId ?? adapterSessionId;
  const result = await MakaioBus.requestOptional(McpSubjects.session.register, {
    adapterSessionId,
    agentId: config.agentId,
    adapterId: config.adapterId,
    adapterName: config.adapterName,
    sessionId: makaioSessionId,
    contextOverrides: {
      cwd: config.cwd,
      env: config.env,
      sessionId: makaioSessionId,
      agentId: config.agentId,
      adapterSessionId,
    },
  });
  return result.handled ? result.data.port : undefined;
}

/**
 * Unregister an adapter session from the singleton MCP bridge service.
 * Fire-and-forget: errors are swallowed to avoid masking the close/abort path.
 * @param adapterSessionId - Provider session ID to unregister
 */
export function unregisterMcpSession(adapterSessionId: string): void {
  void MakaioBus.requestOptional(McpSubjects.session.unregister, {
    adapterSessionId,
  }).catch(() => {
    // Best-effort cleanup — ignore bridge failures during teardown.
  });
}
