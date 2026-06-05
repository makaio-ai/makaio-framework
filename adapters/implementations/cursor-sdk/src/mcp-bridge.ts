import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import type { CursorSessionConfig } from './types/index.js';

/** Result of MCP session registration. */
export interface McpRegistrationResult {
  /** Port of the MCP HTTP server, or undefined if bridge unavailable. */
  port: number | undefined;
}

/**
 * Register an MCP session with the bridge service for tool injection.
 *
 * Uses `MakaioBus.requestOptional` so graceful degradation occurs when the
 * MCP bridge service is not running (e.g., in tests or CLI-only environments).
 * @param config - Session configuration for context overrides.
 * @param adapterSessionId - The Cursor agent ID used as session identifier.
 * @returns Registration result with port (or undefined if bridge unavailable).
 */
export async function registerMcpSession(
  config: CursorSessionConfig,
  adapterSessionId: string,
): Promise<McpRegistrationResult> {
  // MakaioBus (global singleton) is intentional here — MCP subjects live in
  // the `mcp` namespace, which is unreachable from the adapter's scoped bus.
  // Same pattern used by ToolSubjects.execute and AgentSubjects throughout
  // the adapter layer for all cross-namespace RPCs.
  const result = await MakaioBus.requestOptional(McpSubjects.session.register, {
    adapterSessionId,
    agentId: config.agentId,
    adapterId: config.adapterId,
    adapterName: config.adapterName,
    // Makaio session ID routes approval requests to the owning browser tab.
    // Falls back to the adapter session ID when not running within a UI session.
    sessionId: config.makaioSessionId ?? adapterSessionId,
    pinned: true,
    contextOverrides: {
      cwd: config.cwd,
      env: config.env,
      sessionId: config.makaioSessionId,
      agentId: config.agentId,
    },
  });

  if (result.handled) {
    return { port: result.data.port };
  }

  return { port: undefined };
}

/**
 * Build the MCP server configuration for Cursor Agent creation.
 *
 * Returns a `mcpServers` entry object suitable for passing to AgentOptions,
 * or undefined when the MCP bridge is not available.
 * @param port - MCP server port returned by {@link registerMcpSession}.
 * @param adapterSessionId - Session identifier for query-param routing.
 * @returns MCP server entry for AgentOptions.mcpServers, or undefined if no port.
 */
export function buildMcpServerConfig(
  port: number | undefined,
  adapterSessionId: string,
): Record<string, { type: 'http'; url: string }> | undefined {
  if (port == null) return undefined;
  const url = `http://127.0.0.1:${port}/mcp?adapterSessionId=${encodeURIComponent(adapterSessionId)}`;
  return { makaio: { type: 'http', url } };
}

/**
 * Unregister an MCP session from the bridge service.
 *
 * Best-effort: if the bridge service is not available or the call fails,
 * the stale mapping will be cleaned up by the bridge's own session expiry.
 * @param adapterSessionId - The session to unregister.
 */
export async function unregisterMcpSession(adapterSessionId: string): Promise<void> {
  try {
    await MakaioBus.requestOptional(McpSubjects.session.unregister, {
      adapterSessionId,
    });
  } catch {
    // Best-effort cleanup — ignore bridge failures during teardown.
  }
}
