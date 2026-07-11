import type { McpRuntimeSessionContext, McpSessionContext } from '@makaio/contracts';
import type { AIAgentConnector } from '../connector/index.js';
import type {
  AgentConnectorConfigOverrides,
  AgentMcpServersSetRequestPayload,
  AgentMcpServersSetResponsePayload,
} from './types.js';
import type { LedgerSessionContext } from './session-tool-ledger.js';

/** Dependencies for runtime MCP server replacement handling. */
export interface AgentMcpServersMutationManagerConfig {
  /** Read current connector. */
  getConnector: () => AIAgentConnector;
  /** Swap connector with runtime overrides. */
  swapConnectorUnlocked: (configOverrides?: AgentConnectorConfigOverrides) => Promise<void>;
  /** Persist MCP session context changes on agent config for sequential swaps. */
  setMcpSessionContext: (
    mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext | undefined,
  ) => void;
}

/** Handles `agent.mcp.servers.set` runtime mutation state. */
export class AgentMcpServersMutationManager {
  private readonly getConnector: () => AIAgentConnector;
  private readonly swapConnectorUnlocked: AgentMcpServersMutationManagerConfig['swapConnectorUnlocked'];
  private readonly setMcpSessionContext: AgentMcpServersMutationManagerConfig['setMcpSessionContext'];
  private stagedMcpServersSet?: AgentMcpServersSetRequestPayload;

  /**
   * Create the MCP mutation collaborator.
   * @param config - Runtime dependencies used inside the parent mutation barrier
   */
  public constructor(config: AgentMcpServersMutationManagerConfig) {
    this.getConnector = config.getConnector;
    this.swapConnectorUnlocked = config.swapConnectorUnlocked;
    this.setMcpSessionContext = config.setMcpSessionContext;
  }

  /** Apply the latest staged MCP replacement when the connector is idle. */
  public async applyStagedMutation(): Promise<void> {
    const staged = this.stagedMcpServersSet;
    if (staged === undefined) return;

    this.stagedMcpServersSet = undefined;
    const result = await this.handleMcpServersSet(staged);
    if (!result.success) {
      throw new Error(`Failed to apply staged MCP server replacement: ${result.reason ?? 'unknown error'}`);
    }
  }

  /**
   * Handle `agent.mcp.servers.set` request.
   * @param payload - MCP server replacement request payload.
   * @returns MCP mutation response payload.
   */
  public async handleMcpServersSet(
    payload: AgentMcpServersSetRequestPayload,
  ): Promise<AgentMcpServersSetResponsePayload> {
    const connector = this.getConnector();

    if (connector.getProcessingState() !== 'idle') {
      if (payload.turnActiveBehavior === 'stageForNextTurn') {
        this.stagedMcpServersSet = { ...payload, turnActiveBehavior: 'reject' };
        return { success: true, swapped: false, staged: true };
      }
      return { success: false, reason: 'turn_active' };
    }

    try {
      await this.swapConnectorUnlocked({ mcpSessionContext: payload.mcpSessionContext });
    } catch {
      return { success: false, reason: 'mcp_servers_set_failed: connector_replacement_failed' };
    }

    try {
      this.setMcpSessionContext(payload.mcpSessionContext);
    } catch {
      return { success: false, reason: 'mcp_servers_set_committed_postprocess_failed' };
    }
    return { success: true, swapped: true };
  }
}
