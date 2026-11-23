/**
 * Routes messages to target agents.
 *
 * Extracted from SessionOrchestrator for file size management.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import {
  applyCwdChangeTemplate,
  DEFAULT_CWD_CHANGE_NOTIFICATION,
  readCwdChangeNotificationPref,
} from './cwd-change-notification.js';
import type {
  IMakaioSession,
  Message,
  MessageInput,
  MakaioSessionAgent,
  ResponseSchemaDescriptor,
  SessionContext,
} from '@makaio/contracts';
import { getHookAbortError } from './hook-abort-error.js';
import { emitRoutingAcknowledged, terminalizeRoutingAgent } from './routing-lifecycle.js';
import type { Turn } from '../entities/turn.js';
import { assembleForkContext } from '../context/assemble-fork-context.js';
import type { AssembleForkContextCapabilities } from '../context/assemble-fork-context.js';
import { convertSessionMessage } from '../context/convert-session-message.js';
import { getFullConversation } from '../context/get-full-conversation.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';
import type { TurnCompletionRecorder } from './routing-lifecycle.js';
import { buildAgentContext } from './agent-context.js';
import type { CwdSwapMeta } from './agent-context.js';

/**
 * Interface for turn context enrichment.
 * Implemented by TurnContextEnricher in orchestration package.
 */
interface ITurnContextEnricher {
  enrichForDeliveryMode(
    call: CallContext,
    originalHistory: Message[] | undefined,
    turnId: string,
    deliveryMode: 'enqueue' | 'immediate' | 'replace' | undefined,
  ): Promise<Message[] | undefined>;
}

interface RouteToSingleAgentInput {
  bus: IMakaioBus;
  session: IMakaioSession;
  turn: Turn;
  message: MessageInput;
  messageId: string;
  deliveryMode: 'enqueue' | 'immediate' | undefined;
  onTurnComplete: (call: CallContext, turn: Turn, result: { success: boolean; errors: string[] }) => Promise<void>;
  agent: MakaioSessionAgent;
  agentContext?: SessionContext;
  responseSchema?: ResponseSchemaDescriptor;
  turnManager: TurnCompletionRecorder;
}

/**
 * Resolve native fork capabilities for all target agents.
 * @param call - Call context of the handled message being routed; forwarded to the capability queries
 * @param bus - Bus instance for adapter capability queries
 * @param session - Session being routed
 * @param agents - Target agents that would receive the same fork context
 * @returns Capability signals for fork context assembly
 */
async function resolveForkContextCapabilities(
  call: CallContext,
  bus: IMakaioBus,
  session: IMakaioSession,
  agents: MakaioSessionAgent[],
): Promise<AssembleForkContextCapabilities | undefined> {
  if (session.parentSessionId === undefined) {
    return undefined;
  }

  const adapterIds = [...new Set(agents.map((agent) => agent.adapterId))];
  if (adapterIds.length === 0) {
    return { adapterSupportsNativeFork: false, midHistoryForkSupported: false };
  }

  const results = await Promise.all(
    adapterIds.map(async (adapterId) => {
      try {
        const result = await bus.requestOptional(call, AdapterSubjects.getCapabilities, { adapterId });
        const capabilities = result.handled ? new Set(result.data.capabilities) : new Set<string>();
        return {
          supportsNativeFork: capabilities.has('session:fork'),
          supportsMidHistoryFork: capabilities.has('session:forkAtMessage'),
        };
      } catch {
        return { supportsNativeFork: false, supportsMidHistoryFork: false };
      }
    }),
  );

  return {
    adapterSupportsNativeFork: results.every((r) => r.supportsNativeFork),
    midHistoryForkSupported: results.every((r) => r.supportsMidHistoryFork),
  };
}

/**
 * Shared payload for a single agent send + acknowledged emission.
 */
interface SendAndAcknowledgePayload {
  agentId: string;
  adapterId: string;
  message: MessageInput;
  deliveryMode: 'enqueue' | 'immediate' | undefined;
  messageId: string;
  turnId: string;
  sessionId: string;
  sessionContext: SessionContext | undefined;
  responseSchema?: ResponseSchemaDescriptor;
  turn: Turn;
}

/**
 * Send a message to one agent and emit `user_message.acknowledged` on success.
 *
 * This is the single source of truth for the send + acknowledge sequence shared
 * by the native-attempt path and the standard dispatch path.
 * @param call - Call context of the handled message being routed; forwarded to the send and acknowledgement
 * @param bus - Bus instance
 * @param payload - All fields required for the bus call and the acknowledgement
 */
async function sendAndAcknowledge(
  call: CallContext,
  bus: IMakaioBus,
  payload: SendAndAcknowledgePayload,
): Promise<void> {
  const {
    agentId,
    adapterId,
    message,
    deliveryMode,
    messageId,
    turnId,
    sessionId,
    sessionContext,
    responseSchema,
    turn,
  } = payload;
  await bus.request(call, AgentSubjects.sendMessage, {
    agentId,
    adapterId,
    message,
    deliveryMode,
    messageId,
    turnId,
    sessionId,
    sessionContext,
    ...(responseSchema !== undefined && { responseSchema }),
  });
  await emitRoutingAcknowledged(call, bus, {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    agentId,
  });
}

/**
 * Build degraded native retry context from persisted history.
 *
 * The current user message is routed separately as `message`; it may already
 * be persisted before routing starts, so it must not also appear in injected
 * retry history.
 * @param call - Call context of the handled message being routed; forwarded to the history lookup
 * @param bus - Bus instance
 * @param session - Session to build context for
 * @param currentMessageId - Current user message ID to exclude from history
 * @returns SessionContext with filtered messageHistory and fresh-mode signal
 */
async function buildNativeFallbackContext(
  call: CallContext,
  bus: IMakaioBus,
  session: IMakaioSession,
  currentMessageId: string,
): Promise<SessionContext> {
  const contextResult = await getFullConversation(call, bus, session.sessionId);
  const messageHistory = contextResult.messages
    .filter((storedMessage) => storedMessage.messageId !== currentMessageId)
    .map(convertSessionMessage);

  return {
    messageHistory,
    isFirstTurn: true,
  };
}

/**
 * Attempt a native send and return the context to use for the actual dispatch.
 *
 * When `nativeContext.nativeLocality.kind === 'native'` this function makes a
 * speculative bus call. On success it emits `user_message.acknowledged` and
 * returns `null` to signal that routing is already complete. On send failure
 * it builds a fresh-with-history context and returns it so the caller can
 * retry once on the standard path.
 *
 * Only the `AgentSubjects.sendMessage` call is covered by the degrade
 * catch. An acknowledgement listener failure after a successful send is
 * reported without changing delivery state, so an accepted provider turn is
 * neither retried nor terminalized prematurely.
 * @param call - Call context of the handled message being routed; forwarded to the send, degrade event and history lookup
 * @param bus - Bus instance
 * @param session - Session for history building on degrade
 * @param payload - Shared request fields for the bus call
 * @param nativeContext - Agent context carrying a native locality verdict
 * @returns `null` when native send succeeded (caller must return); degraded
 *   context when it failed (caller must retry on the standard path)
 */
async function attemptNativeSendOrDegrade(
  call: CallContext,
  bus: IMakaioBus,
  session: IMakaioSession,
  payload: {
    agentId: string;
    adapterId: string;
    message: MessageInput;
    deliveryMode: 'enqueue' | 'immediate' | undefined;
    messageId: string;
    turnId: string;
    sessionId: string;
    responseSchema?: ResponseSchemaDescriptor;
    turn: Turn;
  },
  nativeContext: SessionContext,
): Promise<SessionContext | null> {
  const { agentId, adapterId, message, deliveryMode, messageId, turnId, sessionId, responseSchema, turn } = payload;

  // The degrade catch covers only the actual send so fallback cannot duplicate
  // an already accepted provider turn.
  try {
    await bus.request(call, AgentSubjects.sendMessage, {
      agentId,
      adapterId,
      message,
      deliveryMode,
      messageId,
      turnId,
      sessionId,
      sessionContext: nativeContext,
      ...(responseSchema !== undefined && { responseSchema }),
    });
  } catch (error) {
    if (getHookAbortError(error)) {
      throw error;
    }
    // Native send failed — build degraded context so the caller can retry.
    const degradeVerdict = { kind: 'degrade' as const, reason: 'native-attempt-failed' as const };
    void emitLocalityDegradeEvent(call, bus, {
      sessionId,
      intent: nativeContext.nativeFork ? 'fork' : 'resume',
      verdict: degradeVerdict,
      agentId,
      adapterId,
      turnId,
    });
    const freshContext = await buildNativeFallbackContext(call, bus, session, messageId);
    return {
      ...nativeContext,
      ...freshContext,
      nativeLocality: degradeVerdict,
      nativeFork: undefined,
    };
  }

  // Send succeeded — acknowledgement cannot roll delivery back.
  await emitRoutingAcknowledged(call, bus, {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    agentId,
  });

  return null; // Native send succeeded — caller should return immediately.
}

/**
 * Route one message to one agent and handle lifecycle side effects.
 *
 * When the outbound context carries `nativeLocality.kind === 'native'` and the
 * adapter rejects the request, the call is retried exactly once with a degraded
 * context (kind: 'degrade', reason: 'native-attempt-failed') and freshly built
 * message history. If the retry also fails, the error propagates to the standard
 * error handler and the agent is marked as errored.
 * @param call - Call context of the handled message being routed; forwarded to every send
 * @param input - Routing payload and lifecycle dependencies for one agent
 */
async function routeToSingleAgent(call: CallContext, input: RouteToSingleAgentInput): Promise<void> {
  const { bus, session, turn, message, messageId, deliveryMode, onTurnComplete, agent, responseSchema, turnManager } =
    input;
  let { agentContext } = input;

  const basePayload = {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    message,
    deliveryMode,
    messageId,
    turnId: turn.turnId,
    sessionId: session.sessionId,
    responseSchema,
    turn,
  };

  try {
    // One-shot degrade retry: null on success, else a fallback retry context.
    if (agentContext?.nativeLocality?.kind === 'native') {
      const fallback = await attemptNativeSendOrDegrade(call, bus, session, basePayload, agentContext);
      if (fallback === null) return;
      agentContext = fallback;
    }

    await sendAndAcknowledge(call, bus, {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      message,
      deliveryMode,
      messageId,
      turnId: turn.turnId,
      sessionId: session.sessionId,
      sessionContext: agentContext,
      responseSchema,
      turn,
    });
  } catch (error) {
    if (getHookAbortError(error)) {
      await terminalizeRoutingAgent(call, {
        bus,
        turn,
        messageId,
        agentId: agent.agentId,
        outcome: 'cancelled',
        onTurnComplete,
        turnManager,
      });
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    await terminalizeRoutingAgent(call, {
      bus,
      turn,
      messageId,
      agentId: agent.agentId,
      outcome: 'error',
      error: errorMessage,
      onTurnComplete,
      turnManager,
    });
  }
}

/**
 * Options for routing a message to target agents.
 */
export interface RouteToAgentsOptions {
  /** Bus instance for communication. */
  readonly bus: IMakaioBus;
  /** Session metadata (for fork detection). */
  readonly session: IMakaioSession;
  /** Target agents to route to. */
  readonly agents: MakaioSessionAgent[];
  /** Message content to send. */
  readonly message: MessageInput;
  /** Message identifier. */
  readonly messageId: string;
  /** Turn tracking object. */
  readonly turn: Turn;
  /** How to deliver the message. */
  readonly deliveryMode: 'enqueue' | 'immediate' | undefined;
  /** Callback when turn completes (all agents done). */
  readonly onTurnComplete: (
    call: CallContext,
    turn: Turn,
    result: { success: boolean; errors: string[] },
  ) => Promise<void>;
  /** Shared turn ledger owner. */
  readonly turnManager: TurnCompletionRecorder;
  /** Session context with curated messageHistory and decision signals. */
  readonly sessionContext?: SessionContext;
  /** Optional enricher for immediate message context. */
  readonly turnContextEnricher?: ITurnContextEnricher;
  /** Whether this is the first message in a new turn. */
  readonly isNewTurn?: boolean;
  /** Context enriched with messageHistory for agents that were just recovered. */
  readonly recoveryContext?: SessionContext;
  /** Set of agent IDs that were recovered in this handler invocation. */
  readonly recoveredAgentIds?: ReadonlySet<string>;
  /** Set of agent IDs that swapped connector due to cwd mismatch. */
  readonly swappedAgentIds?: ReadonlySet<string>;
  /** Previous/new cwd metadata keyed by agent ID. */
  readonly swappedAgentCwd?: ReadonlyMap<string, CwdSwapMeta>;
  /** Curated history for agents forced into fresh mode. */
  readonly freshMessageHistory?: Message[];
  /** Optional structured output descriptor for the turn. */
  readonly responseSchema?: ResponseSchemaDescriptor;
  /** Stable machine identity of the current host process for locality evaluation. */
  readonly localMachineId?: string;
}

/**
 * Degrade a native fork directive for the sendMessage path.
 *
 * `nativeFork` is only consumable on the startAgent path. This function
 * dispatches exclusively via sendMessage (agents are already running), so
 * a native fork directive can never reach the provider. Degrade to
 * fresh-with-history so the child session starts with the projected parent
 * conversation instead of an empty context.
 * @param call - Call context of the handled message being routed; forwarded to the degrade event and history lookup
 * @param bus - Bus for storage lookups and degrade event emission
 * @param session - Session being routed
 * @param context - Fork-enriched context carrying the nativeFork directive
 * @returns Context with nativeFork removed and history injected
 */
async function degradeNativeForkForSendMessage(
  call: CallContext,
  bus: IMakaioBus,
  session: IMakaioSession,
  context: SessionContext,
): Promise<SessionContext> {
  const verdict = { kind: 'degrade' as const, reason: 'agent-already-started' as const };
  void emitLocalityDegradeEvent(call, bus, { sessionId: session.sessionId, intent: 'fork', verdict });
  const contextResult = await getFullConversation(call, bus, session.sessionId);
  const messageHistory = contextResult.messages.map(convertSessionMessage);
  return { ...context, messageHistory, nativeFork: undefined, nativeLocality: verdict };
}

/**
 * Route a message to target agents via agent.sendMessage.
 *
 * Fans out to all agents in parallel. On routing failure, marks agent as errored
 * and checks for turn completion.
 *
 * For fork sessions on their first turn, assembles projected context from parent chain.
 * @param call - Call context of the handled message being routed; forwarded to every send
 * @param options - Routing options including bus, session, agents, message, and lifecycle dependencies
 */
export async function routeToAgents(call: CallContext, options: RouteToAgentsOptions): Promise<void> {
  const {
    bus,
    session,
    agents,
    message,
    messageId,
    turn,
    deliveryMode,
    onTurnComplete,
    turnManager,
    sessionContext,
    turnContextEnricher,
    isNewTurn,
    recoveryContext,
    recoveredAgentIds,
    swappedAgentIds,
    swappedAgentCwd,
    freshMessageHistory,
    responseSchema,
    localMachineId,
  } = options;
  const forkContextCapabilities = await resolveForkContextCapabilities(call, bus, session, agents);
  let forkEnrichedContext = await assembleForkContext(
    call,
    bus,
    session,
    session.sessionId,
    sessionContext,
    isNewTurn,
    localMachineId,
    forkContextCapabilities,
  );

  // nativeFork is only consumable on the startAgent path — degrade it for sendMessage.
  if (forkEnrichedContext?.nativeFork) {
    forkEnrichedContext = await degradeNativeForkForSendMessage(call, bus, session, forkEnrichedContext);
  }

  const originalHistory = forkEnrichedContext?.messageHistory;
  const enrichedMessageHistory = turnContextEnricher
    ? await turnContextEnricher.enrichForDeliveryMode(call, originalHistory, turn.turnId, deliveryMode)
    : originalHistory;

  const enrichedSessionContext = forkEnrichedContext
    ? { ...forkEnrichedContext, messageHistory: enrichedMessageHistory }
    : undefined;

  // Read the CWD notification preference once before fanning out to agents.
  const cwdChangePref = swappedAgentIds?.size
    ? await readCwdChangeNotificationPref(call, bus)
    : DEFAULT_CWD_CHANGE_NOTIFICATION;

  const routingPromises = agents.map(async (agent) => {
    const swapMeta = swappedAgentCwd?.get(agent.agentId);
    const cwdMessage =
      swapMeta && cwdChangePref.enabled
        ? applyCwdChangeTemplate(cwdChangePref.template, swapMeta.previousCwd, swapMeta.newCwd)
        : undefined;

    const agentContext = buildAgentContext({
      baseContext: enrichedSessionContext,
      recoveryContext,
      isRecovered: recoveredAgentIds?.has(agent.agentId) ?? false,
      isSwapped: swappedAgentIds?.has(agent.agentId) ?? false,
      swapMeta,
      cwdMessage,
      freshMessageHistory,
    });

    await routeToSingleAgent(call, {
      bus,
      session,
      turn,
      message,
      messageId,
      deliveryMode,
      onTurnComplete,
      turnManager,
      agent,
      agentContext,
      responseSchema,
    });
  });

  await Promise.all(routingPromises);
}
