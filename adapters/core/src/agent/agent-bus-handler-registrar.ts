import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, McpSubjects, SessionSubjects } from '@makaio/contracts';
import type { RequestContext } from '@makaio/core';
import type {
  AgentCredentialChangeRequestPayload,
  AgentCredentialChangeResponsePayload,
  AgentCwdChangeRequestPayload,
  AgentCwdChangeResponsePayload,
  AgentInterruptRequestPayload,
  AgentInterruptResponsePayload,
  AgentModelChangeRequestPayload,
  AgentModelChangeResponsePayload,
  AgentMcpServersSetRequestPayload,
  AgentMcpServersSetResponsePayload,
  GetCapabilitiesResponsePayload,
  SendMessageRequestPayload,
  SendMessageResponsePayload,
} from './types.js';

/**
 * Handler bundle required to register all `agent.*` request handlers.
 */
export interface AgentBusHandlerRegistrarConfig {
  /** Global bus instance where handlers are registered. */
  globalBus: IMakaioBus;
  /** Target agent identity for filter scoping. */
  agentId: string;
  /** Makaio session identity for canonical turn-number observation. */
  sessionId?: string;
  /** Handler for `agent.sendMessage`. */
  onSendMessage: (ctx: RequestContext<SendMessageRequestPayload, SendMessageResponsePayload>) => Promise<void>;
  /** Handler for `agent.interrupt`. */
  onInterrupt: (ctx: RequestContext<AgentInterruptRequestPayload, AgentInterruptResponsePayload>) => Promise<void>;
  /** Provider for `agent.getCapabilities` response payload. */
  getCapabilities: () => GetCapabilitiesResponsePayload;
  /** Apply an `agent.cwd.change` payload. */
  onCwdChange: (payload: AgentCwdChangeRequestPayload) => Promise<AgentCwdChangeResponsePayload>;
  /** Apply an `agent.model.change` payload. */
  onModelChange: (payload: AgentModelChangeRequestPayload) => Promise<AgentModelChangeResponsePayload>;
  /** Apply an `agent.mcp.servers.set` payload. */
  onMcpServersSet: (payload: AgentMcpServersSetRequestPayload) => Promise<AgentMcpServersSetResponsePayload>;
  /** Apply an `agent.credential.change` payload. */
  onCredentialChange: (payload: AgentCredentialChangeRequestPayload) => Promise<AgentCredentialChangeResponsePayload>;
  /** Observe the canonical session turn number. */
  onTurnStarted: (turnNumber: number) => void;
  /** Mark connector tools stale after an MCP catalog mutation. */
  onMcpToolsChanged: () => void;
}

/**
 * Register all stable `agent.*` bus handlers for a single agent instance.
 * @param config - Registration configuration with handlers
 * @returns Cleanup functions for all registrations
 */
export function registerAgentBusHandlers(config: AgentBusHandlerRegistrarConfig): Array<() => void> {
  const filteredBus = config.globalBus.withFilter({ agentId: config.agentId });
  const cleanups = [
    filteredBus.on(AgentSubjects.sendMessage, config.onSendMessage),
    filteredBus.on(AgentSubjects.interrupt, config.onInterrupt),
    filteredBus.on(AgentSubjects.getCapabilities, (ctx) => {
      ctx.setResult(config.getCapabilities());
    }),
    filteredBus.on(AgentSubjects.cwd.change, async (ctx) => {
      ctx.setResult(await config.onCwdChange(ctx.payload));
    }),
    filteredBus.on(AgentSubjects.model.change, async (ctx) => {
      ctx.setResult(await config.onModelChange(ctx.payload));
    }),
    filteredBus.on(AgentSubjects.mcp.servers.set, async (ctx) => {
      ctx.setResult(await config.onMcpServersSet(ctx.payload));
    }),
    filteredBus.on(AgentSubjects.credential.change, async (ctx) => {
      ctx.setResult(await config.onCredentialChange(ctx.payload));
    }),
    config.globalBus.on(McpSubjects.tools.updated, config.onMcpToolsChanged),
    config.globalBus.on(McpSubjects.tools.enabled, config.onMcpToolsChanged),
  ];
  if (config.sessionId !== undefined) {
    cleanups.push(
      config.globalBus.on(
        SessionSubjects.turn.started,
        (ctx) => {
          if (ctx.payload.agentIds.includes(config.agentId)) {
            config.onTurnStarted(ctx.payload.turnNumber);
          }
        },
        { filter: { sessionId: config.sessionId } },
      ),
    );
  }
  return cleanups;
}
