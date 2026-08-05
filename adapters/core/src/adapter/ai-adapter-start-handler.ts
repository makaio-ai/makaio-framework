/**
 * Start-agent handler factory.
 *
 * Extracted from AIAdapter to keep ai-adapter.ts below the ESLint line-count
 * ceiling. Follows the same factory pattern as ai-adapter-infer.ts.
 *
 * Encapsulates the full `adapter.startAgent` RPC lifecycle:
 * - Session resolution (use provided or create via SessionSubjects.create)
 * - Ownership acquisition for the starts the adapter owns the row for
 * - Agent creation via the adapter's createAgent delegate
 * - Agent start (with initial message) or idle initialization
 * - Registry registration
 * - Persistence and lifecycle event emission
 */
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AIAgentConnector } from '../agent/index.js';
import type { AgentCreationOptions, AgentUsageTotals, StartAgentRequestPayload } from './types.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { PlatformDefaults } from '../types/index.js';
import type { ActiveAgentRegistry } from './agent-registry.js';
import type { RequestContext } from '@makaio/core';
import {
  ProviderContextSchema,
  SessionContextSchema,
  SessionSubjects,
  type ProviderContext,
  type SessionContext,
} from '@makaio/contracts';
import { createUnresolvedProviderContext, normalizeMessageInput } from '../utils/index.js';
import {
  providerKeyIsPublishable,
  providerKeyPublicationFor,
  releaseProviderKeyPublication,
  type ProviderKeyPublication,
} from './adapter-provider-key-publication.js';
import {
  acquireStartOwnership,
  failStartAfterRegistration,
  getResumeAdapterSessionId,
  releaseStartAcquisitions,
  type StartAcquisitions,
  type StartAgentRefusal,
  type StartAgentResponsePayload,
} from './adapter-start-reservation.js';
import { callerOwnsAgentRow, persistAndEmitAgent, rollbackRegisteredAgent } from './ai-adapter-start-persistence.js';
import {
  commitAdapterProviderContextActivation,
  prepareAdapterProviderContextActivation,
  rollbackAdapterProviderContextActivationAfterFailure,
  type ProviderContextActivationLifecycle,
} from './provider-context-activation-lifecycle.js';

export const EPHEMERAL_CLEANUP_COMPLETION_TIMEOUT_MS = 5 * 60_000;

/**
 * Dependencies required by the start-agent handler factory.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export interface StartAgentHandlerDeps<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
> {
  /** Adapter instance identifier. */
  adapterId: string;
  /** Adapter type name. */
  name: string;
  /** Client identifier for the application this adapter belongs to. */
  clientId: string | undefined;
  /** Resolve current platform-provided defaults (cwd, env). */
  getPlatformDefaults: () => PlatformDefaults | undefined;
  /** Registry of active agents. */
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>;
  /** Global bus for cross-adapter communication. */
  globalBus: IMakaioBus;
  /** Factory that produces a new agent instance (delegates to adapter.createAgent). */
  createAgent: (agentId: string, sessionId: string, options: AgentCreationOptions) => Promise<TAgent>;
}

/**
 * Refuse a caller-supplied agent identity that is already live on this instance.
 *
 * Two starts for one agent identity would leave a second connector silently
 * replacing a live one, and no caller can tell afterwards which of the two its
 * agent row now describes. The refusal fires before anything reaches the
 * provider, so the caller may release whatever it reserved.
 *
 * A minted identity cannot collide, so the claim is taken only for supplied
 * ones — behaviour for a caller that supplies none is unchanged.
 *
 * The check is a *claim*, not a read, because a reserved start now awaits a
 * storage round trip between here and the settling `registry.set()`. Reading the
 * registry would leave both of two concurrent starts for one supplied identity
 * believing the identity was free, and the second would replace the first's
 * connector. `claimAgentIdentity` checks and inserts in one synchronous step,
 * mirroring the provider-session claim beside it: settled by `set()`, given back
 * on every failure path.
 * @param payload - Validated startAgent request payload
 * @param agentId - Resolved agent identity for this start
 * @param registry - Registry of agents live on this adapter instance
 * @returns The refusal to answer with, or `undefined` when the identity is free
 */
function refuseAgentIdentityCollision<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  payload: StartAgentRequestPayload,
  agentId: string,
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>,
): StartAgentRefusal | undefined {
  if (!callerOwnsAgentRow(payload) || registry.claimAgentIdentity(agentId)) {
    return undefined;
  }
  return {
    success: false,
    dispatch: 'not-dispatched',
    message: `Agent ${agentId} is already registered on this adapter instance`,
  };
}

/** Result from starting or idly initializing an agent. */
interface StartAgentExecutionResult {
  /**
   * Provider session ID. `undefined` for idle fork starts where the provider
   * has not yet confirmed the session (confirmation arrives on first dispatch).
   */
  readonly adapterSessionId: string | undefined;
  readonly messageId?: string;
  readonly messageHandle?: MessageHandle;
}

/**
 * Start an agent or initialize an idle connector.
 * @param agent - Newly created, not-yet-registered agent.
 * @param payload - Start-agent request payload.
 * @param sessionContext - Parsed session context, when provided.
 * @returns Adapter session metadata produced by the connector.
 */
async function startOrInitializeAgent<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  agent: AIAgent<TBus, TConnector>,
  payload: StartAgentRequestPayload,
  sessionContext: SessionContext | undefined,
): Promise<StartAgentExecutionResult> {
  if (payload.initialMessage !== undefined) {
    const normalizedMessage = normalizeMessageInput(payload.initialMessage);
    const startResult = await agent.start(normalizedMessage, {
      systemPrompt: payload.systemPrompt,
      sessionContext,
      responseSchema: payload.responseSchema,
    });
    return {
      adapterSessionId: startResult.adapterSessionId,
      messageId: String(startResult.messageHandle.messageId),
      messageHandle: startResult.messageHandle,
    };
  }

  const adapterSessionId = await agent.initialize({
    systemPrompt: payload.systemPrompt,
    sessionContext,
    responseSchema: payload.responseSchema,
  });
  return { adapterSessionId };
}

/**
 * Build a fresh zero-valued usage baseline for a newly registered agent entry.
 *
 * A factory rather than a shared constant: the registry accumulates each entry's
 * totals in place, so entries must not share one object.
 * @returns Usage totals starting at zero
 */
function createUsageBaseline(): AgentUsageTotals {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 };
}

/**
 * Evict an ephemeral agent after its initial turn reaches a terminal state.
 * @param registry - Agent registry that owns the temporary entry
 * @param agentId - Ephemeral agent identifier
 * @param adapterName - Adapter name for diagnostics
 * @param messageHandle - Initial turn handle, when the agent was started with a message
 */
async function cleanupEphemeralAgentAfterTurn<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>,
  agentId: string,
  adapterName: string,
  messageHandle: MessageHandle | undefined,
): Promise<void> {
  try {
    await messageHandle?.waitForCompletion(EPHEMERAL_CLEANUP_COMPLETION_TIMEOUT_MS);
  } finally {
    await registry.evictSilently(agentId);
  }
}

/**
 * Enforces ephemeral-agent request invariants before creating connector state.
 * @param payload - Incoming start-agent request
 */
function assertValidEphemeralStartPayload(payload: StartAgentRequestPayload): void {
  if (payload.ephemeral && payload.initialMessage === undefined) {
    throw new Error('ephemeral startAgent requires initialMessage');
  }
}

/**
 * Build typed agent creation options from the raw start payload.
 *
 * Replaces the wire-shape `sessionContext` with the already-parsed value so
 * the typed `AgentCreationOptions.sessionContext` field never carries an
 * unvalidated payload.
 * @param payload - Validated startAgent request payload
 * @param providerContext - Brand-restored provider context
 * @param sessionContext - Parsed session context, when supplied
 * @param publication - The attempt's provider-key publication gate
 * @returns Options for the adapter's agent factory
 */
function buildCreationOptions(
  payload: StartAgentRequestPayload,
  providerContext: ProviderContext,
  sessionContext: SessionContext | undefined,
  publication: ProviderKeyPublication,
): AgentCreationOptions {
  const { sessionContext: _rawSessionContext, ...creationPayload } = payload;
  return {
    ...creationPayload,
    providerContext,
    // The attempt's gate travels into the agent, so the routes inside it — the
    // identity enrichment stamps on every event, the movement its tracker
    // announces — ask the same question the start's own routes ask.
    providerKeyPublication: publication,
    ...(sessionContext !== undefined ? { sessionContext } : {}),
  };
}

/**
 * Resolve the Makaio session ID for a startAgent request.
 *
 * Ephemeral agents use a caller-supplied or local UUID. Create-mode agents
 * ask the session service to create/confirm. Resume and fork modes require
 * an explicit `sessionId` on the payload.
 * @param payload - Start-agent request payload
 * @param globalBus - Global bus for session-service RPC
 * @returns Resolved session ID
 */
async function resolveSessionId(payload: StartAgentRequestPayload, globalBus: IMakaioBus): Promise<string> {
  if (payload.ephemeral) {
    return payload.sessionId ?? crypto.randomUUID();
  }
  if ((payload.mode ?? 'create') === 'create') {
    const createResult = await globalBus.requestOptional(SessionSubjects.create, {
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    });
    return createResult.handled ? createResult.data.sessionId : (payload.sessionId ?? crypto.randomUUID());
  }
  if (payload.sessionId) {
    return payload.sessionId;
  }
  throw new Error(`startAgent ${payload.mode} mode requires sessionId`);
}

/**
 * Create and start an agent, releasing the adapter-session claim on failure.
 *
 * Wraps `createAgent` and `startOrInitializeAgent` with claim-aware error
 * handling so the claim is always released when the agent cannot be started.
 * @param params - Agent creation and start parameters
 * @returns Created agent and start execution result
 */
async function createAndStartAgentWithClaim<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(params: {
  agentId: string;
  sessionId: string;
  payload: StartAgentRequestPayload;
  providerContext: ProviderContext;
  sessionContext: SessionContext | undefined;
  adapterName: string;
  resumeAdapterSessionId: string | undefined;
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>;
  globalBus: IMakaioBus;
  createAgent: (agentId: string, sessionId: string, options: AgentCreationOptions) => Promise<TAgent>;
  /** Record that this attempt may have reached the provider, at the moment it may. */
  markDispatched: () => void;
  /** The attempt's publication gate, carried into the agent it creates. */
  publication: ProviderKeyPublication;
}): Promise<{ agent: TAgent; startResult: StartAgentExecutionResult }> {
  const { agentId, sessionId, payload, providerContext, sessionContext, adapterName, globalBus } = params;
  let activation: ProviderContextActivationLifecycle | undefined;
  let agent: TAgent | undefined;
  try {
    // **Before the marker, deliberately.** Preparing the account is a local
    // account-manager transaction — one bus RPC that takes a per-client mutation
    // lock and stages a native account switch — and no connector exists yet, so
    // it cannot have produced a provider session. Marking it as dispatched
    // retired a key nothing had touched: the claim went `abandoned`, the row
    // `dead`, and the next attempt found the provider session `occupied` on the
    // strength of an account manager being unavailable. I15's boundary is the
    // *entry of the provider-touching call*, and this is not it.
    activation = await prepareAdapterProviderContextActivation(globalBus, providerContext);
    // From here on the attempt may have reached the provider: the connector is
    // constructed and then initialised, and `initialize` has spoken to the
    // provider by the time it can fail. The marker goes up before the
    // construction, not between it and the initialise — over-reporting reach by
    // one local step is the safe direction, under-reporting it is not.
    params.markDispatched();
    agent = await params.createAgent(
      agentId,
      sessionId,
      buildCreationOptions(payload, providerContext, sessionContext, params.publication),
    );
    const startResult = await startOrInitializeAgent(agent, payload, sessionContext);
    await commitAdapterProviderContextActivation(activation);
    return { agent, startResult };
  } catch (error) {
    // **No claim release here.** This used to give the process-local
    // adapter-session claim back in a `finally`, and the attempt's own cleanup
    // then gave it back a second time — it still held the acquisition, having
    // never been told. A local claim is a slot, not a counter: between the two
    // releases another start in this process can claim the same provider
    // session, and the second release takes *its* guard away before it reaches
    // `registry.set`, which is exactly the collision the claim exists to refuse.
    //
    // So the acquisition has one owner: `releaseStartAcquisitions`, reached from
    // the caller's single catch. Every path out of here is a throw — the
    // rollback helper returns `never` — so there is no exit it fails to cover.
    if (activation === undefined) throw error;
    const failedAgent = agent;
    return await rollbackAdapterProviderContextActivationAfterFailure({
      activation,
      primaryError: error,
      ...(failedAgent !== undefined && {
        cleanup: () => failedAgent.close({ emitSessionClosed: !payload.ephemeral }),
      }),
      operation: `[AIAdapter:${adapterName}] startAgent`,
      cleanupFailureMessage: `[AIAdapter:${adapterName}] startAgent and connector cleanup both failed.`,
    });
  }
}

/**
 * Run one adapter start, from the provider context to the persisted row.
 *
 * Every refusal it returns has already given back what it took; everything it
 * throws is given back by the caller's single `catch`, which is what keeps the
 * acquisitions leak-proof without a `finally` per resource.
 * @param deps - Adapter-provided dependencies
 * @param payload - Validated startAgent request payload
 * @param agentId - Resolved agent identity for this start
 * @param acquisitions - Acquisition state this attempt records into
 * @returns The response to answer with, and the initial turn's handle when there is one
 */
async function runStartAttempt<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  deps: StartAgentHandlerDeps<TBus, TConnector, TAgent>,
  payload: StartAgentRequestPayload,
  agentId: string,
  acquisitions: StartAcquisitions,
): Promise<{ result: StartAgentResponsePayload; messageHandle: MessageHandle | undefined }> {
  const { name, registry, globalBus, createAgent } = deps;
  // Absence is a closed configless state, never implicit native or ambient auth.
  const providerContext: ProviderContext =
    payload.providerContext === undefined
      ? createUnresolvedProviderContext()
      : ProviderContextSchema.parse(payload.providerContext);

  assertValidEphemeralStartPayload(payload);
  const sessionId = await resolveSessionId(payload, globalBus);
  const resolvedPayload = { ...payload, providerContext };

  const refusal = await acquireStartOwnership(deps, { payload: resolvedPayload, agentId, sessionId, acquisitions });
  if (refusal !== undefined) return { result: refusal, messageHandle: undefined };
  const resumeAdapterSessionId = getResumeAdapterSessionId(payload);

  const sessionContext = payload.sessionContext ? SessionContextSchema.parse(payload.sessionContext) : undefined;
  const { agent, startResult } = await createAndStartAgentWithClaim({
    markDispatched: () => {
      acquisitions.dispatched = true;
    },
    publication: acquisitions.publication,
    agentId,
    sessionId,
    payload,
    providerContext,
    sessionContext,
    adapterName: name,
    resumeAdapterSessionId,
    registry,
    globalBus,
    createAgent,
  });
  const { adapterSessionId, messageId, messageHandle } = startResult;

  // Store agent and session info in registry, handing over the claimed resume
  // target so the claim is settled even when the start did not end up on it: a
  // start that suppresses native resume abandons the armed target and the
  // connector mints its own provider session.
  registry.set(agentId, { agent, sessionId, adapterSessionId, usage: createUsageBaseline() }, resumeAdapterSessionId);
  // Both process-local claims are settled by that registration, so a later
  // failure has nothing of theirs left to give back.
  acquisitions.claimedIdentity = false;
  acquisitions.resumeAdapterSessionId = undefined;

  if (!payload.ephemeral) {
    const failure = await persistStartedAgent(
      deps,
      { agentId, sessionId, adapterSessionId },
      resolvedPayload,
      acquisitions,
    );
    if (failure !== undefined) return { result: failure, messageHandle: undefined };
    await announceStartedAdapterSession(agent, adapterSessionId, acquisitions.publication);
  }
  // **The hand-over is complete**: everything this start publishes has been
  // published, and the key now travels to the caller in the response below. From
  // here the agent's own routes may report it — see
  // {@link releaseProviderKeyPublication} for what the remaining gap to the
  // caller's settlement is and why the adapter cannot see it.
  releaseProviderKeyPublication(acquisitions.publication);

  return {
    result: {
      success: true,
      agentId,
      adapterId: deps.adapterId,
      sessionId,
      adapterSessionId,
      ...(messageId !== undefined && { messageId }),
    },
    messageHandle,
  };
}

/**
 * Announce the provider session an adapter-owned start settled on.
 *
 * **Path C's currency writer is the movement observer (§4.1), and an observer
 * only runs on an announcement.** Every other producer of one is an *event*:
 * payload enrichment records the connector's identity as the agent emits, and a
 * connector swap records the replacement's. An idle start emits nothing and
 * swaps nothing, so on that path the announcement has to come from the start —
 * without it the connector's session is never settled, and a start whose
 * provider declined the resume leaves the reservation on the abandoned key while
 * the live one stays unclaimed. Not a window that the first turn closes: an
 * agent that never takes a turn never closes it at all, and the next reservation
 * for that key walks through unopposed.
 *
 * Routed through the agent's tracker rather than settling here, which keeps the
 * observer the single settle producer: the adapter states where the connector
 * is, and what that means for durable currency stays the authority's to decide.
 *
 * For a **deferred** key it is not announced but *handed over*: the caller
 * settles the confirmed key itself as Path A and Path D prescribe, so announcing
 * would put a second write behind one movement — while saying nothing would
 * leave the key unmarked, and the first event enriched after this start
 * registers would announce it after all, racing the settlement it belongs to.
 * Recording it as the caller's says both things at once.
 *
 * Which of the two this is comes from the attempt's own publication gate, and
 * only from there: "may this key be published" and "who settles it" are one
 * question, and re-deriving the second from the payload is how a route ends up
 * answering it from a fact the gate does not share.
 * @param agent - The started agent, whose tracker owns the announcement.
 * @param adapterSessionId - Provider session the connector confirmed, when it confirmed one.
 * @param publication - The attempt's provider-key publication gate.
 */
async function announceStartedAdapterSession(
  agent: {
    recordConfirmedAdapterSession: (adapterSessionId: string, settledByCaller?: boolean) => Promise<void>;
  },
  adapterSessionId: string | undefined,
  publication: ProviderKeyPublication,
): Promise<void> {
  if (adapterSessionId === undefined) return;
  await agent.recordConfirmedAdapterSession(adapterSessionId, !providerKeyIsPublishable(publication));
}

/**
 * Write the started agent's row and announce it, guarded when it was reserved.
 *
 * A reserved start's row is what its reservation was taken against, so a refused
 * write is a start failure rather than a logged inconvenience: reporting success
 * over an unwritten row leaves it `starting`, and the next send turns that into
 * a second recovery for a live agent. The typed refusal it answers with is the
 * one post-dispatch outcome the adapter can describe, which is why it returns
 * rather than throws.
 * @param deps - Adapter-provided dependencies
 * @param identity - Agent, session and the provider session the connector landed on
 * @param payload - Start payload with its provider context resolved
 * @param acquisitions - What the attempt holds, with `dispatched` already set
 * @returns The refusal to answer with, or `undefined` when the row stands
 */
async function persistStartedAgent<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  deps: StartAgentHandlerDeps<TBus, TConnector, TAgent>,
  identity: { agentId: string; sessionId: string; adapterSessionId: string | undefined },
  payload: StartAgentRequestPayload & { providerContext: ProviderContext },
  acquisitions: StartAcquisitions,
): Promise<StartAgentRefusal | undefined> {
  const { agentId, sessionId, adapterSessionId } = identity;
  let failure: string | undefined;
  try {
    failure = await persistAndEmitAgent(agentId, sessionId, adapterSessionId, payload, deps, {
      guarded: acquisitions.reservation !== undefined,
      // Restated, never recomputed: this write replaces the whole pre-dispatch
      // record, and a fresh `createdAt` here would date the agent from the
      // moment its connector came up.
      createdAt: acquisitions.agentRowCreatedAt,
      publication: acquisitions.publication,
    });
  } catch (error) {
    await rollbackRegisteredAgent(deps.registry, agentId, deps.name, error);
    throw error;
  }
  if (failure === undefined) return undefined;
  return failStartAfterRegistration(deps, agentId, acquisitions, failure);
}

/**
 * Create the `adapter.startAgent` RPC handler.
 *
 * Returns a handler function that creates an agent, starts or initializes it,
 * registers it in the registry, persists its identity, and emits lifecycle events.
 *
 * For resume-mode requests, atomically claims the provider-native session ID
 * before creating the agent to prevent TOCTOU races where two concurrent
 * attach-resume requests for the same `adapterSessionId` both pass the
 * attach-handler's live-writer guard before either agent registers. When the
 * adapter also owns the agent row, that process-local claim is backed by a
 * **durable** reservation of the same provider session: `startAgent` has many
 * producers, and requiring each of them to reserve would still leave the next
 * one unprotected, so the gate lives where every producer must pass.
 *
 * The agent identity is minted here unless the caller supplied one. A supplied
 * one is honoured — and transfers the agent row to the caller, so the adapter
 * persists no record of its own (see {@link callerOwnsAgentRow}); a supplied one
 * that is already claimed or registered here is refused, since it would mean two
 * starts for a single agent identity.
 * @param deps - Adapter-provided dependencies
 * @returns Handler bound to the supplied dependencies
 */
export function createStartAgentHandler<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  deps: StartAgentHandlerDeps<TBus, TConnector, TAgent>,
): (ctx: RequestContext<StartAgentRequestPayload, StartAgentResponsePayload>) => Promise<void> {
  const { name, registry, globalBus } = deps;

  return async function handleStartAgent(
    ctx: RequestContext<StartAgentRequestPayload, StartAgentResponsePayload>,
  ): Promise<void> {
    const payload = ctx.payload;
    const agentId = payload.agentId ?? crypto.randomUUID();

    const collision = refuseAgentIdentityCollision(payload, agentId, registry);
    if (collision !== undefined) {
      ctx.setResult(collision);
      return;
    }

    // The one predicate the collision refusal claims under, read again rather
    // than returned from it, so the two readings cannot drift apart — and read
    // once here, because the claim this attempt holds and the gate it publishes
    // under are two consequences of the same fact.
    const callerOwnsRow = callerOwnsAgentRow(payload);
    const acquisitions: StartAcquisitions = {
      // Held exactly when the caller supplied the identity.
      claimedIdentity: callerOwnsRow,
      resumeAdapterSessionId: undefined,
      reservation: undefined,
      agentRowCreatedAt: undefined,
      dispatched: false,
      publication: providerKeyPublicationFor({
        callerOwnsAgentRow: callerOwnsRow,
        ...(payload.ephemeral !== undefined && { ephemeral: payload.ephemeral }),
      }),
    };

    let attempt: { result: StartAgentResponsePayload; messageHandle: MessageHandle | undefined };
    try {
      attempt = await runStartAttempt(deps, payload, agentId, acquisitions);
    } catch (error) {
      // The scope of this catch is exactly "failures with no modeled response":
      // every outcome the attempt can describe answers for itself and has
      // already given its acquisitions back.
      await releaseStartAcquisitions({ globalBus, registry, agentId, ...acquisitions });
      throw error;
    }

    ctx.setResult(attempt.result);

    if (payload.ephemeral && attempt.result.success) {
      void cleanupEphemeralAgentAfterTurn(registry, agentId, name, attempt.messageHandle).catch((err) => {
        console.warn(`[AIAdapter:${name}] Ephemeral agent cleanup failed:`, err);
      });
    }
  };
}
