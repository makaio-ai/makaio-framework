/**
 * Routes messages to target agents.
 *
 * Extracted from SessionOrchestrator for file size management.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { PreferencesSubjects } from '../../preferences/storage-namespace.js';
import type { IMakaioSession, Message, MessageInput, MakaioSessionAgent, SessionContext } from '@makaio/contracts';
import { HookAbortError } from '@makaio/hooks';
import type { Turn } from '../entities/turn.js';
import { assembleForkContext } from '../context/assemble-fork-context.js';

/**
 * User-configurable CWD change notification preference.
 *
 * Stored under category `'chat-display'` with context key `'cwdChangeNotification'`.
 */
export interface CwdChangeNotificationPreference {
  /** Whether to inject a CWD change message into agent context at all. */
  enabled: boolean;
  /**
   * Message template. Supports `{oldCwd}` and `{newCwd}` placeholders
   * which are replaced with the actual directory paths at routing time.
   */
  template: string;
}

/** Preference category shared with other chat display settings. */
const CWD_CHANGE_PREF_CATEGORY = 'chat-display';

/** Preference context key within the category. */
const CWD_CHANGE_PREF_KEY = 'cwdChangeNotification';

/** Default notification config when no preference is stored. */
export const DEFAULT_CWD_CHANGE_NOTIFICATION: CwdChangeNotificationPreference = {
  enabled: true,
  template: 'User changed working directory from {oldCwd} to {newCwd}',
};

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
  responseSchema?: Record<string, unknown>;
}

/**
 * Interpolate `{oldCwd}` and `{newCwd}` placeholders in a CWD change message template.
 * @param template - Template string with optional placeholders
 * @param oldCwd - Previous working directory path
 * @param newCwd - New working directory path
 * @returns Interpolated message string
 */
function applyCwdChangeTemplate(template: string, oldCwd: string, newCwd: string): string {
  return template.replace(/\{oldCwd\}/g, oldCwd).replace(/\{newCwd\}/g, newCwd);
}

/**
 * Runtime guard for CWD notification preferences loaded from untyped storage.
 * @param value - Unknown stored preference value
 * @returns True when the value matches CwdChangeNotificationPreference
 */
function isCwdChangeNotificationPreference(value: unknown): value is CwdChangeNotificationPreference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.enabled === 'boolean' && typeof record.template === 'string';
}

/**
 * Read the CWD change notification preference via bus, falling back to the default.
 * @param bus - Bus instance for preferences lookup
 * @returns Resolved preference (never throws; falls back to default on error)
 */
async function readCwdChangeNotificationPref(bus: IMakaioBus): Promise<CwdChangeNotificationPreference> {
  try {
    const result = await bus.request(PreferencesSubjects.get, {
      key: { scope: 'global', surface: 'ui', context: CWD_CHANGE_PREF_KEY },
      category: CWD_CHANGE_PREF_CATEGORY,
    });
    if (result.value !== null && result.value !== undefined) {
      if (isCwdChangeNotificationPreference(result.value)) {
        return result.value;
      }
      // Stored value is malformed for this key; use safe default.
      return DEFAULT_CWD_CHANGE_NOTIFICATION;
    }
  } catch {
    // PreferencesService unavailable — fall back to default
  }
  return DEFAULT_CWD_CHANGE_NOTIFICATION;
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
 * Route one message to one agent and handle lifecycle side effects.
 * @param input - Routing payload and lifecycle dependencies for one agent
 */
async function routeToSingleAgent(input: RouteToSingleAgentInput): Promise<void> {
  const { bus, session, turn, message, messageId, deliveryMode, onTurnComplete, agent, agentContext, responseSchema } =
    input;

  try {
    await bus.request(AgentSubjects.sendMessage, {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      message,
      deliveryMode,
      messageId,
      turnId: turn.turnId,
      sessionId: session.sessionId,
      sessionContext: agentContext,
      ...(responseSchema !== undefined && { responseSchema }),
    });

    await bus.emit(SessionSubjects.user_message.acknowledged, {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      messageId,
      agentId: agent.agentId,
    });
  } catch (error) {
    if (error instanceof HookAbortError) {
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
 * Route a message to target agents via agent.sendMessage.
 *
 * Fans out to all agents in parallel. On routing failure, marks agent as errored
 * and checks for turn completion.
 *
 * For fork sessions on their first turn, assembles projected context from parent chain.
 * @param bus - Bus instance for communication
 * @param session - Session metadata (for fork detection)
 * @param agents - Target agents to route to
 * @param message - Message content to send
 * @param messageId - Message identifier
 * @param turn - Turn tracking object
 * @param deliveryMode - How to deliver the message
 * @param onTurnComplete - Callback when turn completes (all agents done)
 * @param sessionContext - Session context with curated messageHistory and decision signals
 * @param turnContextEnricher - Optional enricher for immediate message context
 * @param isNewTurn - Whether this is the first message in a new turn
 * @param recoveryContext - Context enriched with messageHistory for agents that were just recovered
 * @param recoveredAgentIds - Set of agent IDs that were recovered in this handler invocation
 * @param swappedAgentIds - Set of agent IDs that swapped connector due to cwd mismatch
 * @param swappedAgentCwd - Previous/new cwd metadata keyed by agent ID
 * @param freshMessageHistory - Curated history for agents forced into fresh mode
 * @param responseSchema - Optional JSON schema for structured responses
 */
export async function routeToAgents(
  bus: IMakaioBus,
  session: IMakaioSession,
  agents: MakaioSessionAgent[],
  message: MessageInput,
  messageId: string,
  turn: Turn,
  deliveryMode: 'enqueue' | 'immediate' | undefined,
  onTurnComplete: (turn: Turn, result: { success: boolean; errors: string[] }) => Promise<void>,
  sessionContext?: SessionContext,
  turnContextEnricher?: ITurnContextEnricher,
  isNewTurn?: boolean,
  recoveryContext?: SessionContext,
  recoveredAgentIds?: ReadonlySet<string>,
  swappedAgentIds?: ReadonlySet<string>,
  swappedAgentCwd?: ReadonlyMap<string, CwdSwapMeta>,
  freshMessageHistory?: Message[],
  responseSchema?: Record<string, unknown>,
): Promise<void> {
  const forkEnrichedContext = await assembleForkContext(bus, session, session.sessionId, sessionContext, isNewTurn);

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
