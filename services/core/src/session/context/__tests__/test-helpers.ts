/**
 * Shared test helpers for context-related tests.
 * Provides mock handlers and factories for session, message, and event testing.
 */
import { MakaioBus } from '@makaio/bus-core';
import type { SessionMessage, MakaioSessionEvent, IMakaioSession } from '@makaio/contracts';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { SessionEventStorageSubjects } from '../../session-events/namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { TurnStorageSubjects } from '../../../turn/namespace.js';
import { actionRegistry } from '../../session-editor/action-registry.js';
import { registerBuiltInActions, resetBuiltInActionsRegistration } from '../../session-editor/actions/index.js';

/**
 * Creates a cleanup tracker for managing bus handler registrations.
 * Call `cleanup.add(fn)` to track cleanup functions, and `cleanup.runAll()` in afterEach.
 */
export function createCleanupTracker() {
  const cleanups: (() => void)[] = [];
  return {
    add: (fn: () => void) => cleanups.push(fn),
    runAll: () => cleanups.forEach((fn) => fn()),
  };
}

/**
 * Standard beforeEach setup for context tests.
 * Resets bus handlers and action registry.
 */
export function setupContextTest() {
  MakaioBus.__resetHandlers?.();
  actionRegistry.reset();
  resetBuiltInActionsRegistration();
  registerBuiltInActions();
}

// ============================================================================
// Mock Handlers
// ============================================================================

/**
 * Mocks the session storage get handler for a specific session.
 * @param cleanup - Cleanup tracker to register the handler removal
 * @param session - Partial session with required sessionId
 */
export function mockGetSession(
  cleanup: { add: (fn: () => void) => void },
  session: Partial<IMakaioSession> & { sessionId: string },
) {
  const handler = MakaioBus.on(
    SessionStorageSubjects.get,
    (ctx) => {
      const fullSession: IMakaioSession = {
        ...session,
        sessionId: session.sessionId,
        createdAt: session.createdAt ?? Date.now(),
        lastActivityAt: session.lastActivityAt ?? Date.now(),
        status: session.status ?? 'active',
        agents: session.agents ?? [],
      };
      ctx.setResult({ session: fullSession });
    },
    { filter: { sessionId: session.sessionId } },
  );
  cleanup.add(handler);
}

/**
 * Mocks the session events get handler for a specific session.
 * @param cleanup - Cleanup tracker to register the handler removal
 * @param sessionId - Session ID to filter on
 * @param events - Events to return
 */
export function mockGetEvents(
  cleanup: { add: (fn: () => void) => void },
  sessionId: string,
  events: MakaioSessionEvent[],
) {
  const handler = MakaioBus.on(
    SessionEventStorageSubjects.getEvents,
    (ctx) => {
      ctx.setResult({ events, nextCursor: null });
    },
    { filter: { sessionId } },
  );
  cleanup.add(handler);
}

/**
 * Mocks the message storage get handler for a specific message.
 * @param cleanup - Cleanup tracker to register the handler removal
 * @param messageId - Message ID to filter on
 * @param message - Message to return
 */
export function mockGetMessage(cleanup: { add: (fn: () => void) => void }, messageId: string, message: SessionMessage) {
  const handler = MakaioBus.on(
    MessageStorageSubjects.get,
    (ctx) => {
      ctx.setResult({ message });
    },
    { filter: { messageId } },
  );
  cleanup.add(handler);
}

/**
 * Mocks the turns getBySession handler for a specific session.
 * @param cleanup - Cleanup tracker to register the handler removal
 * @param sessionId - Session ID to filter on
 * @param turns - Turns to return
 */
export function mockGetTurnsBySession(
  cleanup: { add: (fn: () => void) => void },
  sessionId: string,
  turns: Array<{
    turnId: string;
    sessionId: string;
    turnNumber: number;
    startedAt: number;
    status: 'active' | 'completed' | 'error';
  }>,
) {
  const handler = MakaioBus.on(
    TurnStorageSubjects.getBySession,
    (ctx) => {
      ctx.setResult({ turns });
    },
    { filter: { sessionId } },
  );
  cleanup.add(handler);
}

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates a SessionMessage for testing.
 * @param id - Message ID
 * @param role - Message role
 * @param content - Text content
 * @param options - Optional overrides for sessionId, timestamp, and adapterMessageId
 */
export function createMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  options: { sessionId?: string; timestamp?: number; adapterMessageId?: string } = {},
): SessionMessage {
  return {
    messageId: id,
    sessionId: options.sessionId ?? 'session-1',
    turnId: 'turn-1',
    role,
    contentText: content,
    blocks: [{ type: 'text', content }],
    timestamp: options.timestamp ?? Date.now(),
    ...(options.adapterMessageId !== undefined && { adapterMessageId: options.adapterMessageId }),
  };
}

/**
 * Creates a MakaioSessionEvent of type 'message' for testing.
 * @param messageId - Message ID referenced by the event
 * @param timestamp - Event timestamp
 * @param options - Optional overrides for sessionId and role
 */
export function messageEvent(
  messageId: string,
  timestamp: number,
  options: { sessionId?: string; role?: 'user' | 'assistant' } = {},
): MakaioSessionEvent {
  const sessionId = options.sessionId ?? 'session-1';
  const role = options.role ?? 'user';
  return {
    sessionId,
    eventId: `event-${messageId}`,
    timestamp,
    type: 'message' as const,
    payload: { messageId, turnId: 'turn-1', role },
  } as MakaioSessionEvent;
}

/**
 * Creates a turn.started event for testing.
 * @param turnId - Turn ID
 * @param timestamp - Event timestamp
 * @param options - Optional overrides
 */
export function turnStartedEvent(
  turnId: string,
  timestamp: number,
  options: { sessionId?: string; messageId?: string; agentIds?: string[]; turnNumber?: number } = {},
): MakaioSessionEvent {
  const sessionId = options.sessionId ?? 'session-1';
  return {
    sessionId,
    eventId: `event-turn-${turnId}`,
    timestamp,
    type: 'turn.started' as const,
    payload: {
      sessionId,
      turnId,
      turnNumber: options.turnNumber ?? 1,
      messageId: options.messageId ?? 'msg-1',
      agentIds: options.agentIds ?? ['agent-1'],
    },
  } as MakaioSessionEvent;
}

/**
 * Creates a turn.completed event for testing.
 * @param turnId - Turn ID
 * @param timestamp - Event timestamp
 * @param options - Optional overrides
 */
export function turnCompletedEvent(
  turnId: string,
  timestamp: number,
  options: { sessionId?: string; success?: boolean; turnNumber?: number } = {},
): MakaioSessionEvent {
  const sessionId = options.sessionId ?? 'session-1';
  return {
    sessionId,
    eventId: `event-turn-complete-${turnId}`,
    timestamp,
    type: 'turn.completed' as const,
    payload: { sessionId, turnId, turnNumber: options.turnNumber ?? 1, success: options.success ?? true },
  } as MakaioSessionEvent;
}

/**
 * Creates a squash event for testing.
 * @param eventId - Event ID
 * @param summaryJson - JSON string for the squash summary
 * @param timestamp - Event timestamp
 * @param options - Optional overrides
 */
export function squashEvent(
  eventId: string,
  summaryJson: string,
  timestamp: number,
  options: { sessionId?: string } = {},
): MakaioSessionEvent {
  return {
    sessionId: options.sessionId ?? 'session-1',
    eventId,
    timestamp,
    type: 'squash' as const,
    payload: { summaryJson },
  } as MakaioSessionEvent;
}
