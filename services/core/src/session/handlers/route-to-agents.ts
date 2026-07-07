/**
 * Routes messages to target agents.
 *
 * Extracted from SessionOrchestrator for file size management.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
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
import type { Turn } from '../entities/turn.js';
import { assembleForkContext } from '../context/assemble-fork-context.js';
import type { AssembleForkContextCapabilities } from '../context/assemble-fork-context.js';
import { convertSessionMessage } from '../context/convert-session-message.js';
import { getFullConversation } from '../context/get-full-conversation.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';

/**
 * Interface for turn context enrichment.
 * Implemented by TurnContextEnricher in orchestration package.
 */
interface ITurnContextEnricher {
  enrichForDeliveryMode(
    originalHistory: Message[] | undefined,
    turnId: string,
    deliveryMode: 'enqueue' | 'immediate' | 'replace' | undefined,
  ): Promise<Message[] | undefined>;
}

interface CwdSwapMeta {
  previousCwd: string;
  newCwd: string;
}

interface PerAgentContextInput {
  baseContext?: SessionContext;
  recoveryContext?: SessionContext;
  isRecovered: boolean;
  isSwapped: boolean;
  swapMeta?: CwdSwapMeta;
  /**
   * Pre-resolved CWD change message to inject, or undefined when notifications
   * are disabled or no swap occurred. Resolved once in `routeToAgents` before
   * the per-agent fan-out to avoid redundant preference lookups.
   */
  cwdMessage?: string;
  freshMessageHistory?: Message[];
}

interface RouteToSingleAgentInput {
  bus: IMakaioBus;
  session: IMakaioSession;
  turn: Turn;
  message: MessageInput;
  messageId: string;
  deliveryMode: 'enqueue' | 'immediate' | undefined;
  onTurnComplete: (turn: Turn, result: { success: boolean; errors: string[] }) => Promise<void>;
  agent: MakaioSessionAgent;
  agentContext?: SessionContext;
  responseSchema?: ResponseSchemaDescriptor;
}

/**
 * Resolve native fork capabilities for all target agents.
 * @param bus - Bus instance for adapter capability queries
 * @param session - Session being routed
 * @param agents - Target agents that would receive the same fork context
 * @returns Capability signals for fork context assembly
 */
async function resolveForkContextCapabilities(
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
        const result = await bus.requestOptional(AdapterSubjects.getCapabilities, { adapterId });
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
 * Build agent-specific session context by layering recovery/swap overlays.
 * @param input - Base and overlay context inputs for a single agent
 * @returns Final context for this agent, or undefined when no context applies
 */
function buildAgentContext(input: PerAgentContextInput): SessionContext | undefined {
  const { baseContext, recoveryContext, isRecovered, isSwapped, swapMeta, cwdMessage, freshMessageHistory } = input;

  let agentContext = isRecovered && recoveryContext ? { ...baseContext, ...recoveryContext } : baseContext;
  if (!isSwapped) {
    // Keep non-swapped agents on their normal resume path.
    return agentContext;
  }

  const cwdChangeContext =
    swapMeta && cwdMessage !== undefined
      ? {
          cwdChange: {
            previousCwd: swapMeta.previousCwd,
            newCwd: swapMeta.newCwd,
            message: cwdMessage,
          },
        }
      : undefined;

  agentContext = {
    ...agentContext,
    hasConnectorSwap: true,
    ...(freshMessageHistory !== undefined && { messageHistory: freshMessageHistory }),
    ...(cwdChangeContext && {
      turnContext: {
        ...agentContext?.turnContext,
        ...cwdChangeContext,
      },
    }),
  };

  return agentContext;
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
 * @param bus - Bus instance
 * @param payload - All fields required for the bus call and the acknowledgement
 */
async function sendAndAcknowledge(bus: IMakaioBus, payload: SendAndAcknowledgePayload): Promise<void> {
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
  await bus.request(AgentSubjects.sendMessage, {
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
  await bus.emit(SessionSubjects.user_message.acknowledged, {
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
 * @param bus - Bus instance
 * @param session - Session to build context for
 * @param currentMessageId - Current user message ID to exclude from history
 * @returns SessionContext with filtered messageHistory and fresh-mode signal
 */
async function buildNativeFallbackContext(
  bus: IMakaioBus,
  session: IMakaioSession,
  currentMessageId: string,
): Promise<SessionContext> {
  const contextResult = await getFullConversation(bus, session.sessionId);
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
 * catch. An acknowledgement listener failure after a successful send is NOT
 * treated as a native delivery failure — it propagates to the caller so that
 * a successfully delivered message is never re-sent on the fallback path.
 * @param bus - Bus instance
 * @param session - Session for history building on degrade
 * @param payload - Shared request fields for the bus call
 * @param nativeContext - Agent context carrying a native locality verdict
 * @returns `null` when native send succeeded (caller must return); degraded
 *   context when it failed (caller must retry on the standard path)
 */
async function attemptNativeSendOrDegrade(
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

  // The degrade catch must only cover the actual send — an acknowledgement
  // failure after a successful delivery must NOT trigger a fallback resend
  // (that would duplicate the turn in the provider session). Ack errors
  // propagate to the caller's outer catch, matching the standard-dispatch
  // path's semantics where ack failures surface as agent errors.
  try {
    await bus.request(AgentSubjects.sendMessage, {
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
    void emitLocalityDegradeEvent(bus, {
      sessionId,
      intent: nativeContext.nativeFork ? 'fork' : 'resume',
      verdict: degradeVerdict,
      agentId,
      adapterId,
      turnId,
    });
    const freshContext = await buildNativeFallbackContext(bus, session, messageId);
    return {
      ...nativeContext,
      ...freshContext,
      nativeLocality: degradeVerdict,
      nativeFork: undefined,
    };
  }

  // Send succeeded — emit acknowledgement outside the degrade try/catch.
  await bus.emit(SessionSubjects.user_message.acknowledged, {
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
 * @param input - Routing payload and lifecycle dependencies for one agent
 */
async function routeToSingleAgent(input: RouteToSingleAgentInput): Promise<void> {
  const { bus, session, turn, message, messageId, deliveryMode, onTurnComplete, agent, responseSchema } = input;
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
      const fallback = await attemptNativeSendOrDegrade(bus, session, basePayload, agentContext);
      if (fallback === null) return;
      agentContext = fallback;
    }

    await sendAndAcknowledge(bus, {
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
      await bus.emit(SessionSubjects.user_message.completed, {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        messageId,
        agentId: agent.agentId,
        outcome: 'cancelled',
      });

      const stateChange = turn.markAgentCompleted(agent.agentId);
      if (stateChange.turnComplete) {
        await onTurnComplete(turn, stateChange.result);
      }
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const stateChange = turn.markAgentErrored(agent.agentId, errorMessage);
    await bus.emit(SessionSubjects.user_message.completed, {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      messageId,
      agentId: agent.agentId,
      outcome: 'error',
      error: errorMessage,
    });

    if (stateChange.turnComplete) {
      await onTurnComplete(turn, stateChange.result);
    }
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
  readonly onTurnComplete: (turn: Turn, result: { success: boolean; errors: string[] }) => Promise<void>;
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
 * @param bus - Bus for storage lookups and degrade event emission
 * @param session - Session being routed
 * @param context - Fork-enriched context carrying the nativeFork directive
 * @returns Context with nativeFork removed and history injected
 */
async function degradeNativeForkForSendMessage(
  bus: IMakaioBus,
  session: IMakaioSession,
  context: SessionContext,
): Promise<SessionContext> {
  const verdict = { kind: 'degrade' as const, reason: 'agent-already-started' as const };
  void emitLocalityDegradeEvent(bus, { sessionId: session.sessionId, intent: 'fork', verdict });
  const contextResult = await getFullConversation(bus, session.sessionId);
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
 * @param options - Routing options including bus, session, agents, message, and lifecycle dependencies
 */
export async function routeToAgents(options: RouteToAgentsOptions): Promise<void> {
  const {
    bus,
    session,
    agents,
    message,
    messageId,
    turn,
    deliveryMode,
    onTurnComplete,
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
  const forkContextCapabilities = await resolveForkContextCapabilities(bus, session, agents);
  let forkEnrichedContext = await assembleForkContext(
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
    forkEnrichedContext = await degradeNativeForkForSendMessage(bus, session, forkEnrichedContext);
  }

  const enrichedMessageHistory = turnContextEnricher
    ? await turnContextEnricher.enrichForDeliveryMode(forkEnrichedContext?.messageHistory, turn.turnId, deliveryMode)
    : forkEnrichedContext?.messageHistory;

  const enrichedSessionContext = forkEnrichedContext
    ? { ...forkEnrichedContext, messageHistory: enrichedMessageHistory }
    : undefined;

  // Read the CWD notification preference once before fanning out to agents.
  const cwdChangePref = swappedAgentIds?.size
    ? await readCwdChangeNotificationPref(bus)
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

    await routeToSingleAgent({
      bus,
      session,
      turn,
      message,
      messageId,
      deliveryMode,
      onTurnComplete,
      agent,
      agentContext,
      responseSchema,
    });
  });

  await Promise.all(routingPromises);
}
