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
import type { ActiveAgentEntry, ActiveAgentRegistry } from './agent-registry.js';
import { occupiedAdapterSessionId } from './agent-registry.js';
import type { AgentCreationOptions } from './types.js';
import type { McpSessionContext, MakaioSessionAgent } from '@makaio/contracts';
import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import { AdapterSubjects, McpSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  notDispatched,
  prepareColdRehydrate,
  type ColdRehydratePreflightDeps,
  type RehydrateAgentRefusal,
  type RehydrateRuntime,
} from './ai-adapter-rehydrate-preflight.js';
import {
  providerKeyIsPublishable,
  providerKeyPublicationFor,
  publishedProviderKey,
  type ProviderKeyPublication,
} from './adapter-provider-key-publication.js';
import {
  commitAdapterProviderContextActivation,
  prepareAdapterProviderContextActivation,
  rollbackAdapterProviderContextActivationAfterFailure,
  type ProviderContextActivationLifecycle,
} from './provider-context-activation-lifecycle.js';

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
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>;
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
  /**
   * In-flight rehydrate operations keyed by agentId (single-flight dedupe).
   *
   * The key is the agent alone, deliberately: adding the ownership mode would
   * permit two concurrent rehydrates of one agent, which is exactly what this
   * map exists to prevent. The promise carries the owning attempt's own
   * response so a joiner is answered with what actually happened.
   */
  private readonly inFlight = new Map<string, Promise<RehydrateAgentResponsePayload>>();
  private readonly globalBus: IMakaioBus;
  private readonly registry: ActiveAgentRegistry<TBus, TConnector, TAgent>;
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
   *
   * Native resume is gated solely by the caller's explicit
   * `resumeAdapterSessionId`: the service layer owns locality evaluation, and
   * the adapter can neither re-evaluate machine identity from storage nor
   * infer it from an identity marker. A known `adapterSessionId` never implies
   * resume — promoting it to a resume target would native-resume foreign or
   * degraded provider sessions. Without an explicit target the caller owns
   * history injection on the first send (typically via the orchestrator's
   * dead-agent recovery path).
   * @param ctx - Request context containing target agentId and optional runtime overrides
   */
  public handleRehydrateAgent = async (
    ctx: RequestContext<RehydrateAgentRequestPayload, RehydrateAgentResponsePayload>,
  ): Promise<void> => {
    const { agentId, cwd, model, resumeAdapterSessionId: rpcResumeId, callerOwnsAgentRow } = ctx.payload;
    const runtime: RehydrateRuntime = {
      rpcResumeId,
      cwd,
      model,
      callerOwnsAgentRow,
      publication: providerKeyPublicationFor({ callerOwnsAgentRow: callerOwnsAgentRow === true }),
    };
    const existing = this.inFlight.get(agentId);
    if (existing) {
      // A joiner is answered with the owning attempt's own result. Synthesising
      // a success here would report that attempt's refusal as a rehydrate that
      // happened.
      ctx.setResult(await existing);
      return;
    }

    const rehydratePromise = (async (): Promise<RehydrateAgentResponsePayload> => {
      const entry = this.registry.get(agentId);
      if (entry) {
        return await this.rehydrateRegisteredAgent(agentId, entry, runtime);
      }
      return await this.rehydrateFromStorage(agentId, runtime);
    })().catch((error): never => {
      if (error instanceof AggregateError) {
        throw new AggregateError(error.errors, `Failed to recover agent ${agentId}: ${error.message}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to recover agent ${agentId}: ${message}`);
    });

    this.inFlight.set(agentId, rehydratePromise);

    let result: RehydrateAgentResponsePayload;
    try {
      result = await rehydratePromise;
    } finally {
      this.inFlight.delete(agentId);
    }

    ctx.setResult(result);
  };

  /**
   * The reads the cold preflight performs on this adapter's behalf.
   * @returns Bus and MCP resolver bound to this manager.
   */
  private preflightDeps(): ColdRehydratePreflightDeps {
    return {
      globalBus: this.globalBus,
      resolveMcpSessionContext: (sessionId, profileId) => this.resolveMcpSessionContext(sessionId, profileId),
    };
  }

  /**
   * Cold-path rehydration: resurrect an agent from storage.
   *
   * Resolves MCP context, provider credentials, system prompt, and usage
   * baseline before creating a new agent instance and registering it.
   * @param agentId - Agent identifier to rehydrate
   * @param runtime - Runtime overrides and ownership mode from the rehydrate RPC payload
   * @returns The rehydrate response — a success carrying the confirmed provider session, or a modeled refusal
   */
  private async rehydrateFromStorage(
    agentId: string,
    runtime: RehydrateRuntime,
  ): Promise<RehydrateAgentResponsePayload> {
    const { rpcResumeId, cwd, model, callerOwnsAgentRow } = runtime;
    const preflight = await prepareColdRehydrate(this.preflightDeps(), agentId, runtime);
    if ('success' in preflight) return preflight;
    const { persisted, agentCreationRequest, restoredUsage } = preflight;
    const created = await this.claimAndCreateAgent(agentId, persisted, agentCreationRequest, rpcResumeId);
    // A refusal is returned verbatim: only the response arm carries `success`.
    if ('success' in created) return created;
    const { agent: newAgent, adapterSessionId: recoveredAdapterSessionId } = created;

    // registry.set() settles the pending claim for the resume target, including
    // when the provider confirmed a different session than the claimed target
    // (lazy-confirming connectors fall back to the persisted ID).
    this.registry.set(
      agentId,
      {
        agent: newAgent,
        sessionId: persisted.sessionId,
        adapterSessionId: recoveredAdapterSessionId,
        usage: restoredUsage,
      },
      rpcResumeId,
    );
    await this.publishRehydratedRuntime(agentId, persisted, newAgent, {
      cwd,
      model,
      recoveredAdapterSessionId,
      publication: runtime.publication,
    });
    if (!callerOwnsAgentRow) {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
    }
    return { success: true, adapterSessionId: recoveredAdapterSessionId };
  }

  /**
   * Persist the rehydrated generation's runtime values and announce a moved
   * provider identity.
   *
   * The identity must be persisted when it moved (fresh rehydrates mint a new
   * provider session): the `agent.started` reconciliation is write-once and
   * never replaces a stale stored ID, so a later `restartAgents` native verdict
   * would otherwise resume the abandoned provider thread from storage.
   *
   * The session row is deliberately not written from here — its origin
   * `adapterSessionId` is immutable import provenance, and its resume currency
   * is owned by the service-tier currency handler. A cold rehydrate produces no
   * turn start, so `agent.started` cannot carry this movement: it is announced
   * on the dedicated movement seam instead, which every other producer
   * (provider confirmation, connector swap, pre-confirmation rotation) feeds.
   *
   * Ordering and retryability follow the seam's producer contract (see
   * `agent-adapter-session-movement.ts`). The announcement runs first, so the
   * session row carries the new currency before the agent row advertises it;
   * and it is routed through the rehydrated agent's own movement tracker rather
   * than emitted here, because the agent row is what a later rehydrate compares
   * against. Emitting directly and then advancing that row would erase the only
   * evidence a rejected movement still needs delivering — with the tracker, the
   * unacknowledged announcement stays armed and the agent's next emitted event
   * re-drives it, so persisting the recovered ID stays safe.
   *
   * **A rehydrate whose key is deferred announces nothing, because it is not
   * this generation's currency writer.** A deferred key belongs to a caller that
   * reserved the provider session and settles the confirmed key itself, under a
   * token it minted before dispatching. The observer would settle the same
   * movement under a token of its own, which no failure path of that caller can
   * name — so a settlement that then fails gives back the reservation and its
   * own candidate and leaves the observer's generation held on a row it has just
   * marked dead. One movement, one settle producer: the same gate that decides
   * whether the start handler announces, applied at the seam where the caller
   * settles instead. What is given up is a window — between the
   * connector confirming the key and the caller's settlement claiming it, nobody
   * holds it — which is the residual this aggregate already documents and which
   * the next attempt heals; a leaked generation heals for nobody.
   * @param agentId - Agent identifier being rehydrated
   * @param persisted - Persisted agent record supplying stable identity fields
   * @param agent - Rehydrated agent instance owning the movement tracker
   * @param runtime - Requested cwd/model overrides, the confirmed session ID, and who settles it
   */
  private async publishRehydratedRuntime(
    agentId: string,
    persisted: MakaioSessionAgent,
    agent: TAgent,
    runtime: {
      cwd: string | undefined;
      model: string | undefined;
      recoveredAdapterSessionId: string;
      publication: ProviderKeyPublication;
    },
  ): Promise<void> {
    const { cwd, model, recoveredAdapterSessionId } = runtime;
    const adapterSessionIdMoved = recoveredAdapterSessionId !== persisted.adapterSessionId;
    // Same gate, in its "who settles this" form: a deferred key is the caller's,
    // so the movement is recorded as settled by it rather than announced.
    const callerSettlesCurrency = !providerKeyIsPublishable(runtime.publication);
    if (adapterSessionIdMoved) {
      await agent.recordConfirmedAdapterSession(recoveredAdapterSessionId, callerSettlesCurrency);
    }
    // The row write is a publication route like any other, so it takes its key
    // from the gate: a caller-owned rehydrate's answer *is* the hand-over, and
    // until the caller settles, this row would advertise a provider session no
    // generation holds — while a caller whose settlement then fails could give
    // back the generations it took but never the advertisement.
    const publishedAdapterSessionId = adapterSessionIdMoved
      ? publishedProviderKey(runtime.publication, recoveredAdapterSessionId)
      : undefined;
    if (cwd === undefined && model === undefined && publishedAdapterSessionId === undefined) return;
    await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, {
      agentId,
      cwd,
      model,
      ...(publishedAdapterSessionId !== undefined && { adapterSessionId: publishedAdapterSessionId }),
    });
  }

  /**
   * Claim the provider session (if resuming), create a new agent, and
   * initialize its connector.
   *
   * Mirrors the start-handler discipline (R10):
   * - Claim before connector creation to close the TOCTOU window where the
   *   registry has no entry and no pending claim for the provider session.
   * - Release the claim on any failure so a subsequent retry can re-enter.
   * - `registry.set()` (called by the caller) auto-clears the claim on
   *   success.
   *
   * Refusal on a denied claim is intentional: the session is already owned by
   * another in-flight operation. Degrading silently to fresh-without-resume
   * would produce two agents writing to different provider conversations under
   * the same logical agent ID, which is a harder-to-diagnose corruption. The
   * refusal is *modeled* rather than thrown — nothing reached the provider, so
   * a reserving caller may release its reservation instead of retiring the key.
   * @param agentId - Agent identifier being rehydrated
   * @param persisted - Persisted agent record
   * @param creationRequest - Agent creation options (includes resumeAdapterSessionId when resuming)
   * @param effectiveResumeId - Provider session being claimed, or `undefined` for fresh-start
   * @returns Newly created ready agent with its provider-confirmed session ID, or the modeled refusal to return verbatim
   */
  private async claimAndCreateAgent(
    agentId: string,
    persisted: MakaioSessionAgent,
    creationRequest: AgentCreationOptions,
    effectiveResumeId: string | undefined,
  ): Promise<{ agent: TAgent; adapterSessionId: string } | RehydrateAgentRefusal> {
    if (effectiveResumeId !== undefined) {
      const claimed = this.registry.claimAdapterSession(effectiveResumeId);
      if (!claimed) {
        return notDispatched(
          `Provider session ${effectiveResumeId} is already claimed by another in-flight rehydrate or start`,
        );
      }
    }

    // Its own step and its own answer: preparing the account is a local
    // account-manager transaction and no connector exists yet, so a failure
    // provably reached no provider. Modeled, the caller hands the key straight
    // back — the answer this path already gives a disposed agent.
    let activation: ProviderContextActivationLifecycle;
    try {
      activation = await prepareAdapterProviderContextActivation(
        this.globalBus,
        creationRequest.providerContext ?? { state: 'unresolved' },
      );
    } catch (error) {
      if (effectiveResumeId !== undefined) this.registry.releaseAdapterSessionClaim(effectiveResumeId);
      return notDispatched(
        `Agent ${agentId} could not activate its provider account: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let newAgent: TAgent | undefined;
    try {
      newAgent = await this.createAgentFn(agentId, persisted.sessionId, creationRequest);
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
      // Prefer the live connector session ID. Persisted values can be stale
      // after restart or connector replacement.
      const recoveredAdapterSessionId = (await newAgent.getAdapterSessionId()) || persisted.adapterSessionId;
      if (!recoveredAdapterSessionId) {
        throw new Error(`Recovered agent ${agentId} has no adapterSessionId`);
      }
      await commitAdapterProviderContextActivation(activation);
      return { agent: newAgent, adapterSessionId: recoveredAdapterSessionId };
    } catch (error) {
      try {
        const failedAgent = newAgent;
        return await rollbackAdapterProviderContextActivationAfterFailure({
          activation,
          primaryError: error,
          ...(failedAgent !== undefined && {
            cleanup: () => failedAgent.close({ emitSessionClosed: false }),
          }),
          operation: `Cold rehydrate for agent ${agentId}`,
          cleanupFailureMessage: `Cold rehydrate and connector cleanup both failed for agent ${agentId}.`,
        });
      } finally {
        if (effectiveResumeId !== undefined) {
          this.registry.releaseAdapterSessionClaim(effectiveResumeId);
        }
      }
    }
  }

  /**
   * Rehydrate an agent that is still present in the in-memory registry.
   *
   * Applies the same native-resume gate as the cold path: only the caller's
   * explicit `resumeAdapterSessionId` resumes the provider session, and
   * without it the replacement connector starts fresh (no provider resume).
   * @param agentId - Agent identifier being rehydrated
   * @param entry - Active registry entry for the agent
   * @param runtime - Runtime overrides and ownership mode from the rehydrate request
   * @returns The rehydrate response — a success carrying the confirmed provider session, or a modeled refusal
   */
  private async rehydrateRegisteredAgent(
    agentId: string,
    entry: ActiveAgentEntry<TBus, TConnector, TAgent>,
    runtime: RehydrateRuntime,
  ): Promise<RehydrateAgentResponsePayload> {
    // Resolve the "own session" test through the occupancy helper, which is
    // what `claimAdapterSession` consults. Comparing against the entry's
    // reconciled field instead would disagree with the claim during the
    // post-swap window: a caller passing the freshly published currency as the
    // resume target would look "foreign", and the claim would then reject this
    // agent for occupying its own provider session.
    const ownAdapterSessionId = occupiedAdapterSessionId(entry);
    const effectiveResumeId = runtime.rpcResumeId;
    // Same claim discipline as the cold path when the resume target is not
    // the session this entry already owns: without the claim, a stale RPC
    // payload could attach this live agent to another live agent's provider
    // conversation. The entry's own session needs no claim — the registry
    // already advertises this agent as its occupant.
    const foreignResumeId = effectiveResumeId !== ownAdapterSessionId ? effectiveResumeId : undefined;
    if (foreignResumeId !== undefined && !this.registry.claimAdapterSession(foreignResumeId)) {
      // Modeled like the cold path's denial: the connector has not been swapped,
      // so a reserving caller's key is still exactly as it was.
      return notDispatched(
        `Provider session ${foreignResumeId} is already claimed by another in-flight rehydrate or start`,
      );
    }
    const previousAdapterSessionId = entry.adapterSessionId;
    // Read from the gate, exactly as the cold path reads it: the question "may
    // this attempt publish the key" and the question "who settles it" are the
    // same question, and asking the payload again here is what let the two paths
    // answer it from two different facts.
    const callerSettlesCurrency = !providerKeyIsPublishable(runtime.publication);
    try {
      // The resume key is always present: an explicit `undefined` overrides
      // the agent config's start-time resume target, so a non-native
      // rehydrate really produces a fresh connector instead of inheriting a
      // stale resume. A resumed generation carries the resume target as its
      // identity; a fresh replacement mints a new provider session ID
      // (lifecycle-manager default) because pinning a used ID collides with
      // the provider's durable session store (claude CLI: "Session ID
      // already in use").
      //
      // After a fresh swap the caller owns history injection on the next
      // send — the same contract the RPC schema documents for cold
      // rehydration. The adapter cannot decide what history the service
      // wants injected, and no production caller warm-rehydrates without a
      // resume decision today (restartAgents defers non-native agents to
      // dead-agent recovery, which builds the recovery context itself).
      await entry.agent.swapConnector(
        {
          cwd: runtime.cwd,
          model: runtime.model,
          ...(effectiveResumeId !== undefined && { adapterSessionId: effectiveResumeId }),
          resumeAdapterSessionId: effectiveResumeId,
        },
        undefined,
        // The swap publishes the replacement's confirmed session, and a deferred
        // key must not be published as an announcement: the caller settles that
        // key itself, under a token it minted before dispatching, and the
        // observer settling it first would hold a generation no failure path of
        // that caller can name. The same gate the cold path reads, in its "who
        // settles this" form.
        callerSettlesCurrency,
      );
      const refreshedAdapterSessionId = await entry.agent.getAdapterSessionId();
      if (refreshedAdapterSessionId) {
        entry.adapterSessionId = refreshedAdapterSessionId;
      }
    } finally {
      // Released after the entry update so occupancy of the resumed session
      // stays continuous on success; on failure the claim simply frees up.
      if (foreignResumeId !== undefined) {
        this.registry.releaseAdapterSessionClaim(foreignResumeId);
      }
    }
    // Persist the confirmed identity when it moved (fresh replacements mint
    // a new provider session): the agent.started reconciliation is
    // write-once and never replaces a stale stored ID, and a later
    // restartAgents native verdict would resume the abandoned provider
    // thread from storage.
    const movedAdapterSessionId =
      entry.adapterSessionId !== previousAdapterSessionId ? entry.adapterSessionId : undefined;
    // Through the same gate as the cold path's row write, and for the same
    // reason: the response carries the key to the caller, whose settlement
    // claims it first.
    const publishedAdapterSessionId = publishedProviderKey(runtime.publication, movedAdapterSessionId);
    if (runtime.cwd !== undefined || runtime.model !== undefined || publishedAdapterSessionId !== undefined) {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, {
        agentId,
        cwd: runtime.cwd,
        model: runtime.model,
        ...(publishedAdapterSessionId !== undefined && { adapterSessionId: publishedAdapterSessionId }),
      });
    }
    if (!runtime.callerOwnsAgentRow) {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
    }
    // The entry's field is the post-swap identity: it was just refreshed from
    // the live connector, so it is what the registry advertises as this agent's
    // occupancy and what a settling caller must settle on. It stays absent only
    // when the connector confirmed nothing.
    return {
      success: true,
      ...(entry.adapterSessionId !== undefined && { adapterSessionId: entry.adapterSessionId }),
    };
  }

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
