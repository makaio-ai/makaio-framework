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
import type { AgentTeardownArbiter } from '../agent/agent-teardown-arbiter.js';
import { closeConnectorRuntime } from '../agent/connector-runtime.js';
import type { TeardownReport } from '../connector/teardown-report.js';
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
  /**
   * Adapter-instance arbiter between teardowns and connector replacements.
   *
   * **Required**: this registry owns all four agent-teardown entry points, and
   * every one of them runs through the arbiter's single flight. A registry
   * constructed without one would let two of them close one connector twice.
   */
  arbiter: AgentTeardownArbiter;
}

/** What one agent teardown observed, plus whether there was an agent at all. */
export interface AgentDisposalReport extends TeardownReport {
  /**
   * Whether a live agent was found and its teardown attempted.
   *
   * True for a teardown this call joined as well as one it started: an agent *was*
   * found, by whichever caller got there first, and both callers are answered with
   * the same evidence.
   */
  readonly found: boolean;
}

/** Options a teardown entry point accepts from the request that drove it. */
export interface AgentTeardownOptions {
  /**
   * Absolute deadline of the request driving this teardown, when it has one.
   *
   * Passed through so a teardown that must wait for a connector replacement ends
   * its wait inside the deadline of whoever is waiting on it. Absent for
   * fan-out teardowns with no request behind them, where the policy ceiling stands
   * alone.
   */
  readonly deadline?: number | undefined;
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
  /**
   * Agent identities claimed by in-flight startAgent calls.
   *
   * The twin of {@link pendingAdapterSessionClaims}, for the other identity a
   * start holds. A caller-supplied identity used to be checked against
   * {@link entries} alone, which was sound only while nothing awaited between
   * the check and the registration. A reserved start awaits a storage round
   * trip there, so two concurrent starts naming one identity would both pass
   * the check and the second would silently replace the first's connector.
   *
   * Claimed atomically in `claimAgentIdentity()`, settled by `set()` alongside
   * the adapter-session claim, and given back by `releaseAgentIdentityClaim()`
   * on every failure path.
   */
  private readonly pendingAgentIdentityClaims = new Set<string>();
  private readonly globalBus: IMakaioBus;
  private readonly adapterName: string;
  /** Arbiter owning the teardown and connector-replacement maps for this instance. */
  private readonly arbiter: AgentTeardownArbiter;

  public constructor(config: ActiveAgentRegistryConfig) {
    this.globalBus = config.globalBus;
    this.adapterName = config.adapterName;
    this.arbiter = config.arbiter;
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
   * Atomically claim an agent identity for an in-flight start.
   *
   * Synchronous, and therefore atomic within the event loop: the check and the
   * insert cannot be interleaved, which is exactly what a check against the
   * registered entries alone could not promise once a start began awaiting
   * storage between them.
   *
   * The claim is settled by `set()` when the real entry lands, or given back by
   * {@link releaseAgentIdentityClaim} when the start fails.
   * @param agentId - Identity the start intends to register
   * @returns `true` when the identity was free and is now held by this attempt
   */
  public claimAgentIdentity(agentId: string): boolean {
    if (this.pendingAgentIdentityClaims.has(agentId) || this.entries.has(agentId)) {
      return false;
    }
    this.pendingAgentIdentityClaims.add(agentId);
    return true;
  }

  /**
   * Give an unsettled identity claim back after a failed start.
   * @param agentId - Identity previously claimed
   */
  public releaseAgentIdentityClaim(agentId: string): void {
    this.pendingAgentIdentityClaims.delete(agentId);
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
    // The identity claim is settled unconditionally: the entry that now holds
    // the identity supersedes any claim on it, and a start that claimed none
    // deletes nothing.
    this.pendingAgentIdentityClaims.delete(agentId);
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
    this.pendingAgentIdentityClaims.clear();
  }

  /**
   * Whether this instance holds something a teardown could actually **close**.
   *
   * **The single place that enumerates what a teardown can act on.** A caller that
   * reads only the entries answers "provably nothing speaking" for an agent whose
   * connector is mid-teardown, so the flight counts too. Splitting this across the
   * call sites is how one of them ends up missing a case.
   *
   * A connector replacement is deliberately **not** in this disjunction, even
   * though it holds live runtimes: entering the flight for one would close the
   * runtime under a replacement that is still running — the orphan the arbitration's
   * refusal region exists to prevent — and after an expiry there is nothing of this
   * teardown's own left to close either. It belongs to
   * {@link reportWithNothingToTearDown} instead, which is the other half of the same
   * question.
   * @param agentId - Agent identity to probe
   * @returns Whether an entry or a teardown flight covers it
   */
  private hasTeardownSubject(agentId: string): boolean {
    return this.entries.has(agentId) || this.arbiter.hasTeardownInFlight(agentId);
  }

  /**
   * Answer for an identity nothing closeable was found for.
   *
   * **The single place that enumerates what can still be speaking for an identity
   * without being closeable**, and therefore the only place `released` — the answer
   * that frees an identity — may be produced. It is the twin of
   * {@link hasTeardownSubject}: "nothing here" is true only when nothing on this
   * instance can still be speaking, so a closed list of absences is exactly the
   * shape that drifts behind its own mechanism.
   *
   * Two such states exist today. An in-flight **start** holds the identity without
   * having registered it: there is nothing to close, but it is about to register a
   * connector, so closing "the entry" would be a no-op reported as success. An
   * in-flight **connector replacement** holds both runtimes after a teardown gave up
   * waiting for it: the entry and the flight are both gone by then, and the
   * replacement closes nothing until it settles.
   * @param agentId - Agent identity nothing closeable was found for
   * @returns `unknown` naming whichever act still holds the identity, else `released`
   */
  private reportWithNothingToTearDown(agentId: string): AgentDisposalReport {
    if (this.pendingAgentIdentityClaims.has(agentId)) {
      return {
        found: false,
        evidence: 'unknown',
        detail: `Agent ${agentId} is being started on this instance and has no runtime to tear down yet.`,
      };
    }
    if (this.arbiter.hasReplacementInFlight(agentId)) {
      return {
        found: false,
        evidence: 'unknown',
        detail: `Agent ${agentId} has an unsettled connector replacement in flight that owns its runtimes; nothing was closed.`,
      };
    }
    return { found: false, evidence: 'released' };
  }

  /**
   * The single teardown flight, as this registry's four entry points see it.
   *
   * **No plan parameter.** The four entry points want different terminal effects,
   * so the flight closes and classifies while each wrapper applies its own status
   * afterwards. Entry removal sits **behind** the close everywhere, which is what
   * lets a reentrant eviction — triggered by the very `session.closed` event this
   * close emits — join the flight that emitted it instead of finding a half-present
   * registry and starting a second close.
   * @param agentId - Agent being torn down
   * @param options - Lifecycle emission control and the caller's deadline
   * @returns What the teardown observed
   */
  private async teardownFlight(
    agentId: string,
    options: AgentTeardownOptions & { emitSessionClosed?: boolean | undefined },
  ): Promise<TeardownReport> {
    try {
      return await this.arbiter.runTeardown(agentId, {
        deadline: options.deadline,
        closeCurrent: async () => {
          const entry = this.entries.get(agentId);
          if (entry === undefined) {
            return { evidence: 'released' };
          }
          return entry.agent.close({ emitSessionClosed: options.emitSessionClosed });
        },
        closeUnclosed: (runtime) => closeConnectorRuntime(runtime),
        // Read at call time, like the close above: the entry is still present on
        // the expiry arm — it is this `finally` that removes it — and an identity
        // nothing is registered for has no wiring to give up.
        releaseIdentity: () => this.entries.get(agentId)?.agent.releaseIdentityWiring(),
      });
    } finally {
      // **Behind the whole flight, not behind the close alone.** Keeping the entry
      // for the duration of the close is what lets a reentrant eviction join
      // instead of finding a half-present registry; removing it on *every* exit is
      // what stops an agent this teardown gave up from staying routable — including
      // on the expiry arm, where nothing was closed but the teardown is still over.
      this.entries.delete(agentId);
    }
  }

  /**
   * Evict an agent from memory and mark as dead in storage.
   *
   * **Still throws the close failure after the `dead` write**, exactly as before:
   * the rollback consumer of a failed start awaits this and converts a close
   * rejection into an aggregate carrying both failures, and returning instead of
   * throwing would delete that signal silently. Callers that want the class read
   * the resolved value; the throw contract is unchanged.
   * @param agentId - Agent identifier
   * @param options - Lifecycle emission control and the caller's deadline
   * @returns What the teardown observed — reported even when the class is weak
   */
  public async evict(
    agentId: string,
    options: AgentTeardownOptions & { emitSessionClosed?: boolean } = {},
  ): Promise<TeardownReport> {
    const report = await this.teardownFlight(agentId, options);
    try {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'dead' });
    } catch (error) {
      if (report.closeError === undefined) {
        throw error;
      }
      console.warn(`[ActiveAgentRegistry:${this.adapterName}] Failed to mark agent ${agentId} as dead:`, error);
    }
    if (report.closeError !== undefined) {
      throw report.closeError;
    }
    return report;
  }

  /**
   * Evict an agent without updating storage status.
   *
   * For callers that own the row's terminal status themselves: an ephemeral
   * agent that was never persisted, and a failed start whose cleanup has already
   * compare-and-swapped the row to `dead` — which {@link dispose} would then
   * overwrite with the terminal `disposed`.
   *
   * It goes through the same flight as the other three; what stays untouched is
   * its *status* behaviour, which is to write none.
   * @param agentId - Agent to evict
   * @param options - The caller's deadline, when it has one
   * @returns What the teardown observed
   */
  public async evictSilently(agentId: string, options: AgentTeardownOptions = {}): Promise<TeardownReport> {
    const report = await this.teardownFlight(agentId, { ...options, emitSessionClosed: false });
    if (report.closeError !== undefined) {
      console.warn(
        `[ActiveAgentRegistry:${this.adapterName}] Agent ${agentId} close error during silent eviction:`,
        report.closeError,
      );
    }
    return report;
  }

  /**
   * Dispose an agent: close it, remove it, mark it disposed in storage.
   *
   * **Awaits the close** the eviction path always awaited, so its caller can
   * report what was observed instead of what was requested. The terminal `disposed`
   * write is unchanged and is made even when the class is weak: the status records
   * that this adapter gave the agent up, never that a provider conversation ended.
   *
   * Concurrent wrappers may both write a status, and that is safe without
   * arbitration because `disposed` is terminal in storage: the *effective* terminal
   * status is `disposed` whenever a disposal participated, in either order.
   * @param agentId - Agent identifier
   * @param options - The caller's deadline, when it has one
   * @returns Whether an agent was found, and what its teardown observed
   */
  public async dispose(agentId: string, options: AgentTeardownOptions = {}): Promise<AgentDisposalReport> {
    // Nothing registered and no flight, so the only question left is what else can
    // still be speaking for the identity. A subject always wins over the states
    // below, so a start claim or a replacement that coexists with a flight joins
    // that flight instead of being reported.
    if (!this.hasTeardownSubject(agentId)) return this.reportWithNothingToTearDown(agentId);
    const report = await this.teardownFlight(agentId, options);
    try {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
    } catch (error) {
      console.warn(`[ActiveAgentRegistry:${this.adapterName}] Failed to mark agent ${agentId} as disposed:`, error);
    }
    return { found: true, ...report };
  }

  /**
   * Tear down every agent on this instance and clear the registry.
   *
   * The adapter-instance shutdown path, and the fourth entry point into the same
   * flight: closing the agents directly is what let an instance shutdown race a
   * concurrent stop into two closes of one connector. No status is written — a
   * normal process shutdown must not mark every agent it owned terminally gone.
   * @returns One report per agent that was live, in iteration order
   */
  public async closeAll(): Promise<readonly TeardownReport[]> {
    const agentIds = [...this.entries.keys()];
    const reports = await Promise.all(agentIds.map((agentId) => this.teardownFlight(agentId, {})));
    this.clear();
    return reports;
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
