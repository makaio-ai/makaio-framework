/**
 * In-memory registry of active agents with session info and usage totals.
 *
 * Consolidates agent tracking, eviction, disposal, and usage accumulation
 * into a single collaborator, eliminating shotgun surgery from parallel
 * Map updates across adapter operations.
 */
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AIAgentConnector } from '../agent/index.js';
import type { AgentUsageTotals } from './types.js';
import { AgentStorageSubjects } from '@makaio/services-core/session';

/**
 * Registry entry consolidating agent instance with session info and usage totals.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export interface AgentRegistryEntry<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  /** The agent instance. */
  agent: TAgent;
  /** Makaio session ID. */
  sessionId: string;
  /** Provider-specific session ID. */
  adapterSessionId: string;
  /** Cumulative usage totals for this agent. */
  usage: AgentUsageTotals;
}

/**
 * Configuration for AgentRegistry construction.
 */
export interface AgentRegistryConfig {
  /** Global bus for storage status updates during evict/dispose. */
  globalBus: IMakaioBus;
  /** Adapter name for error-log context. */
  adapterName: string;
}

/**
 * In-memory registry of active agents.
 *
 * Owns the Map, entry manipulation, eviction (close + mark dead),
 * disposal (close + mark disposed), and usage accumulation.
 * The adapter delegates all agent-tracking operations here.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export class AgentRegistry<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  private readonly entries = new Map<string, AgentRegistryEntry<TBus, TConnector, TAgent>>();
  private readonly globalBus: IMakaioBus;
  private readonly adapterName: string;

  public constructor(config: AgentRegistryConfig) {
    this.globalBus = config.globalBus;
    this.adapterName = config.adapterName;
  }

  /**
   * Register a new agent entry.
   * @param agentId - Agent identifier
   * @param entry - Registry entry to store
   */
  public set(agentId: string, entry: AgentRegistryEntry<TBus, TConnector, TAgent>): void {
    this.entries.set(agentId, entry);
  }

  /**
   * Get a registry entry by agent ID.
   * @param agentId - Agent identifier
   * @returns Registry entry or undefined
   */
  public get(agentId: string): AgentRegistryEntry<TBus, TConnector, TAgent> | undefined {
    return this.entries.get(agentId);
  }

  /**
   * Return all entries as an iterable (for closeAsync iteration).
   * @returns Iterable of registry entries
   */
  public values(): IterableIterator<AgentRegistryEntry<TBus, TConnector, TAgent>> {
    return this.entries.values();
  }

  /**
   * Clear all entries (used after closeAsync has already closed all agents).
   */
  public clear(): void {
    this.entries.clear();
  }

  /**
   * Evict an agent from memory and mark as dead in storage.
   * @param agentId - Agent identifier
   */
  public async evict(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    this.entries.delete(agentId);
    if (entry) await entry.agent.close();
    await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'dead' });
  }

  /**
   * Evict an agent without updating storage status. Used for ephemeral agents
   * that were never persisted.
   * @param agentId - Agent to evict
   */
  public async evictSilently(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    this.entries.delete(agentId);
    if (!entry) return;
    try {
      await entry.agent.close({ emitSessionClosed: false });
    } catch (error) {
      console.warn(`[AgentRegistry:${this.adapterName}] Agent ${agentId} close error during silent eviction:`, error);
    }
  }

  /**
   * Dispose an agent: close it, remove from registry, mark as disposed in storage.
   * @param agentId - Agent identifier
   * @returns true if the agent was found and disposed
   */
  public dispose(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    if (!entry) return false;
    void entry.agent.close().catch((error) => {
      console.warn(`[AgentRegistry:${this.adapterName}] Agent ${agentId} close error during dispose:`, error);
    });
    this.entries.delete(agentId);
    void this.globalBus
      .requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' })
      .catch((error) => {
        console.warn(`[AgentRegistry:${this.adapterName}] Failed to mark agent ${agentId} as disposed:`, error);
      });
    return true;
  }

  /**
   * Accumulate a usage delta for an agent and optionally update adapterSessionId.
   *
   * Returns the updated entry so the adapter can emit session usage events
   * with the current totals.
   * @param agentId - Agent identifier
   * @param delta - Token usage delta to apply
   * @param newAdapterSessionId - Updated adapter session ID if connector swapped
   * @returns The updated entry, or undefined if agent not found
   */
  public accumulateUsage(
    agentId: string,
    delta: { inputTokens: number; outputTokens: number },
    newAdapterSessionId?: string,
  ): AgentRegistryEntry<TBus, TConnector, TAgent> | undefined {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;

    entry.usage.totalInputTokens += delta.inputTokens;
    entry.usage.totalOutputTokens += delta.outputTokens;
    entry.usage.totalCalls++;

    // Keep registry in sync with connector swaps the adapter doesn't directly observe
    // (agent-level cwd.change / model.change). The event payload carries the
    // current adapterSessionId via enrichPayload.
    if (newAdapterSessionId && newAdapterSessionId !== entry.adapterSessionId) {
      entry.adapterSessionId = newAdapterSessionId;
    }

    return entry;
  }

  /**
   * Find all agent IDs belonging to a given session.
   * @param sessionId - Makaio session ID
   * @returns Array of matching agent IDs
   */
  public agentIdsBySession(sessionId: string): string[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.sessionId === sessionId).map(([agentId]) => agentId);
  }
}
