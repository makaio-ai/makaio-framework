import type { McpAgentContext } from '@makaio/contracts';

/**
 * Registry mapping adapterSessionId to agent context.
 *
 * The adapter registers context before spawning Claude CLI; the MCP server
 * reads it when handling approval requests (via adapterSessionId from URL query).
 */
export interface IMcpContextRegistry {
  /**
   * Register agent context for an adapter session.
   * @param adapterSessionId - Adapter session identifier
   * @param context - Agent context to store
   */
  register(adapterSessionId: string, context: McpAgentContext): void;

  /**
   * Retrieve agent context for an adapter session.
   * @param adapterSessionId - Adapter session identifier
   * @returns Stored agent context, or undefined if not registered
   */
  get(adapterSessionId: string): McpAgentContext | undefined;

  /**
   * Remove agent context for an adapter session.
   * @param adapterSessionId - Adapter session identifier
   */
  unregister(adapterSessionId: string): void;
}

/**
 * Simple Map-backed implementation of {@link IMcpContextRegistry}.
 *
 * Created once per adapter instance, shared with the HTTP MCP server so
 * approval requests can resolve agent context from the URL query param.
 */
export class McpContextRegistry implements IMcpContextRegistry {
  private readonly registry = new Map<string, McpAgentContext>();

  /**
   * Register agent context for an adapter session.
   * @param adapterSessionId - Adapter session identifier
   * @param context - Agent context to store
   */
  public register(adapterSessionId: string, context: McpAgentContext): void {
    this.registry.set(adapterSessionId, context);
  }

  /**
   * Retrieve agent context for an adapter session.
   * @param adapterSessionId - Adapter session identifier
   * @returns Stored agent context, or undefined if not registered
   */
  public get(adapterSessionId: string): McpAgentContext | undefined {
    return this.registry.get(adapterSessionId);
  }

  /**
   * Remove agent context for an adapter session.
   * @param adapterSessionId - Adapter session identifier
   */
  public unregister(adapterSessionId: string): void {
    this.registry.delete(adapterSessionId);
  }
}
