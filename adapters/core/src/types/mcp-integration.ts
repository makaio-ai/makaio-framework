import type { McpResolvedServer, McpSessionContext, McpToolState, ToolListItem } from '@makaio/contracts';

/**
 * Describes a change to the MCP tool set mid-session.
 * Delivered to adapters that support mid-session tool changes.
 */
export interface McpToolChange {
  /** Tools newly available */
  readonly added: readonly McpToolState[];
  /** Tools no longer available */
  readonly removed: readonly string[];
}

/**
 * Discriminated union of resources an adapter receives from McpService.
 * Uses Makaio-native types, NOT SDK-specific types.
 * Each adapter converts to its SDK's format internally.
 */
export type McpSessionResources =
  | { readonly mode: 'native-passthrough'; readonly servers: Record<string, McpResolvedServer> }
  | { readonly mode: 'tool-injection'; readonly tools: readonly ToolListItem[] }
  | { readonly mode: 'observe-only' };

/**
 * Adapter-specific MCP consumption strategy.
 *
 * Each adapter that supports MCP implements this interface to declare
 * how it consumes MCP tools. Defined in adapter-core to avoid circular
 * dependencies (McpService imports this interface, adapters implement it).
 */
export interface McpIntegrationStrategy {
  /** What this adapter needs from McpService */
  readonly mode: 'native-passthrough' | 'tool-injection' | 'observe-only';

  /**
   * Whether this adapter supports mid-session tool list changes.
   * If false, deferred injection is used (bridge current turn, native next turn).
   */
  readonly supportsMidSessionToolChange: boolean;

  /**
   * Called when a session starts. Returns adapter-specific resources.
   * @param context - Resolved MCP config for this session (post-visibility-chain)
   * @returns Resources the adapter needs to consume MCP tools
   */
  prepareMcpForSession(context: McpSessionContext): Promise<McpSessionResources>;

  /**
   * Called when MCP tools change mid-session (server reconnect, dynamic enable).
   * Only invoked if `supportsMidSessionToolChange` is true.
   * @param changes - Description of what tools changed
   */
  onToolsChanged?(changes: McpToolChange): Promise<void>;
}
