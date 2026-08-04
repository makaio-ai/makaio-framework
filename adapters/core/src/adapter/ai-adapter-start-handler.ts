/**
 * Start-agent handler factory.
 *
 * Extracted from AIAdapter to keep ai-adapter.ts below the ESLint line-count
 * ceiling. Follows the same factory pattern as ai-adapter-infer.ts.
 *
 * Encapsulates the full `adapter.startAgent` RPC lifecycle:
 * - Session resolution (use provided or create via SessionSubjects.create)
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
import type { ExtractSubjectResponse, RequestContext } from '@makaio/core';
import {
  AdapterSubjects,
  ProviderContextSchema,
  SessionContextSchema,
  SessionSubjects,
  type ProviderContext,
  type SessionContext,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { createUnresolvedProviderContext, normalizeMessageInput } from '../utils/index.js';
import {
  commitAdapterProviderContextActivation,
  prepareAdapterProviderContextActivation,
  rollbackAdapterProviderContextActivationAfterFailure,
  type ProviderContextActivationLifecycle,
} from './provider-context-activation-lifecycle.js';

type StartAgentResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.startAgent>;

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
 * Whether the caller owns the agent row for this start.
 *
 * A caller that supplies `agentId` has already persisted the row — and, having
 * done so, owns its lifecycle columns for the duration of the start. The
 * adapter's own whole-record write would overwrite them, so it is suppressed.
 * Derived from the payload at every point that needs it rather than threaded
 * through, so the two readings cannot drift apart.
 * @param payload - Validated startAgent request payload
 * @returns `true` when the caller minted and persisted the agent identity
 */
function callerOwnsAgentRow(payload: StartAgentRequestPayload): boolean {
  return payload.agentId !== undefined;
}

/** The refusal half of the startAgent response. */
type StartAgentRefusal = Extract<StartAgentResponsePayload, { success: false }>;

/**
 * Refuse a caller-supplied agent identity that is already live on this instance.
 *
 * Two starts for one agent identity would leave a second connector silently
 * replacing a live one, and no caller can tell afterwards which of the two its
 * agent row now describes. The refusal fires before anything reaches the
 * provider, so the caller may release whatever it reserved.
 *
 * A minted identity cannot collide, so the check applies only to supplied ones.
 *
 * **Known window, deliberately left open.** This reads the registry and the
 * matching `registry.set()` happens many awaits later, so two concurrent starts
 * naming one supplied `agentId` would both pass here and the second would
 * replace the first. What keeps that unreachable is who supplies the field:
 * `agentId` is optional, and the only production caller that sends it mints it
 * with `crypto.randomUUID()` for that one attempt and runs the attempt inside
 * the session service's per-agent exclusive-start seam. Every other caller omits
 * it and reads the identity back off the response — so no two starts can name
 * the same identity, and this refusal is defence against a caller that does not
 * exist yet rather than a race being lost today.
 *
 * The fix is not a second pending-set in this module. The registry already owns
 * exactly this shape for provider sessions — `claimAdapterSession()` checks and
 * inserts atomically, `set()` settles the claim, failure paths release it — so
 * an agent-identity claim belongs beside it, not in a parallel structure that
 * this handler would have to release on each of its several exit paths. The
 * registry is being reworked next, together with the first caller that can
 * supply an *existing* identity (an attach that reserves one); the atomic claim
 * lands there, with them.
 * @param payload - Validated startAgent request payload
 * @param agentId - Resolved agent identity for this start
 * @param registry - Registry of agents live on this adapter instance
 * @returns The refusal to answer with, or `undefined` when the start may proceed
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
  if (!callerOwnsAgentRow(payload) || registry.get(agentId) === undefined) {
    return undefined;
  }
  return {
    success: false,
    dispatch: 'not-dispatched',
    message: `Agent ${agentId} is already registered on this adapter instance`,
  };
}

/** Minimal deps needed by persistAndEmitAgent. */
interface PersistEmitDeps {
  adapterId: string;
  name: string;
  clientId: string | undefined;
  getPlatformDefaults: () => PlatformDefaults | undefined;
  globalBus: IMakaioBus;
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
 * Persist agent record and emit lifecycle events.
 *
 * Ensures persistence completes before events fire to avoid race conditions.
 *
 * The persistence step is skipped entirely when the caller owns the agent row
 * (see {@link callerOwnsAgentRow}); the lifecycle emissions below are not, since
 * they are what tells the rest of the system a live agent exists.
 * @param agentId - Agent identifier
 * @param sessionId - Makaio session ID
 * @param adapterSessionId - Provider session ID, or `undefined` for unconfirmed idle fork starts
 * @param payload - Start agent request payload with resolved providerContext
 * @param deps - Adapter identity and bus deps
 */
async function persistAndEmitAgent(
  agentId: string,
  sessionId: string,
  adapterSessionId: string | undefined,
  payload: StartAgentRequestPayload & { providerContext: ProviderContext },
  deps: PersistEmitDeps,
): Promise<void> {
  const { adapterId, name, clientId, getPlatformDefaults, globalBus } = deps;
  const role = payload.role;
  const now = Date.now();
  // Resolve effective cwd (request overrides platform defaults)
  const platformDefaults = getPlatformDefaults();
  const resolvedCwd = payload.cwd ?? platformDefaults?.cwd;

  // clientId: payload carries it from the caller; adapter definition is the authoritative fallback.
  const resolvedClientId = payload.clientId ?? clientId;
  // Skipped for a caller-owned row: the caller's record already carries this
  // agent's identity and its in-flight status, and this write is a whole record.
  if (!callerOwnsAgentRow(payload)) {
    try {
      await globalBus.requestOptional(AgentStorageSubjects.set, {
        agentId,
        agent: {
          agentId,
          adapterId,
          adapterName: name,
          sessionId,
          adapterSessionId,
          model: payload.model,
          cwd: resolvedCwd,
          allowedDirectories: payload.allowedDirectories,
          role,
          status: 'idle' as const,
          createdAt: now,
          lastActivityAt: now,
          ...(resolvedClientId !== undefined && { clientId: resolvedClientId }),
          ...(payload.harnessId !== undefined && { harnessId: payload.harnessId }),
          ...(payload.providerContext.state === 'resolved' && {
            providerConfigId: payload.providerContext.providerConfigId,
          }),
        },
      });
    } catch (error) {
      // Agent storage is best-effort in lightweight hosts; lifecycle events below
      // are the authoritative signal that a live agent exists.
      console.error(`[AIAdapter:${name}] Optional agent persistence failed:`, {
        agentId,
        adapterId,
        sessionId,
        error,
      });
    }
  }

  // Emit events AFTER agent is persisted to avoid race conditions

  // Notify global session service that an agent was added to the session.
  //
  // Awaited, not fired off: this event is what establishes the session row's
  // adapter identity and lead-agent designation, and service-tier handlers gate
  // on that designation (see the session currency handler). Returning from
  // `startAgent` before it lands would let the caller's next turn race the
  // designation. A failing consumer must still not undo a started agent, so the
  // failure is logged rather than propagated.
  try {
    await globalBus.emit(SessionSubjects.agent.added, {
      sessionId,
      agentId,
      adapterId,
      adapterName: name,
      adapterSessionId,
      role,
      model: payload.model,
      cwd: resolvedCwd,
    });
  } catch (error) {
    console.error(`[AIAdapter:${name}] session.agent.added consumer failed:`, { agentId, sessionId, error });
  }

  // Emit provider session tracking event
  void globalBus.emit(AdapterSubjects.session.created, {
    adapterId,
    adapterName: name,
    adapterSessionId,
    sessionId,
    model: payload.model ?? 'unknown',
  });
}

/**
 * Remove a registered-but-uncommitted agent after start-agent persistence fails.
 * @param registry - Active agent registry that owns close and status updates.
 * @param agentId - Agent identifier to remove.
 * @param adapterName - Adapter name for diagnostic context.
 * @param cause - Original persistence failure.
 */
async function rollbackRegisteredAgent<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>,
  agentId: string,
  adapterName: string,
  cause: unknown,
): Promise<void> {
  try {
    await registry.evict(agentId);
  } catch (evictionError) {
    throw new AggregateError(
      [cause, evictionError],
      `[AIAdapter:${adapterName}] startAgent persistence failed and live agent cleanup also failed.`,
      { cause: evictionError },
    );
  }
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
 * @returns Options for the adapter's agent factory
 */
function buildCreationOptions(
  payload: StartAgentRequestPayload,
  providerContext: ProviderContext,
  sessionContext: SessionContext | undefined,
): AgentCreationOptions {
  const { sessionContext: _rawSessionContext, ...creationPayload } = payload;
  return {
    ...creationPayload,
    providerContext,
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
 * Extract the provider-native session ID to claim for resume-mode requests.
 *
 * Returns the `adapterSessionId` from the payload when mode is `'resume'`,
 * or `undefined` for other modes where no claim is needed.
 * @param payload - Start-agent request payload
 * @returns Provider session ID to claim, or `undefined`
 */
function getResumeAdapterSessionId(payload: StartAgentRequestPayload): string | undefined {
  if (payload.mode === 'resume' && 'adapterSessionId' in payload) {
    return payload.adapterSessionId as string;
  }
  return undefined;
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
}): Promise<{ agent: TAgent; startResult: StartAgentExecutionResult }> {
  const {
    agentId,
    sessionId,
    payload,
    providerContext,
    sessionContext,
    adapterName,
    resumeAdapterSessionId,
    registry,
    globalBus,
  } = params;
  let activation: ProviderContextActivationLifecycle | undefined;
  let agent: TAgent | undefined;
  try {
    activation = await prepareAdapterProviderContextActivation(globalBus, providerContext);
    agent = await params.createAgent(
      agentId,
      sessionId,
      buildCreationOptions(payload, providerContext, sessionContext),
    );
    const startResult = await startOrInitializeAgent(agent, payload, sessionContext);
    await commitAdapterProviderContextActivation(activation);
    return { agent, startResult };
  } catch (error) {
    try {
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
    } finally {
      if (resumeAdapterSessionId !== undefined) {
        registry.releaseAdapterSessionClaim(resumeAdapterSessionId);
      }
    }
  }
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
 * attach-handler's live-writer guard before either agent registers.
 *
 * The agent identity is minted here unless the caller supplied one. A supplied
 * one is honoured — and transfers the agent row to the caller, so the adapter
 * persists no record of its own (see {@link callerOwnsAgentRow}); a supplied one
 * that is already registered here is refused, since it would mean two starts for
 * a single agent identity.
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
  const { adapterId, name, clientId, getPlatformDefaults, registry, globalBus, createAgent } = deps;

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

    // Absence is a closed configless state, never implicit native or ambient auth.
    const providerContext: ProviderContext =
      payload.providerContext === undefined
        ? createUnresolvedProviderContext()
        : ProviderContextSchema.parse(payload.providerContext);

    assertValidEphemeralStartPayload(payload);
    const sessionId = await resolveSessionId(payload, globalBus);

    // For resume mode, claim the provider-native session ID before creating
    // the agent. The atomic claim ensures exactly one concurrent request
    // proceeds; the loser receives a failure response.
    const resumeAdapterSessionId = getResumeAdapterSessionId(payload);
    if (resumeAdapterSessionId !== undefined) {
      const claimed = registry.claimAdapterSession(resumeAdapterSessionId);
      if (!claimed) {
        ctx.setResult({
          success: false,
          // Fires before the connector is created, so nothing exists provider-side.
          dispatch: 'not-dispatched',
          message: `Provider session ${resumeAdapterSessionId} is already claimed by another in-flight start`,
        });
        return;
      }
    }

    const sessionContext = payload.sessionContext ? SessionContextSchema.parse(payload.sessionContext) : undefined;
    const { agent, startResult } = await createAndStartAgentWithClaim({
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

    if (!payload.ephemeral) {
      try {
        await persistAndEmitAgent(
          agentId,
          sessionId,
          adapterSessionId,
          { ...payload, providerContext },
          { adapterId, name, clientId, getPlatformDefaults, globalBus },
        );
      } catch (error) {
        await rollbackRegisteredAgent(registry, agentId, name, error);
        throw error;
      }
    }

    ctx.setResult({
      success: true,
      agentId,
      adapterId,
      sessionId,
      adapterSessionId,
      ...(messageId !== undefined && { messageId }),
    });

    if (payload.ephemeral) {
      void cleanupEphemeralAgentAfterTurn(registry, agentId, name, messageHandle).catch((err) => {
        console.warn(`[AIAdapter:${name}] Ephemeral agent cleanup failed:`, err);
      });
    }
  };
}
