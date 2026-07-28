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
import type { AgentCreationOptions } from './types.js';
import type { McpSessionContext, MakaioSessionAgent, NativeLocalityVerdict } from '@makaio/contracts';
import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import { AdapterSubjects, McpSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { resolveRuntimeProviderContext } from '@makaio/services-core/provider-context';
import { restoreAgentUsageFromTurns } from './restore-agent-usage.js';
import {
  commitAdapterProviderContextActivation,
  prepareAdapterProviderContextActivation,
  rollbackAdapterProviderContextActivationAfterFailure,
  type ProviderContextActivationLifecycle,
} from './provider-context-activation-lifecycle.js';

type RehydrateAgentRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.rehydrateAgent>;
type RehydrateAgentResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>;
type NativeLocalityKind = NativeLocalityVerdict['kind'];

/**
 * Extract a pre-evaluated native locality kind from an agent record.
 *
 * `MakaioSessionAgent` does not own machine-locality fields. The rehydrate
 * paths cannot re-evaluate machine identity from storage, so this helper
 * only reads an already-computed verdict if a host-tier caller has
 * attached one to the POJO before it reaches the adapter.
 *
 * Absence is not proof of locality. Callers must treat `undefined` the same
 * as a non-native verdict and fall back to fresh-with-history rehydration.
 * @param persisted - Persisted agent record (may predate locality stamping)
 * @returns The locality verdict kind, or undefined when locality is not confirmed
 */
function resolveNativeLocalityKind(persisted: MakaioSessionAgent): NativeLocalityKind | undefined {
  const raw = persisted as Record<string, unknown>;
  const locality = raw['nativeLocality'];
  if (typeof locality === 'object' && locality !== null && 'kind' in locality) {
    const kind = (locality as { kind: unknown })['kind'];
    if (kind === 'native' || kind === 'degrade' || kind === 'foreign') {
      return kind;
    }
  }
  return undefined;
}

/**
 * Resolve the provider session to native-resume, honoring the rehydrate RPC
 * contract shared by the warm and cold paths.
 *
 * Priority:
 * 1. Explicit `resumeAdapterSessionId` from the RPC caller (service layer
 *    evaluated locality and decided native resume is safe).
 * 2. A pre-evaluated locality verdict stamped onto the persisted agent
 *    record by a host-tier caller (fallback for callers that cannot pass
 *    the field via the RPC payload).
 *
 * `adapterSessionId` alone is an identity marker and never implies resume:
 * promoting it to a resume target unconditionally would native-resume
 * foreign or degraded provider sessions. When neither source confirms
 * native locality the caller is responsible for injecting history on the
 * first send (typically via the orchestrator's dead-agent recovery path).
 * @param rpcResumeId - Explicit resume target from the RPC payload, if any
 * @param persistedLocalityKind - Locality verdict from the persisted record, if any
 * @param identitySessionId - Identity-marker session ID used as the resume target when the verdict confirms native locality
 * @returns Resume target, or `undefined` when native resume is not confirmed
 */
function resolveEffectiveResumeId(
  rpcResumeId: string | undefined,
  persistedLocalityKind: NativeLocalityKind | undefined,
  identitySessionId: string | undefined,
): string | undefined {
  if (rpcResumeId !== undefined) return rpcResumeId;
  return persistedLocalityKind === 'native' ? identitySessionId : undefined;
}

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
  /** In-flight rehydrate operations keyed by agentId (single-flight dedupe). */
  private readonly inFlight = new Map<string, Promise<void>>();
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
   * @param ctx - Request context containing target agentId and optional runtime overrides
   */
  public handleRehydrateAgent = async (
    ctx: RequestContext<RehydrateAgentRequestPayload, RehydrateAgentResponsePayload>,
  ): Promise<void> => {
    const { agentId, cwd, model, adapterSessionId, resumeAdapterSessionId: rpcResumeId } = ctx.payload;
    const existing = this.inFlight.get(agentId);
    if (existing) {
      await existing;
      ctx.setResult({});
      return;
    }

    const rehydratePromise = (async (): Promise<void> => {
      const entry = this.registry.get(agentId);
      if (entry) {
        await this.rehydrateRegisteredAgent(agentId, entry, { adapterSessionId, rpcResumeId, cwd, model });
        return;
      }
      await this.rehydrateFromStorage(agentId, { adapterSessionId, rpcResumeId, cwd, model });
    })().catch((error) => {
      if (error instanceof AggregateError) {
        throw new AggregateError(error.errors, `Failed to recover agent ${agentId}: ${error.message}`);
      }
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
   * Cold-path rehydration: resurrect an agent from storage.
   *
   * Resolves MCP context, provider credentials, system prompt, and usage
   * baseline before creating a new agent instance and registering it.
   * @param agentId - Agent identifier to rehydrate
   * @param runtime - Runtime overrides from the rehydrate RPC payload
   */
  private async rehydrateFromStorage(
    agentId: string,
    runtime: {
      adapterSessionId?: string;
      rpcResumeId?: string;
      cwd?: string;
      model?: string;
    },
  ): Promise<void> {
    const { adapterSessionId, rpcResumeId, cwd, model } = runtime;
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
    const providerContext =
      persisted.providerConfigId !== undefined
        ? await resolveRuntimeProviderContext(this.globalBus, {
            adapterName: persisted.adapterName,
            providerConfigId: persisted.providerConfigId,
          })
        : undefined;
    const resolvedAdapterSessionId = adapterSessionId ?? persisted.adapterSessionId;
    const effectiveResumeId = resolveEffectiveResumeId(
      rpcResumeId,
      resolveNativeLocalityKind(persisted),
      resolvedAdapterSessionId,
    );

    // A resumed generation's identity is the session it resumes — a divergent
    // identity marker would seed the connector with the old ID and leave the
    // claimed resume ID dangling after registry.set() clears only the
    // confirmed identity. A fresh generation mints its own provider identity
    // instead: pinning a used session ID on a fresh start collides with the
    // provider's durable session store (claude CLI: "Session ID already in
    // use").
    const agentCreationRequest: AgentCreationOptions = {
      model: model ?? persisted.model,
      cwd: cwd ?? persisted.cwd,
      allowedDirectories: persisted.allowedDirectories,
      ...(effectiveResumeId !== undefined && {
        adapterSessionId: effectiveResumeId,
        resumeAdapterSessionId: effectiveResumeId,
      }),
      ...(providerContext !== undefined && { providerContext }),
      ...(mcpSessionContext !== undefined && { mcpSessionContext }),
    };

    // Restore cumulative usage baseline from persisted turn history.
    // Without this, the adapter's in-memory totals would restart from zero
    // after every process restart, making session-level usage unreliable.
    const restoredUsage = await restoreAgentUsageFromTurns(this.globalBus, persisted.sessionId, agentId);
    const { agent: newAgent, adapterSessionId: recoveredAdapterSessionId } = await this.claimAndCreateAgent(
      agentId,
      persisted,
      agentCreationRequest,
      effectiveResumeId,
    );

    // registry.set() auto-clears the pending claim for effectiveResumeId.
    this.registry.set(agentId, {
      agent: newAgent,
      sessionId: persisted.sessionId,
      adapterSessionId: recoveredAdapterSessionId,
      usage: restoredUsage,
    });
    if (effectiveResumeId !== undefined && effectiveResumeId !== recoveredAdapterSessionId) {
      // The provider confirmed a different session than the claimed resume
      // target (lazy-confirming connectors fall back to the persisted ID) —
      // release the claim explicitly so the session does not stay locked.
      this.registry.releaseAdapterSessionClaim(effectiveResumeId);
    }
    // Persist the confirmed identity when it moved (fresh rehydrates mint a
    // new provider session): the agent.started reconciliation is write-once
    // and never replaces a stale stored ID, and a later restartAgents native
    // verdict would resume the abandoned provider thread from storage.
    //
    // Deliberately agent-row only: the session-row identity is host-tier
    // state the adapter does not own, and its currency is a service-tier
    // seam shared with every other provider-session movement (rotation-mode
    // turns move the provider session on every send). Updating it from one
    // producer here would leave the general staleness class in place.
    const adapterSessionIdMoved = recoveredAdapterSessionId !== persisted.adapterSessionId;
    if (cwd !== undefined || model !== undefined || adapterSessionIdMoved) {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, {
        agentId,
        cwd,
        model,
        ...(adapterSessionIdMoved && { adapterSessionId: recoveredAdapterSessionId }),
      });
    }
    await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
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
   * Hard failure on a denied claim is intentional: the session is already
   * owned by another in-flight operation. Degrading silently to fresh-without-
   * resume would produce two agents writing to different provider conversations
   * under the same logical agent ID, which is a harder-to-diagnose corruption.
   * @param agentId - Agent identifier being rehydrated
   * @param persisted - Persisted agent record
   * @param creationRequest - Agent creation options (includes resumeAdapterSessionId when resuming)
   * @param effectiveResumeId - Provider session being claimed, or `undefined` for fresh-start
   * @returns Newly created ready agent and its provider-confirmed session ID
   */
  private async claimAndCreateAgent(
    agentId: string,
    persisted: MakaioSessionAgent,
    creationRequest: AgentCreationOptions,
    effectiveResumeId: string | undefined,
  ): Promise<{ agent: TAgent; adapterSessionId: string }> {
    if (effectiveResumeId !== undefined) {
      const claimed = this.registry.claimAdapterSession(effectiveResumeId);
      if (!claimed) {
        throw new Error(
          `Provider session ${effectiveResumeId} is already claimed by another in-flight rehydrate or start`,
        );
      }
    }

    let activation: ProviderContextActivationLifecycle | undefined;
    let newAgent: TAgent | undefined;
    try {
      activation = await prepareAdapterProviderContextActivation(
        this.globalBus,
        creationRequest.providerContext ?? { state: 'unresolved' },
      );
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
        if (activation === undefined) throw error;
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
   * Applies the same native-resume gate as the cold path: the caller's
   * explicit `resumeAdapterSessionId` wins, a host-tier locality verdict on
   * the stored record is the fallback, and without either the replacement
   * connector starts fresh (identity marker forwarded, no provider resume).
   * @param agentId - Agent identifier being rehydrated
   * @param entry - Active registry entry for the agent
   * @param runtime - Runtime overrides from the rehydrate request
   */
  private async rehydrateRegisteredAgent(
    agentId: string,
    entry: ActiveAgentEntry<TBus, TConnector, TAgent>,
    runtime: { adapterSessionId?: string; rpcResumeId?: string; cwd?: string; model?: string },
  ): Promise<void> {
    const nativeSessionId = runtime.adapterSessionId ?? entry.adapterSessionId;
    const effectiveResumeId = resolveEffectiveResumeId(
      runtime.rpcResumeId,
      await this.resolvePersistedLocalityKind(agentId),
      nativeSessionId,
    );
    // Same claim discipline as the cold path when the resume target is not
    // the session this entry already owns: without the claim, a stale RPC
    // payload could attach this live agent to another live agent's provider
    // conversation. The entry's own session needs no claim — the registry
    // already advertises this agent as its occupant.
    const foreignResumeId = effectiveResumeId !== entry.adapterSessionId ? effectiveResumeId : undefined;
    if (foreignResumeId !== undefined && !this.registry.claimAdapterSession(foreignResumeId)) {
      throw new Error(`Provider session ${foreignResumeId} is already claimed by another in-flight rehydrate or start`);
    }
    const previousAdapterSessionId = entry.adapterSessionId;
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
      await entry.agent.swapConnector({
        cwd: runtime.cwd,
        model: runtime.model,
        ...(effectiveResumeId !== undefined && { adapterSessionId: effectiveResumeId }),
        resumeAdapterSessionId: effectiveResumeId,
      });
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
    if (runtime.cwd !== undefined || runtime.model !== undefined || movedAdapterSessionId !== undefined) {
      await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, {
        agentId,
        cwd: runtime.cwd,
        model: runtime.model,
        ...(movedAdapterSessionId !== undefined && { adapterSessionId: movedAdapterSessionId }),
      });
    }
    await this.globalBus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
  }

  /**
   * Read the host-tier locality verdict for a registered agent from storage.
   *
   * The warm path holds no persisted record, so the verdict fallback of the
   * shared native-resume gate needs its own lookup. Resolution is
   * best-effort: a missing storage handler or record simply yields no
   * verdict, which the gate treats as non-native.
   * @param agentId - Agent identifier being rehydrated
   * @returns The locality verdict kind, or `undefined` when locality is not confirmed
   */
  private async resolvePersistedLocalityKind(agentId: string): Promise<NativeLocalityKind | undefined> {
    const result = await this.globalBus.requestOptional(AgentStorageSubjects.get, { agentId });
    if (!result.handled || !result.data.agent) return undefined;
    return resolveNativeLocalityKind(result.data.agent);
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
