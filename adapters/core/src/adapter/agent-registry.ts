/**
 * In-memory registry of active (running) agent instances.
 *
 * Consolidates agent tracking, eviction, disposal, and usage accumulation
 * into a single collaborator, eliminating shotgun surgery from parallel
 * Map updates across adapter operations.
 *
 * Named "Active" to distinguish from a future definition/configuration
 * registry (`AgentRegistry`) that catalogs agent definitions rather than
 * live instances.
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
export interface ActiveAgentEntry<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  /** The agent instance. */
  agent: TAgent;
  /** Makaio session ID. */
  sessionId: string;
  /**
   * Provider-specific session ID as last reconciled from the agent's bus events.
   *
   * Not the occupancy authority — {@link occupiedAdapterSessionId} is. This field
   * is written at registration and then reconciled from `agent.started` and
   * `agent.usage`, so it lags any connector swap until the agent's next usage
   * event. Its remaining jobs are reporting a pinned identity the provider has
   * not confirmed yet, and serving as the baseline that tells a rehydrate whether
   * the identity moved far enough to persist.
   *
   * `undefined` for idle fork starts until the provider confirms via first dispatch.
   */
  adapterSessionId: string | undefined;
  /** Cumulative usage totals for this agent. */
  usage: AgentUsageTotals;
}

/**
 * Provider session an entry currently occupies.
 *
 * The agent's live confirmed identity wins over the entry's reconciled
 * {@link ActiveAgentEntry.adapterSessionId}. A connector swap announces the
 * swapped-in ID on the movement seam immediately, which is what turns it into the
 * session row's resume currency, while the entry field only catches up on the
 * agent's next usage event. An occupancy check reading the lagging field in that
 * window reports "no live writer" for a provider session this agent is already
 * writing to, so a resume attach resolving the freshly published currency claims
 * it for a second agent.
 *
 * Falls back to the entry field, which is the only identity available before the
 * provider confirms one: a start pinned to a requested ID, or an idle fork.
 *
 * Typed structurally rather than as {@link ActiveAgentEntry} so it stays callable
 * from the registry's generic methods without restating their three type
 * parameters; it reads only the two fields named above.
 * @param entry - Registry entry to resolve
 * @returns Provider session the entry occupies, or `undefined` when it holds none
 */
export function occupiedAdapterSessionId(entry: {
  readonly agent: { readonly currentAdapterSessionId: string | undefined };
  readonly adapterSessionId: string | undefined;
}): string | undefined {
  return entry.agent.currentAdapterSessionId ?? entry.adapterSessionId;
}

/** Registry entry projected onto the shape the adapter's agent RPCs return. */
export interface AgentSummary {
  /** Stable agent identifier. */
  readonly agentId: string;
  /** Owning Makaio session. */
  readonly sessionId: string;
  /** Provider session the agent currently occupies. */
  readonly adapterSessionId: string | undefined;
}

/**
 * Project a registry entry onto the summary `listAgents` and `getAgent` return.
 *
 * Shared so both RPCs report {@link occupiedAdapterSessionId} rather than the
 * lagging entry field. This matters most for `listAgents`: it is what the service
 * tier's resume live-writer guard reads.
 * @param entry - Registry entry to project
 * @returns Agent summary carrying the occupied provider session
 */
export function toAgentSummary(entry: {
  readonly agent: { readonly agentId: string; readonly currentAdapterSessionId: string | undefined };
  readonly sessionId: string;
  readonly adapterSessionId: string | undefined;
}): AgentSummary {
  return {
    agentId: entry.agent.agentId,
    sessionId: entry.sessionId,
    adapterSessionId: occupiedAdapterSessionId(entry),
  };
}

/**
 * Configuration for ActiveAgentRegistry construction.
 */
export interface ActiveAgentRegistryConfig {
  /** Global bus for storage status updates during evict/dispose. */
  globalBus: IMakaioBus;
  /** Adapter name for error-log context. */
  adapterName: string;
}

/**
 * In-memory registry of active (running) agent instances.
 *
 * Owns the Map, entry manipulation, eviction (close + mark dead),
 * disposal (close + mark disposed), and usage accumulation.
 * The adapter delegates all agent-tracking operations here.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export class ActiveAgentRegistry<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  private readonly entries = new Map<string, ActiveAgentEntry<TBus, TConnector, TAgent>>();
  /**
   * Provider-native session IDs claimed by in-flight startAgent calls.
   *
   * Prevents TOCTOU races where two concurrent resume-attach requests both
   * pass the live-writer guard before either agent finishes starting. A
   * claim is atomically checked and inserted in `claimAdapterSession()`,
   * settled by `set()` (which replaces the claim with a real entry, including
   * when the start rotated away from the claimed identity), and explicitly
   * released via `releaseAdapterSessionClaim()` on failure.
   */
  private readonly pendingAdapterSessionClaims = new Set<string>();
  private readonly globalBus: IMakaioBus;
  private readonly adapterName: string;

  public constructor(config: ActiveAgentRegistryConfig) {
    this.globalBus = config.globalBus;
    this.adapterName = config.adapterName;
  }

  /**
   * Atomically claim a provider-native session ID for an in-flight start.
   *
   * Returns `true` when the claim succeeds (no registered entry or pending
   * claim already holds the same `adapterSessionId`). Returns `false` when
   * the session is already occupied. The claim is automatically cleared
   * when `set()` registers the real entry, or explicitly via
   * `releaseAdapterSessionClaim()` on failure.
   * @param adapterSessionId - Provider-native session ID to claim
   * @returns `true` if the claim was granted
   */
  public claimAdapterSession(adapterSessionId: string): boolean {
    if (this.pendingAdapterSessionClaims.has(adapterSessionId)) {
      return false;
    }
    for (const entry of this.entries.values()) {
      if (occupiedAdapterSessionId(entry) === adapterSessionId) {
        return false;
      }
    }
    this.pendingAdapterSessionClaims.add(adapterSessionId);
    return true;
  }

  /**
   * Release a previously granted adapter session claim without registering
   * an entry. Used when `startOrInitializeAgent` fails after a successful
   * claim.
   * @param adapterSessionId - Provider-native session ID to release
   */
  public releaseAdapterSessionClaim(adapterSessionId: string): void {
    this.pendingAdapterSessionClaims.delete(adapterSessionId);
  }

  /**
   * Check whether a provider-native session ID is held by a registered
   * entry or a pending claim.
   *
   * Used by the `listAgents` response consumer (`adapterSessionHasLiveWriter`)
   * to see in-flight starts as occupied sessions.
   * @param adapterSessionId - Provider-native session ID to probe
   * @returns `true` when the session is occupied or claimed
   */
  public hasAdapterSession(adapterSessionId: string): boolean {
    if (this.pendingAdapterSessionClaims.has(adapterSessionId)) {
      return true;
    }
    for (const entry of this.entries.values()) {
      if (occupiedAdapterSessionId(entry) === adapterSessionId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Register a new agent entry and settle the start's adapter-session claim.
   *
   * Sole settlement point on the success path, so a granted claim is released
   * exactly once the entry that supersedes it exists. Only the identity this
   * start claimed up front is released — never the identity the entry happens
   * to register: after a rotation those differ (a suppressed native resume
   * abandons the armed target and the connector mints a fresh provider
   * session), and the registered identity may coincide with a claim a
   * *concurrent* start owns. Releasing by registered identity would silently
   * destroy that foreign claim and let its start register a second writer for
   * the same provider session; the claimed identity is the only one this
   * start owns. Releasing only the registered identity would conversely
   * strand a rotated-away target in {@link pendingAdapterSessionClaims} for
   * the adapter's lifetime, rejecting every later resume of that provider
   * session — so every start path that claims must pass its exact claim here.
   *
   * Settling here rather than at the call sites is what keeps the claim held for
   * the whole start: registration establishes the new entry's occupancy in the
   * same synchronous step that drops the claim, so no window opens in which
   * neither a claim nor an entry covers the agent's provider session.
   * @param agentId - Agent identifier
   * @param entry - Registry entry to store
   * @param claimedAdapterSessionId - Provider session this start claimed up
   *   front, or `undefined` when it claimed none
   */
  public set(
    agentId: string,
    entry: ActiveAgentEntry<TBus, TConnector, TAgent>,
    claimedAdapterSessionId?: string,
  ): void {
    this.entries.set(agentId, entry);
    if (claimedAdapterSessionId !== undefined) {
      this.pendingAdapterSessionClaims.delete(claimedAdapterSessionId);
    }
  }

  /**
   * Get a registry entry by agent ID.
   * @param agentId - Agent identifier
   * @returns Registry entry or undefined
   */
  public get(agentId: string): ActiveAgentEntry<TBus, TConnector, TAgent> | undefined {
    return this.entries.get(agentId);
  }

  /**
   * Return all entries as an iterable (for closeAsync iteration).
   * @returns Iterable of registry entries
   */
  public values(): IterableIterator<ActiveAgentEntry<TBus, TConnector, TAgent>> {
    return this.entries.values();
  }

  /**
   * Clear all entries and pending claims (used after closeAsync has already
   * closed all agents).
   */
  public clear(): void {
    this.entries.clear();
    this.pendingAdapterSessionClaims.clear();
  }

  /**
   * Evict an agent from memory and mark as dead in storage.
   * @param agentId - Agent identifier
   * @param options - Optional lifecycle emission controls for session-driven eviction
   */
  public async evict(agentId: string, options: { emitSessionClosed?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(agentId);
    this.entries.delete(agentId);
    let closeError: unknown;
    if (entry) {
      try {
        await entry.agent.close({ emitSessionClosed: options.emitSessionClosed });
      } catch (error) {
        closeError = error;
      }
    }
    try {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'dead' });
    } catch (error) {
      if (closeError === undefined) {
        throw error;
      }
      console.warn(`[ActiveAgentRegistry:${this.adapterName}] Failed to mark agent ${agentId} as dead:`, error);
    }
    if (closeError !== undefined) {
      throw closeError;
    }
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
      console.warn(
        `[ActiveAgentRegistry:${this.adapterName}] Agent ${agentId} close error during silent eviction:`,
        error,
      );
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
      console.warn(`[ActiveAgentRegistry:${this.adapterName}] Agent ${agentId} close error during dispose:`, error);
    });
    this.entries.delete(agentId);
    void this.globalBus
      .requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' })
      .catch((error) => {
        console.warn(`[ActiveAgentRegistry:${this.adapterName}] Failed to mark agent ${agentId} as disposed:`, error);
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
  ): ActiveAgentEntry<TBus, TConnector, TAgent> | undefined {
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
