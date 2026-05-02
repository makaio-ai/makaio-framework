/**
 * Agent rehydration manager.
 *
 * Handles the `adapter.rehydrateAgent` RPC subject, including per-agent
 * single-flight deduplication, MCP session context re-resolution, and
 * system prompt recovery from persisted persona/profile IDs.
 */
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AIAgentConnector } from '../agent/index.js';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentCreationOptions } from './types.js';
import type { McpSessionContext } from '@makaio/contracts';
import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import { AdapterSubjects, McpSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { buildProviderContext } from '@makaio/services-core/provider-context';
import { createSentinelProviderContext } from '../utils/index.js';
import { restoreAgentUsageFromTurns } from './restore-agent-usage.js';

type RehydrateAgentRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.rehydrateAgent>;
type RehydrateAgentResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>;

/**
 * Configuration for AgentRehydrationManager construction.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export interface AgentRehydrationManagerConfig<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
> {
  /** Global bus for storage and service resolution calls. */
  globalBus: IMakaioBus;
  /** Agent registry for entry lookup and registration. */
  registry: AgentRegistry<TBus, TConnector, TAgent>;
  /** Factory that produces a new agent instance (delegates to adapter.createAgent). */
  createAgent: (agentId: string, sessionId: string, options: AgentCreationOptions) => Promise<TAgent>;
}

/**
 * Manages agent rehydration with single-flight deduplication.
 *
 * Handles both warm-path (agent already in registry, swap connector) and
 * cold-path (agent only in storage, full resurrection) rehydration.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export class AgentRehydrationManager<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  /** In-flight rehydrate operations keyed by agentId (single-flight dedupe). */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly globalBus: IMakaioBus;
  private readonly registry: AgentRegistry<TBus, TConnector, TAgent>;
  private readonly createAgentFn: (
    agentId: string,
    sessionId: string,
    options: AgentCreationOptions,
  ) => Promise<TAgent>;

  public constructor(config: AgentRehydrationManagerConfig<TBus, TConnector, TAgent>) {
    this.globalBus = config.globalBus;
    this.registry = config.registry;
    this.createAgentFn = config.createAgent;
  }

  /**
   * RPC handler: adapter.rehydrateAgent with per-agent single-flight dedupe.
   * @param ctx - Request context containing target agentId and optional runtime overrides
   */
  public handleRehydrateAgent = async (
    ctx: RequestContext<RehydrateAgentRequestPayload, RehydrateAgentResponsePayload>,
  ): Promise<void> => {
    const { agentId, cwd, model } = ctx.payload;
    const existing = this.inFlight.get(agentId);
    if (existing) {
      await existing;
      ctx.setResult({});
      return;
    }

    const rehydratePromise = (async (): Promise<void> => {
      const entry = this.registry.get(agentId);
      if (entry) {
        await entry.agent.swapConnector({ cwd, model });
        const refreshedAdapterSessionId = await entry.agent.getAdapterSessionId();
        if (refreshedAdapterSessionId) {
          entry.adapterSessionId = refreshedAdapterSessionId;
        }
        if (cwd !== undefined || model !== undefined) {
          await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, { agentId, cwd, model });
        }
        await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
        return;
      }
      const result = await this.globalBus.requestOptional(AgentStorageSubjects.get, { agentId });
      if (!result.handled || !result.data.agent) {
        throw new Error(`Agent ${agentId} not found in storage`);
      }
      const persisted = result.data.agent;
      if (persisted.status === 'disposed') {
        throw new Error(`Agent ${agentId} is disposed and cannot be rehydrated`);
      }
      // Re-resolve MCP session context from persisted keys so the rehydrated agent
      // regains tool ledger and native passthrough. Best-effort: resolves to
      // undefined if the MCP service is unavailable on this process start.
      const mcpSessionContext = await this.resolveMcpSessionContext(persisted.sessionId, persisted.profileId);
      // Falls back to sentinel when provider config was deleted between sessions.
      const providerContext =
        persisted.providerConfigId !== undefined
          ? await buildProviderContext(this.globalBus, persisted.providerConfigId).catch(() =>
              createSentinelProviderContext(),
            )
          : undefined;
      const agentCreationRequest: AgentCreationOptions = {
        model: model ?? persisted.model,
        cwd: cwd ?? persisted.cwd,
        ...(providerContext !== undefined && { providerContext }),
        ...(mcpSessionContext !== undefined && { mcpSessionContext }),
      };
      const newAgent = await this.createAgentFn(agentId, persisted.sessionId, agentCreationRequest);
      // Re-resolve the system prompt via the host-tier RPC so the rehydrated
      // agent retains its identity after a process restart. Resolution is
      // best-effort: if the host handler is unavailable the agent still
      // initialises, just without its runtime system prompt.
      const systemPrompt = await this.resolvePersistedSystemPrompt(
        persisted.sessionId,
        persisted.personaId,
        persisted.profileId,
      );
      await newAgent.initialize({ ...(systemPrompt !== undefined && { systemPrompt }) });
      if (cwd !== undefined || model !== undefined) {
        await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, { agentId, cwd, model });
      }
      // Prefer the live connector session id. Persisted values can be stale after restart/swap.
      const recoveredAdapterSessionId = (await newAgent.getAdapterSessionId()) || persisted.adapterSessionId;
      if (!recoveredAdapterSessionId) {
        throw new Error(`Recovered agent ${agentId} has no adapterSessionId`);
      }
      // Restore cumulative usage baseline from persisted turn history.
      // Without this, the adapter's in-memory totals would restart from zero
      // after every process restart, making session-level usage unreliable.
      const restoredUsage = await restoreAgentUsageFromTurns(this.globalBus, persisted.sessionId, agentId);

      this.registry.set(agentId, {
        agent: newAgent,
        sessionId: persisted.sessionId,
        adapterSessionId: recoveredAdapterSessionId,
        usage: restoredUsage,
      });
      await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to recover agent ${agentId}: ${message}`);
    });

    this.inFlight.set(agentId, rehydratePromise);

    try {
      await rehydratePromise;
    } finally {
      this.inFlight.delete(agentId);
    }

    ctx.setResult({});
  };

  /**
   * Re-resolve MCP session context from persisted resolution keys on rehydrate.
   *
   * Called during agent rehydration to restore the MCP session context (tool
   * ledger and native passthrough) that was active when the agent was originally
   * started. Resolution is best-effort: if the MCP service is unavailable the
   * method returns `undefined` and the agent re-initialises without MCP tools.
   *
   * We intentionally do NOT persist the full `McpSessionContext` verbatim —
   * server configs may have changed between restarts. Instead we re-resolve from
   * the stable keys (`sessionId`, `profileId`) that were persisted with
   * the agent / session records. Project scope is resolved separately by
   * host-tier code via the session-scopes junction table.
   *
   * The `profileMcpConfig` field is omitted so the MCP service applies only
   * server-level filtering. Profile-level tool overrides require the resolved
   * profile config, which the rehydrate path does not hold. This is a known
   * trade-off: the agent resumes with correct server connectivity but without
   * per-profile direct/discovery overrides until the next full turn is initiated
   * through the orchestrator.
   * @param sessionId - Makaio session ID (used as the MCP resolution key)
   * @param profileId - Profile ID persisted with the agent, or `undefined`
   * @returns Resolved MCP session context, or `undefined` if unavailable
   */
  private async resolveMcpSessionContext(
    sessionId: string,
    profileId: string | undefined,
  ): Promise<McpSessionContext | undefined> {
    // Fetch the session to verify it still exists before attempting MCP resolution.
    const sessionResult = await this.globalBus.requestOptional(SessionSubjects.get, { sessionId });
    if (!sessionResult.handled || !sessionResult.data.session) {
      return undefined;
    }
    const mcpResult = await this.globalBus.requestOptional(McpSubjects.session.resolve, {
      sessionId,
      projectId: null,
      profileId: profileId ?? null,
    });

    return mcpResult.handled ? mcpResult.data : undefined;
  }

  /**
   * Resolve the runtime system prompt via the host-tier
   * `session.resolveSystemPrompt` RPC.
   *
   * Called during agent rehydration to restore the system prompt that was
   * active when the agent was originally started. Delegates persona/profile
   * storage reads to the host tier so this adapter remains free of
   * host-tier storage subject imports. Resolution is best-effort: if the
   * host handler is unavailable the method returns `undefined` and the
   * agent initialises without a system prompt rather than failing.
   * @param sessionId - Session ID for the RPC call
   * @param personaId - Persisted persona ID, if any
   * @param profileId - Persisted profile ID, if any
   * @returns Resolved system prompt string, or `undefined` if unavailable
   */
  private async resolvePersistedSystemPrompt(
    sessionId: string,
    personaId: string | undefined,
    profileId: string | undefined,
  ): Promise<string | undefined> {
    if (!personaId && !profileId) return undefined;
    try {
      const result = await this.globalBus.requestOptional(SessionSubjects.resolveSystemPrompt, {
        sessionId,
        personaId,
        profileId,
      });
      return result.handled ? result.data.systemPrompt : undefined;
    } catch {
      return undefined;
    }
  }
}
