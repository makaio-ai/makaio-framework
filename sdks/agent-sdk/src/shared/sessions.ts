import type { IMakaioBus } from '@makaio/bus-core';
import { MessageStorageSubjects, SessionSubjects, type MessagePageCursor } from '@makaio/contracts';
import type {
  ForkSessionOptions,
  ForkSessionResult,
  ListSessionsOptions,
  SDKSessionInfo,
  SessionMessage,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal mapping helpers — arrow expressions, not exported
// ---------------------------------------------------------------------------

/**
 * Map a raw bus session record to the SDK session info shape.
 * @param session - Raw session record from the bus response.
 * @returns SDK-compatible session info.
 */
const toSDKSessionInfo = (session: {
  sessionId: string;
  title?: string;
  status: string;
  createdAt: number;
  lastActivityAt: number;
  adapterName?: string;
}): SDKSessionInfo => ({
  sessionId: session.sessionId,
  ...(session.title !== undefined ? { title: session.title } : {}),
  status: session.status,
  createdAt: new Date(session.createdAt).toISOString(),
  lastActivityAt: new Date(session.lastActivityAt).toISOString(),
  ...(session.adapterName !== undefined ? { adapterName: session.adapterName } : {}),
});

/**
 * Map a raw bus message record to the SDK session message shape.
 * @param message - Raw message record from the bus response.
 * @returns SDK-compatible session message.
 */
const toSessionMessage = (message: {
  messageId: string;
  role: 'user' | 'assistant';
  contentText: string;
  timestamp: number;
}): SessionMessage => ({
  messageId: message.messageId,
  role: message.role,
  content: message.contentText,
  timestamp: new Date(message.timestamp).toISOString(),
});

// ---------------------------------------------------------------------------
// Public session management functions
// ---------------------------------------------------------------------------

/**
 * List sessions from the framework session service.
 * @param bus - The bus instance to communicate with the session service.
 * @param options - Optional filters for status and pagination limit.
 * @returns Array of SDK session info objects.
 */
export async function listSessions(bus: IMakaioBus, options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
  const { sessions } = await bus.request(SessionSubjects.list, {
    status: options?.status ?? 'all',
    limit: options?.limit,
  });
  return sessions.map(toSDKSessionInfo);
}

/**
 * Get info for a single session by ID. Returns undefined when not found.
 * @param bus - The bus instance to communicate with the session service.
 * @param sessionId - The session ID to retrieve.
 * @returns SDK session info, or undefined if the session does not exist.
 */
export async function getSessionInfo(bus: IMakaioBus, sessionId: string): Promise<SDKSessionInfo | undefined> {
  const { session } = await bus.request(SessionSubjects.get, { sessionId });
  return session !== null ? toSDKSessionInfo(session) : undefined;
}

/**
 * Retrieve all stored messages for a session.
 *
 * Fetches pages until no next cursor is returned, accumulating all messages
 * in ascending timestamp order.
 * @param bus - The bus instance to communicate with the message storage service.
 * @param sessionId - The session whose messages should be retrieved.
 * @returns Ordered array of SDK session messages.
 */
export async function getSessionMessages(bus: IMakaioBus, sessionId: string): Promise<SessionMessage[]> {
  const accumulated: SessionMessage[] = [];
  let cursor: MessagePageCursor | undefined;

  do {
    // Spread cursor conditionally to avoid passing `after: undefined` on the first request.
    const response = await bus.request(MessageStorageSubjects.getBySession, {
      sessionId,
      order: 'asc' as const,
      ...(cursor !== undefined ? { after: cursor } : {}),
    });
    for (const msg of response.messages) {
      accumulated.push(toSessionMessage(msg));
    }
    cursor = response.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return accumulated;
}

/**
 * Fork a session from an optional branch point.
 * @param bus - The bus instance to communicate with the session service.
 * @param sessionId - Source session to fork from.
 * @param options - Optional fork options including message branch point.
 * @returns The new session ID created by the fork.
 */
export async function forkSession(
  bus: IMakaioBus,
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const { sessionId: newSessionId } = await bus.request(SessionSubjects.fork, {
    sourceSessionId: sessionId,
    ...(options?.messageId !== undefined ? { fromMessageId: options.messageId } : {}),
  });
  return { sessionId: newSessionId };
}

/**
 * Delete a session permanently: close → archive → purge.
 *
 * Close and archive are idempotent at the session service layer. Unexpected
 * request failures from those steps are surfaced so callers can distinguish
 * lifecycle refusal from transport or storage failure. Purge is the terminal
 * step and throws on failure.
 * @param bus - The bus instance to communicate with the session service.
 * @param sessionId - The session ID to permanently delete.
 */
export async function deleteSession(bus: IMakaioBus, sessionId: string): Promise<void> {
  await bus.request(SessionSubjects.close, { sessionId });
  await bus.request(SessionSubjects.archive, { sessionId });

  const purgeResult = await bus.request(SessionSubjects.purge, { sessionId });
  if (!purgeResult.success) {
    throw new Error(`Failed to purge session '${sessionId}': ${purgeResult.error ?? 'unknown error'}`);
  }
}

/**
 * Rename a session by updating its title.
 * @param bus - The bus instance to communicate with the session service.
 * @param sessionId - The session ID to rename.
 * @param title - New display title for the session.
 */
export async function renameSession(bus: IMakaioBus, sessionId: string, title: string): Promise<void> {
  const { success } = await bus.request(SessionSubjects.update, { sessionId, title });
  if (!success) {
    throw new Error(`Failed to rename session '${sessionId}'`);
  }
}
