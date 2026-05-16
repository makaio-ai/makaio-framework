import type { IMakaioBus } from '@makaio/bus-core';
import { McpSubjects, type McpResolvedServer } from '@makaio/contracts';
import { ModelRegistryPublicSubjects } from '@makaio/contracts/model-registry';
import type { AccountInfo, McpServerStatus, ModelInfo, SlashCommand } from './types.js';

// ---------------------------------------------------------------------------
// Public introspection functions
// ---------------------------------------------------------------------------

/**
 * Return all models available across all providers.
 * @param bus - Bus instance used for the contracts-level model registry RPC.
 * @returns SDK-safe model descriptors from the runtime model registry.
 */
export async function supportedModels(bus: IMakaioBus): Promise<ModelInfo[]> {
  const result = await bus.requestOptional(ModelRegistryPublicSubjects.supportedModels, {});
  return result.handled ? result.data.models : [];
}

/**
 * Return the status of configured MCP servers for a session.
 *
 * When a `sessionId` is supplied the function calls `mcp.session.resolve` to
 * retrieve the list of servers configured for that session. Each entry is
 * returned with status `'configured'` — the bus contract does not expose
 * runtime connection state via RPC (connection lifecycle is event-driven via
 * `mcp.server.connected` / `mcp.server.disconnected`).
 *
 * When no `sessionId` is provided the function returns an empty array because
 * there is no global server-status RPC in the MCP contract.
 * @param bus - Bus instance used to resolve session MCP context.
 * @param sessionId - Makaio session ID to scope the lookup.
 * @returns Array of server status objects, or empty array when `sessionId` is omitted.
 */
export async function mcpServerStatus(bus: IMakaioBus, sessionId?: string): Promise<McpServerStatus[]> {
  if (sessionId === undefined) {
    return [];
  }

  const ctx = await bus.request(McpSubjects.session.resolve, {
    sessionId,
    profileId: null,
    projectId: null,
  });

  return ctx.servers.map((server: McpResolvedServer) => ({
    name: server.name,
    status: 'configured',
  }));
}

/**
 * Return account information for the active provider.
 *
 * This is a best-effort function — there is no bus RPC that exposes account
 * credentials or email addresses from the SDK boundary. Only the adapter name
 * is available from call-site context.
 * @param _bus - Bus instance (reserved for future implementation).
 * @param adapterName - Optional name of the active adapter/provider.
 * @returns Account info with the provider name set, email omitted.
 */
export async function accountInfo(_bus: IMakaioBus, adapterName?: string): Promise<AccountInfo> {
  return { provider: adapterName ?? 'unknown' };
}

/**
 * Return the list of supported slash commands.
 *
 * Makaio does not expose slash commands in the SDK context — commands are a
 * harness-specific UI concept and are not part of the agent bus protocol.
 * @returns Empty array.
 */
export function supportedCommands(): SlashCommand[] {
  return [];
}
