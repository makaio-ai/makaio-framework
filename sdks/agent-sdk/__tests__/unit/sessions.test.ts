import { describe, expect, it } from 'vitest';
import { createMockBus, createTestBusInstance } from '@makaio/test-utils';
import { MessageStorageSubjects, SessionSubjects } from '@makaio/contracts';
import {
  registerCoreSessionServiceHandlers,
  registerMemoryMessageStorage,
  registerMemorySessionStorage,
} from '@makaio/services-core/session';
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
} from '../../src/shared/sessions.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal bus session record returned from session.list / session.get.
 * @param overrides - Field overrides to merge into the base fixture.
 */
const makeSessionRecord = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session-1',
  status: 'active',
  createdAt: 1_700_000_000_000,
  lastActivityAt: 1_700_001_000_000,
  agents: [],
  ...overrides,
});

/**
 * Minimal bus message record returned from storage:message.getBySession.
 * @param overrides - Field overrides to merge into the base fixture.
 */
const makeMessageRecord = (overrides: Record<string, unknown> = {}) => ({
  messageId: 'msg-1',
  turnId: 'turn-1',
  sessionId: 'session-1',
  role: 'user' as const,
  contentText: 'Hello',
  blocks: [],
  timestamp: 1_700_000_000_000,
  ...overrides,
});

/**
 * Create a real in-memory session runtime for SDK facade tests.
 * @returns Bus plus cleanup for all registered handlers.
 */
const createSessionRuntime = () => {
  const bus = createTestBusInstance();
  const cleanups = [
    ...registerCoreSessionServiceHandlers({ bus }).cleanups,
    registerMemorySessionStorage(bus),
    registerMemoryMessageStorage(bus),
  ];
  return {
    bus,
    cleanup: () => {
      for (const cleanup of cleanups.toReversed()) {
        cleanup();
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Real in-memory session runtime
// ---------------------------------------------------------------------------

describe('session SDK facade with real core handlers', () => {
  it('round-trips create, list, get, rename, and delete through real bus handlers', async () => {
    const runtime = createSessionRuntime();
    try {
      await runtime.bus.request(SessionSubjects.create, {
        sessionId: 'session-real-1',
        title: 'Original title',
      });

      expect(await getSessionInfo(runtime.bus, 'session-real-1')).toMatchObject({
        sessionId: 'session-real-1',
        title: 'Original title',
        status: 'active',
      });

      await renameSession(runtime.bus, 'session-real-1', 'Renamed title');

      const renamed = await getSessionInfo(runtime.bus, 'session-real-1');
      expect(renamed).toMatchObject({
        sessionId: 'session-real-1',
        title: 'Renamed title',
        status: 'active',
      });
      expect(renamed?.createdAt).toEqual(expect.any(String));
      expect(renamed?.lastActivityAt).toEqual(expect.any(String));

      await runtime.bus.request(SessionSubjects.create, {
        sessionId: 'session-real-2',
        title: 'Second session',
      });

      const listed = await listSessions(runtime.bus, { status: 'active', limit: 1 });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.sessionId).toBe('session-real-2');

      await deleteSession(runtime.bus, 'session-real-1');

      expect(await getSessionInfo(runtime.bus, 'session-real-1')).toBeUndefined();
    } finally {
      runtime.cleanup();
    }
  });

  it('reads stored messages through real message storage pagination semantics', async () => {
    const runtime = createSessionRuntime();
    try {
      await runtime.bus.request(SessionSubjects.create, { sessionId: 'session-real-messages' });
      await runtime.bus.request(MessageStorageSubjects.append, {
        emitEvent: false,
        message: makeMessageRecord({
          messageId: 'msg-real-2',
          sessionId: 'session-real-messages',
          contentText: 'Second',
          timestamp: 1_700_000_000_020,
        }),
      });
      await runtime.bus.request(MessageStorageSubjects.append, {
        emitEvent: false,
        message: makeMessageRecord({
          messageId: 'msg-real-1',
          sessionId: 'session-real-messages',
          contentText: 'First',
          timestamp: 1_700_000_000_010,
        }),
      });

      const messages = await getSessionMessages(runtime.bus, 'session-real-messages');

      expect(messages).toEqual([
        {
          messageId: 'msg-real-1',
          role: 'user',
          content: 'First',
          timestamp: new Date(1_700_000_000_010).toISOString(),
        },
        {
          messageId: 'msg-real-2',
          role: 'user',
          content: 'Second',
          timestamp: new Date(1_700_000_000_020).toISOString(),
        },
      ]);
    } finally {
      runtime.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  it('returns an empty array when the service returns no sessions', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessions: [], total: 0 });

    const result = await listSessions(bus);

    expect(result).toEqual([]);
  });

  it('maps bus session records to SDKSessionInfo shape', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      sessions: [makeSessionRecord({ title: 'My session', adapterName: 'anthropic-sdk' })],
      total: 1,
    });

    const result = await listSessions(bus);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      sessionId: 'session-1',
      title: 'My session',
      status: 'active',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      lastActivityAt: new Date(1_700_001_000_000).toISOString(),
      adapterName: 'anthropic-sdk',
    });
  });

  it('passes status filter to the bus', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessions: [], total: 0 });

    await listSessions(bus, { status: 'closed' });

    expect(request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'closed' }));
  });

  it('passes limit option to the bus', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessions: [], total: 0 });

    await listSessions(bus, { limit: 5 });

    expect(request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 5 }));
  });

  it('defaults to status all when no options provided', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessions: [], total: 0 });

    await listSessions(bus);

    expect(request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'all' }));
  });

  it('omits adapterName when not present on session', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      sessions: [makeSessionRecord()],
      total: 1,
    });

    const result = await listSessions(bus);

    expect(result[0]).not.toHaveProperty('adapterName');
  });
});

// ---------------------------------------------------------------------------
// getSessionInfo
// ---------------------------------------------------------------------------

describe('getSessionInfo', () => {
  it('returns SDKSessionInfo when the session is found', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ session: makeSessionRecord({ title: 'Found it' }) });

    const result = await getSessionInfo(bus, 'session-1');

    expect(result).toEqual({
      sessionId: 'session-1',
      title: 'Found it',
      status: 'active',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      lastActivityAt: new Date(1_700_001_000_000).toISOString(),
    });
  });

  it('returns undefined when the session is not found', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ session: null });

    const result = await getSessionInfo(bus, 'missing-session');

    expect(result).toBeUndefined();
  });

  it('passes the sessionId to the bus', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ session: null });

    await getSessionInfo(bus, 'session-abc');

    expect(request).toHaveBeenCalledWith(expect.anything(), { sessionId: 'session-abc' });
  });
});

// ---------------------------------------------------------------------------
// getSessionMessages
// ---------------------------------------------------------------------------

describe('getSessionMessages', () => {
  it('returns empty array when no messages exist', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ messages: [], nextCursor: null });

    const result = await getSessionMessages(bus, 'session-1');

    expect(result).toEqual([]);
  });

  it('maps bus message records to SDK SessionMessage shape', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      messages: [makeMessageRecord()],
      nextCursor: null,
    });

    const result = await getSessionMessages(bus, 'session-1');

    expect(result).toEqual([
      {
        messageId: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  it('paginates through multiple pages until cursor is null', async () => {
    const { bus, request } = createMockBus();
    const page1Cursor = { timestamp: 1_700_000_000_000, messageId: 'msg-1' };
    request
      .mockResolvedValueOnce({
        messages: [makeMessageRecord({ messageId: 'msg-1' })],
        nextCursor: page1Cursor,
      })
      .mockResolvedValueOnce({
        messages: [makeMessageRecord({ messageId: 'msg-2', contentText: 'World' })],
        nextCursor: null,
      });

    const result = await getSessionMessages(bus, 'session-1');

    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('msg-1');
    expect(result[1].messageId).toBe('msg-2');
    expect(result[1].content).toBe('World');
  });

  it('passes sessionId and ascending order on the first request', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ messages: [], nextCursor: null });

    await getSessionMessages(bus, 'session-abc');

    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'session-abc', order: 'asc' }),
    );
  });

  it('passes the cursor from page 1 as after on the second request', async () => {
    const { bus, request } = createMockBus();
    const cursor = { timestamp: 1_700_000_000_000, messageId: 'msg-1' };
    request
      .mockResolvedValueOnce({ messages: [makeMessageRecord()], nextCursor: cursor })
      .mockResolvedValueOnce({ messages: [], nextCursor: null });

    await getSessionMessages(bus, 'session-1');

    expect(request).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ after: cursor }));
  });
});

// ---------------------------------------------------------------------------
// forkSession
// ---------------------------------------------------------------------------

describe('forkSession', () => {
  it('returns the new session ID from the bus response', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessionId: 'forked-session-1' });

    const result = await forkSession(bus, 'session-1');

    expect(result).toEqual({ sessionId: 'forked-session-1' });
  });

  it('passes sourceSessionId to the bus', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessionId: 'forked-session-1' });

    await forkSession(bus, 'session-abc');

    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceSessionId: 'session-abc' }),
    );
  });

  it('passes fromMessageId when options.messageId is provided', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessionId: 'forked-session-1' });

    await forkSession(bus, 'session-1', { messageId: 'msg-42' });

    expect(request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromMessageId: 'msg-42' }));
  });

  it('omits fromMessageId when options is not provided', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ sessionId: 'forked-session-1' });

    await forkSession(bus, 'session-1');

    const callArg = request.mock.calls[0][1] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('fromMessageId');
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  it('calls close, archive, purge in sequence when all succeed', async () => {
    const { bus, request } = createMockBus();
    request
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, eventsDeleted: 5 });

    await deleteSession(bus, 'session-1');

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([subject, payload]) => [subject, payload])).toEqual([
      [SessionSubjects.close, { sessionId: 'session-1' }],
      [SessionSubjects.archive, { sessionId: 'session-1' }],
      [SessionSubjects.purge, { sessionId: 'session-1' }],
    ]);
  });

  it('surfaces close request failures without archiving or purging', async () => {
    const { bus, request } = createMockBus();
    request.mockRejectedValueOnce(new Error('transport unavailable'));

    await expect(deleteSession(bus, 'session-1')).rejects.toThrow('transport unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('surfaces archive request failures without purging', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteSession(bus, 'session-1')).rejects.toThrow('storage unavailable');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws when purge fails', async () => {
    const { bus, request } = createMockBus();
    request
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'Not archived' });

    await expect(deleteSession(bus, 'session-1')).rejects.toThrow('Not archived');
  });
});

// ---------------------------------------------------------------------------
// renameSession
// ---------------------------------------------------------------------------

describe('renameSession', () => {
  it('calls session.update with the provided title', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });

    await renameSession(bus, 'session-1', 'New Title');

    expect(request).toHaveBeenCalledWith(expect.anything(), { sessionId: 'session-1', title: 'New Title' });
  });

  it('resolves without error when update succeeds', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });

    await expect(renameSession(bus, 'session-1', 'A title')).resolves.toBeUndefined();
  });

  it('throws when the session service reports failure', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: false });

    await expect(renameSession(bus, 'session-1', 'A title')).rejects.toThrow("Failed to rename session 'session-1'");
  });
});
