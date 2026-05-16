import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
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
  /** Handler for `agent.sendMessage`. */
  onSendMessage: (ctx: RequestContext<SendMessageRequestPayload, SendMessageResponsePayload>) => Promise<void>;
  /** Handler for `agent.interrupt`. */
  onInterrupt: (ctx: RequestContext<AgentInterruptRequestPayload, AgentInterruptResponsePayload>) => Promise<void>;
  /** Provider for `agent.getCapabilities` response payload. */
  getCapabilities: () => GetCapabilitiesResponsePayload;
  /** Handler for `agent.cwd.change`. */
  onCwdChange: (ctx: RequestContext<AgentCwdChangeRequestPayload, AgentCwdChangeResponsePayload>) => Promise<void>;
  /** Handler for `agent.model.change`. */
  onModelChange: (
    ctx: RequestContext<AgentModelChangeRequestPayload, AgentModelChangeResponsePayload>,
  ) => Promise<void>;
  /** Handler for `agent.mcp.servers.set`. */
  onMcpServersSet: (
    ctx: RequestContext<AgentMcpServersSetRequestPayload, AgentMcpServersSetResponsePayload>,
  ) => Promise<void>;
  /** Handler for `agent.credential.change`. */
  onCredentialChange: (
    ctx: RequestContext<AgentCredentialChangeRequestPayload, AgentCredentialChangeResponsePayload>,
  ) => Promise<void>;
}

/**
 * Register all stable `agent.*` bus handlers for a single agent instance.
 * @param config - Registration configuration with handlers
 * @returns Cleanup functions for all registrations
 */
export function registerAgentBusHandlers(config: AgentBusHandlerRegistrarConfig): Array<() => void> {
  const filteredBus = config.globalBus.withFilter({ agentId: config.agentId });

  return [
    filteredBus.on(AgentSubjects.sendMessage, config.onSendMessage),
    filteredBus.on(AgentSubjects.interrupt, config.onInterrupt),
    filteredBus.on(AgentSubjects.getCapabilities, (ctx) => {
      ctx.setResult(config.getCapabilities());
    }),
    filteredBus.on(AgentSubjects.cwd.change, config.onCwdChange),
    filteredBus.on(AgentSubjects.model.change, config.onModelChange),
    filteredBus.on(AgentSubjects.mcp.servers.set, config.onMcpServersSet),
    filteredBus.on(AgentSubjects.credential.change, config.onCredentialChange),
  ];
}
