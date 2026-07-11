// NOTE: do NOT change lint limits without explicit human approval
/* eslint max-lines: ["error", { "max": 445 }] */ // Bumped from 440 for IsChannel cast comment
/**
 * Shared test utilities for SessionOrchestrator tests.
 */
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession, MakaioSessionAgent, MessageInput, ResponseSchemaDescriptor } from '@makaio/contracts';
import {
  resetBusHandlers,
  waitForAsync,
  createTestAgent,
  emitAdapterInitialized,
  getStoredEvents,
} from '../__tests__/shared.js';

export { resetBusHandlers, waitForAsync, emitAdapterInitialized, getStoredEvents };
/** Alias for {@link createTestAgent} - kept for orchestrator test naming consistency. */
export const createMockAgent = createTestAgent;

// Re-export event collector utilities (defined in a separate module to keep this file within line limits)
export {
  type EventCollector,
  type UnsubscribeFunction,
  collectTurnStartedEvents,
  collectTurnCompletedEvents,
  collectUserMessageSentEvents,
  collectUserMessageAcknowledgedEvents,
  collectUserMessageCompletedEvents,
} from './orchestrator-event-collectors.js';
import type { UnsubscribeFunction } from './orchestrator-event-collectors.js';

/** Configuration for creating mock sessions. */
export interface MockSessionConfig {
  sessionId: string;
  status?: 'active' | 'closed';
  agents?: MakaioSessionAgent[];
  leadAgentId?: string;
  targetWorkingDirectory?: string;
}

/**
 * Create a mock session object for use in tests.
 * @param config - Session configuration
 * @returns Mock IMakaioSession
 */
export function createMockSession(config: MockSessionConfig): IMakaioSession {
  const now = Date.now();
  return {
    sessionId: config.sessionId,
    createdAt: now,
    lastActivityAt: now,
    status: config.status ?? 'active',
    agents: config.agents ?? [],
    leadAgentId: config.leadAgentId,
    targetWorkingDirectory: config.targetWorkingDirectory,
  };
}

/**
 * Register a bus handler for session.create that stores sessions in the provided map.
 * @param sessions - Map to store created sessions
 * @returns Unsubscribe function
 */
export function registerCreateSessionHandler(sessions: Map<string, IMakaioSession>): UnsubscribeFunction {
  return MakaioBus.on(SessionSubjects.create, (ctx) => {
    const sessionId = ctx.payload.sessionId ?? `session-${crypto.randomUUID().slice(0, 8)}`;
    sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));
    ctx.setResult({ sessionId });
  });
}

/**
 * Register a bus handler for session.agent.added that updates the sessions map.
 * @param sessions - Map of sessions to update when agents are added
 * @returns Unsubscribe function
 */
export function registerAgentAddedHandler(sessions: Map<string, IMakaioSession>): UnsubscribeFunction {
  return MakaioBus.on(SessionSubjects.agent.added, (ctx) => {
    const session = sessions.get(ctx.payload.sessionId);
    if (!session) return;

    const isFirstAgent = session.agents.length === 0;
    const role = ctx.payload.role ?? (isFirstAgent ? 'lead' : 'member');

    // Set adapterSessionId and adapterName from first agent (for dedup lookup)
    if (isFirstAgent) {
      session.adapterSessionId = ctx.payload.adapterSessionId;
      session.adapterName = ctx.payload.adapterName;
      session.adapterId = ctx.payload.adapterId;
    }

    const now = Date.now();
    session.agents.push({
      agentId: ctx.payload.agentId,
      adapterId: ctx.payload.adapterId,
      adapterName: ctx.payload.adapterName,
      sessionId: ctx.payload.sessionId,
      role,
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
    });

    if (role === 'lead') {
      session.leadAgentId = ctx.payload.agentId;
    }

    session.lastActivityAt = Date.now();
  });
}

/**
 * Register a bus handler for session.get that looks up sessions from the provided map.
 * @param sessions - Map of sessions to serve
 * @returns Unsubscribe function
 */
export function registerGetSessionHandler(sessions: Map<string, IMakaioSession>): UnsubscribeFunction {
  return MakaioBus.on(SessionSubjects.get, (ctx) => {
    ctx.setResult({ session: sessions.get(ctx.payload.sessionId) ?? null });
  });
}

/**
 * Register a getAgent handler that reports agents as alive if they exist in any session.
 * Prevents the liveness check from triggering recovery in tests with pre-populated sessions.
 * @param sessions - Map of sessions containing agents to report as alive
 * @returns Unsubscribe function
 */
export function registerGetAgentHandler(sessions: Map<string, IMakaioSession>): UnsubscribeFunction {
  return MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
    for (const session of sessions.values()) {
      const agent = session.agents.find((a) => a.agentId === ctx.payload.agentId);
      if (agent) {
        ctx.setResult({
          agent: { agentId: agent.agentId, sessionId: session.sessionId, adapterSessionId: '' },
        });
        return;
      }
    }
    ctx.setResult({ agent: null });
  });
}

/**
 * Register a mock handler for adapter.rehydrateAgent.
 * This simulates connector swap during agent recovery.
 * @returns Unsubscribe function
 */
export function registerRehydrateAgentHandler(): UnsubscribeFunction {
  return MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
    // Connector swap is successful - return empty response
    ctx.setResult({});
  });
}

/**
 * Register a mock handler for agent.cwd.change.
 * This simulates successful cwd change.
 * @param previousCwd - Previous cwd returned by handler
 * @returns Unsubscribe function
 */
export function registerCwdChangeHandler(previousCwd = '/previous/cwd'): UnsubscribeFunction {
  return MakaioBus.on(AgentSubjects.cwd.change, (ctx) => {
    ctx.setResult({ success: true, previousCwd });
  });
}

/**
 * Register a mock handler for agent.model.change.
 * Simulates successful model change (in-place, no swap).
 * @returns Unsubscribe function
 */
export function registerModelChangeHandler(): UnsubscribeFunction {
  return MakaioBus.on(AgentSubjects.model.change, (ctx) => {
    ctx.setResult({ success: true, swapped: false });
  });
}

/**
 * Register a bus handler for adapter.startAgent that generates agent IDs and emits agent.added.
 * @param onStart - Optional callback receiving the start payload for assertions
 * @returns Unsubscribe function
 */
export function registerStartAgentHandler(
  onStart?: (p: { adapterId: string; sessionId: string; initialMessage: MessageInput | undefined }) => void,
): UnsubscribeFunction {
  return MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
    const { adapterId, initialMessage } = ctx.payload;
    const sessionId = ctx.payload.sessionId ?? `session-${crypto.randomUUID().slice(0, 8)}`;
    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const messageId = initialMessage ? `msg-${crypto.randomUUID().slice(0, 8)}` : undefined;
    const adapterSessionId = `adapter-session-${sessionId}`;
    onStart?.({ adapterId, sessionId, initialMessage });
    ctx.setResult({
      success: true as const,
      agentId,
      adapterId,
      adapterSessionId,
      sessionId,
      ...(messageId && { messageId }),
    });

    // Emit agent.added event (mimics AIAdapter behavior)
    emitAgentAdded({ sessionId, agentId, adapterId, adapterSessionId });
  });
}

/**
 * Register a bus handler for adapter.startAgent that always returns failure.
 * @param errorMessage - Error message to return
 * @returns Unsubscribe function
 */
export function registerFailingStartAgentHandler(errorMessage: string): UnsubscribeFunction {
  return MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
    ctx.setResult({ success: false as const, message: errorMessage });
  });
}

/**
 * Register a bus handler for agent.sendMessage that invokes an optional callback.
 * @param onSend - Optional callback receiving the send payload for assertions
 * @returns Unsubscribe function
 */
export function registerSendMessageHandler(
  onSend?: (p: {
    agentId: string;
    adapterId: string;
    message: MessageInput;
    messageId: string;
    sessionContext?: unknown;
    responseSchema?: ResponseSchemaDescriptor;
  }) => void,
): UnsubscribeFunction {
  return MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
    const { agentId, adapterId, message, messageId, sessionContext, responseSchema } = ctx.payload;
    const resolvedMessageId = messageId ?? `msg-${crypto.randomUUID().slice(0, 8)}`;
    onSend?.({ agentId, adapterId, message, messageId: resolvedMessageId, sessionContext, responseSchema });
    ctx.setResult({ messageId: resolvedMessageId });
  });
}

/**
 * Register a bus handler for agent.sendMessage that throws for agents in the failing set.
 * @param failingAgentIds - Set of agent IDs that should trigger an error
 * @param errorMessage - Error message to throw for failing agents
 * @returns Unsubscribe function
 */
export function registerFailingSendMessageHandler(
  failingAgentIds: Set<string>,
  errorMessage: string,
): UnsubscribeFunction {
  return MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
    if (failingAgentIds.has(ctx.payload.agentId)) throw new Error(errorMessage);
    ctx.setResult({ messageId: ctx.payload.messageId ?? 'generated-id' });
  });
}

/**
 * Emit an agent.complete event to simulate a successful agent turn completion.
 * @param input - Exact agent, message, and turn correlation.
 * @returns Promise that resolves when the event has been emitted
 */
export async function emitAgentComplete(input: { agentId: string; messageId: string; turnId: string }): Promise<void> {
  await MakaioBus.emit(AgentSubjects.complete, {
    agentId: input.agentId,
    adapterId: `adapter-${input.agentId}`,
    adapterName: 'test-adapter',
    adapterSessionId: `adapter-session-${input.agentId}`,
    messageId: input.messageId,
    turnId: input.turnId,
  });
}

/**
 * Emit an agent.complete event with error outcome to simulate agent failure.
 * @param input - Exact agent, message, turn, and error correlation.
 * @returns Promise that resolves when the event has been emitted
 */
export async function emitAgentError(input: {
  agentId: string;
  messageId: string;
  turnId: string;
  error: string;
}): Promise<void> {
  await MakaioBus.emit(AgentSubjects.complete, {
    agentId: input.agentId,
    adapterId: `adapter-${input.agentId}`,
    adapterName: 'test-adapter',
    adapterSessionId: `adapter-session-${input.agentId}`,
    messageId: input.messageId,
    turnId: input.turnId,
    outcome: 'error',
    error: input.error,
  });
}

/**
 * Helper to emit agent.added event (mimics AIAdapter behavior)
 * @param payload - The payload for the agent.added event
 */
export function emitAgentAdded(payload: {
  sessionId: string;
  agentId: string;
  adapterId: string;
  adapterSessionId: string;
  role?: 'lead' | 'member';
}): void {
  setImmediate(() => {
    void MakaioBus.emit(SessionSubjects.agent.added, {
      sessionId: payload.sessionId,
      agentId: payload.agentId,
      adapterId: payload.adapterId,
      adapterName: payload.adapterId,
      adapterSessionId: payload.adapterSessionId,
      role: payload.role,
    });
  });
}

/**
 * Creates a mock startAgent handler that captures the payload and emits agentAdded event.
 * Used in resolution tests to verify what gets passed to startAgent.
 * @param sessionId - The session ID for the test
 * @param capture - Object to store the captured payload
 * @returns Unsubscribe function
 */
export function registerCapturingStartAgentHandler(
  sessionId: string,
  capture: { payload?: Record<string, unknown> },
): UnsubscribeFunction {
  const capturedAgents = new Map<
    string,
    { agentId: string; sessionId: string; adapterSessionId: string; adapterId: string }
  >();
  const startAgentUnsub = MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
    capture.payload = ctx.payload as Record<string, unknown>;
    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const messageId = ctx.payload.initialMessage ? `msg-${crypto.randomUUID().slice(0, 8)}` : undefined;
    const adapterSessionId = `adapter-session-${sessionId}`;

    // Track this agent as "alive"
    capturedAgents.set(agentId, {
      agentId,
      sessionId,
      adapterSessionId,
      adapterId: ctx.payload.adapterId,
    });

    ctx.setResult({
      success: true as const,
      agentId,
      adapterId: ctx.payload.adapterId,
      adapterSessionId,
      sessionId,
      ...(messageId && { messageId }),
    });
    emitAgentAdded({ sessionId, agentId, adapterId: ctx.payload.adapterId, adapterSessionId });
  });

  const getAgentUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
    const agent = capturedAgents.get(ctx.payload.agentId);
    ctx.setResult({
      agent: agent
        ? {
            agentId: agent.agentId,
            sessionId: agent.sessionId,
            adapterSessionId: agent.adapterSessionId,
          }
        : null,
    });
  });
  return () => {
    startAgentUnsub();
    getAgentUnsub();
  };
}
