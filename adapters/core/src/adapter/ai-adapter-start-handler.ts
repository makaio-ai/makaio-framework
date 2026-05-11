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
import type { AgentCreationOptions, StartAgentRequestPayload } from './types.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { PlatformDefaults } from '../types/index.js';
import type { AgentRegistry } from './agent-registry.js';
import type { ExtractSubjectResponse, RequestContext } from '@makaio/core';
import {
  AdapterSubjects,
  SessionContextSchema,
  SessionSubjects,
  type ProviderContext,
  type SessionContext,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { normalizeMessageInput, createSentinelProviderContext } from '../utils/index.js';

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
  registry: AgentRegistry<TBus, TConnector, TAgent>;
  /** Global bus for cross-adapter communication. */
  globalBus: IMakaioBus;
  /** Factory that produces a new agent instance (delegates to adapter.createAgent). */
  createAgent: (agentId: string, sessionId: string, options: AgentCreationOptions) => Promise<TAgent>;
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
  readonly adapterSessionId: string;
  readonly messageId?: string;
  readonly messageHandle?: MessageHandle;
}

/**
 * Persist agent record and emit lifecycle events.
 *
 * Ensures persistence completes before events fire to avoid race conditions.
 * @param agentId - Agent identifier
 * @param sessionId - Makaio session ID
 * @param adapterSessionId - Provider session ID
 * @param payload - Start agent request payload with resolved providerContext
 * @param deps - Adapter identity and bus deps
 */
async function persistAndEmitAgent(
  agentId: string,
  sessionId: string,
  adapterSessionId: string,
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
  // providerConfigId is NOT persisted from the adapter layer — the adapter only has
  // the definitionId (e.g. 'anthropic'), not the config UUID the orchestrator
  // uses for credential resolution and rehydration. The orchestrator's
  // persistAgentIdentity call writes the correct providerConfigId.
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
        role,
        status: 'idle' as const,
        createdAt: now,
        lastActivityAt: now,
        ...(resolvedClientId !== undefined && { clientId: resolvedClientId }),
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

  // Emit events AFTER agent is persisted to avoid race conditions

  // Notify global session service that an agent was added to the session
  void globalBus.emit(SessionSubjects.agent.added, {
    sessionId,
    agentId,
    adapterId,
    adapterName: name,
    adapterSessionId,
    role,
    model: payload.model,
    cwd: resolvedCwd,
  });

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
  registry: AgentRegistry<TBus, TConnector, TAgent>,
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
 * Start an agent or initialize an idle connector, closing the agent if startup fails.
 * @param agent - Newly created, not-yet-registered agent.
 * @param payload - Start-agent request payload.
 * @param sessionContext - Parsed session context, when provided.
 * @param adapterName - Adapter name for cleanup diagnostics.
 * @returns Adapter session metadata produced by the connector.
 */
async function startOrInitializeAgent<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  agent: AIAgent<TBus, TConnector>,
  payload: StartAgentRequestPayload,
  sessionContext: SessionContext | undefined,
  adapterName: string,
): Promise<StartAgentExecutionResult> {
  try {
    if (payload.initialMessage !== undefined) {
      const normalizedMessage = normalizeMessageInput(payload.initialMessage);
      const startResult = await agent.start(normalizedMessage, {
        systemPrompt: payload.systemPrompt,
        sessionContext,
      });
      return {
        adapterSessionId: startResult.adapterSessionId,
        messageId: String(startResult.messageHandle.messageId),
        messageHandle: startResult.messageHandle,
      };
    }

    await agent.initialize({
      systemPrompt: payload.systemPrompt,
      sessionContext,
    });
    return { adapterSessionId: await agent.getAdapterSessionId() };
  } catch (error) {
    try {
      await agent.close({ emitSessionClosed: !payload.ephemeral });
    } catch (closeError) {
      console.warn(`[AIAdapter:${adapterName}] Agent cleanup failed after startAgent error:`, closeError);
    }
    throw error;
  }
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
  registry: AgentRegistry<TBus, TConnector, TAgent>,
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
 * Create the `adapter.startAgent` RPC handler.
 *
 * Returns a handler function that creates an agent, starts or initializes it,
 * registers it in the registry, persists its identity, and emits lifecycle events.
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
    const agentId = crypto.randomUUID();

    // providerContext is optional to support provider-less adapters (local CLI,
    // attach without explicit provider) and callers that omit a provider.
    // When absent, fall back to a minimal sentinel so connectors can apply
    // env-var or local-tooling credential resolution.
    //
    // Cast is safe: zod validated the incoming payload, so credentialRefs values
    // are genuine CredentialRef-branded strings. Zod loses the brand when inferring
    // through union schemas, so we restore it here with a single-step cast.
    const providerContext = (payload.providerContext ?? createSentinelProviderContext()) as ProviderContext;

    assertValidEphemeralStartPayload(payload);

    // Determine makaio sessionId:
    // - ephemeral agents preserve a caller-supplied sessionId or use a local UUID (no session service round-trip)
    // - create-mode agents ask the session service to create/confirm the session
    // - resume/fork agents attach to the session resolved by the orchestration layer
    let sessionId: string;
    if (payload.ephemeral) {
      sessionId = payload.sessionId ?? crypto.randomUUID();
    } else if ((payload.mode ?? 'create') === 'create') {
      const createResult = await globalBus.requestOptional(SessionSubjects.create, {
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      });
      sessionId = createResult.handled ? createResult.data.sessionId : (payload.sessionId ?? crypto.randomUUID());
    } else if (payload.sessionId) {
      sessionId = payload.sessionId;
    } else {
      throw new Error(`startAgent ${payload.mode} mode requires sessionId`);
    }

    const agent = await createAgent(agentId, sessionId, {
      ...payload,
      providerContext,
    });

    const sessionContext = payload.sessionContext ? SessionContextSchema.parse(payload.sessionContext) : undefined;

    const { adapterSessionId, messageId, messageHandle } = await startOrInitializeAgent(
      agent,
      payload,
      sessionContext,
      name,
    );

    // Store agent and session info in registry
    registry.set(agentId, {
      agent,
      sessionId,
      adapterSessionId,
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
    });

    if (!payload.ephemeral) {
      try {
        // Persist agent record and emit lifecycle events
        await persistAndEmitAgent(
          agentId,
          sessionId,
          adapterSessionId,
          { ...payload, providerContext },
          {
            adapterId,
            name,
            clientId,
            getPlatformDefaults,
            globalBus,
          },
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
