/// <reference types="bun-types" />
/**
 * Session-management integration tests.
 *
 * These tests verify the complete session lifecycle as exposed by the SDK:
 * list, get, rename, and delete.  They communicate with the Makaio session
 * service over the embedded runtime bus and therefore require a live runtime
 * environment.
 *
 * Two layers of tests are provided:
 *
 * 1. **Bus-simulation tests** (always run): Use a mock bus to verify that each
 *    session-management function dispatches the correct bus request and maps
 *    the response to the expected SDK shape.  No runtime is required.
 *
 * 2. **Live-runtime tests** (env-gated behind MAKAIO_TEST_RUNTIME): Perform
 *    real bus requests against the embedded runtime and verify end-to-end
 *    round-trips.
 *
 * To run the env-gated tests locally:
 * ```
 * MAKAIO_TEST_RUNTIME=1 yarn test sdks/agent-sdk
 * ```
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { createMockBus } from '@makaio/test-utils';
import { deleteSession, getSessionInfo, listSessions, renameSession } from '../../src/shared/sessions.js';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const RUNTIME_ENABLED = Boolean(process.env['MAKAIO_TEST_RUNTIME']);

// ---------------------------------------------------------------------------
// Bus-simulation session-management tests (always run)
// ---------------------------------------------------------------------------

describe('session management — bus simulation (always runs)', () => {
  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------

  describe('listSessions()', () => {
    it('returns an empty array when the service reports no sessions', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({ sessions: [], total: 0 });

      const sessions = await listSessions(bus);

      expect(sessions).toEqual([]);
    });

    it('maps bus session records to SDKSessionInfo shape with ISO timestamps', async () => {
      const { bus, request } = createMockBus();
      const now = 1_700_000_000_000;

      request.mockResolvedValue({
        sessions: [
          {
            sessionId: 'sess-sim-1',
            title: 'Simulated session',
            status: 'active',
            createdAt: now,
            lastActivityAt: now + 60_000,
            agents: [],
            adapterName: 'anthropic-sdk',
          },
        ],
        total: 1,
      });

      const sessions = await listSessions(bus);

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual({
        sessionId: 'sess-sim-1',
        title: 'Simulated session',
        status: 'active',
        createdAt: new Date(now).toISOString(),
        lastActivityAt: new Date(now + 60_000).toISOString(),
        adapterName: 'anthropic-sdk',
      });
    });

    it('passes the status filter to the bus request', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({ sessions: [], total: 0 });

      await listSessions(bus, { status: 'closed' });

      expect(request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'closed' }));
    });
  });

  // -------------------------------------------------------------------------
  // getSessionInfo
  // -------------------------------------------------------------------------

  describe('getSessionInfo()', () => {
    it('returns SDKSessionInfo when the session exists', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({
        session: {
          sessionId: 'sess-sim-2',
          title: 'Detailed session',
          status: 'active',
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_001_000_000,
          agents: [],
        },
      });

      const info = await getSessionInfo(bus, 'sess-sim-2');

      expect(info).toBeDefined();
      expect(info!.sessionId).toBe('sess-sim-2');
      expect(info!.title).toBe('Detailed session');
      expect(info!.status).toBe('active');
    });

    it('returns undefined when the session does not exist', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({ session: null });

      const info = await getSessionInfo(bus, 'nonexistent');

      expect(info).toBeUndefined();
    });

    it('passes the sessionId to the bus request', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({ session: null });

      await getSessionInfo(bus, 'target-sess');

      expect(request).toHaveBeenCalledWith(expect.anything(), { sessionId: 'target-sess' });
    });
  });

  // -------------------------------------------------------------------------
  // renameSession
  // -------------------------------------------------------------------------

  describe('renameSession()', () => {
    it('resolves when the service confirms success', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({ success: true });

      await expect(renameSession(bus, 'sess-sim-3', 'New Name')).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'sess-sim-3', title: 'New Name' }),
      );
    });

    it('throws when the service reports failure', async () => {
      const { bus, request } = createMockBus();
      request.mockResolvedValue({ success: false });

      await expect(renameSession(bus, 'sess-sim-3', 'Bad Name')).rejects.toThrow('Failed to rename session');
    });
  });

  // -------------------------------------------------------------------------
  // deleteSession
  // -------------------------------------------------------------------------

  describe('deleteSession()', () => {
    it('calls close, archive, and purge in sequence', async () => {
      const { bus, request } = createMockBus();
      request
        .mockResolvedValueOnce({ success: true }) // close
        .mockResolvedValueOnce({ success: true }) // archive
        .mockResolvedValueOnce({ success: true, eventsDeleted: 3 }); // purge

      await deleteSession(bus, 'sess-sim-4');

      expect(request).toHaveBeenCalledTimes(3);
    });

    it('surfaces close failures instead of purging after an unknown lifecycle failure', async () => {
      const { bus, request } = createMockBus();
      request
        .mockRejectedValueOnce(new Error('already closed')) // close
        .mockResolvedValueOnce({ success: true }) // archive
        .mockResolvedValueOnce({ success: true, eventsDeleted: 0 }); // purge

      await expect(deleteSession(bus, 'sess-sim-4')).rejects.toThrow('already closed');
      expect(request).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Live-runtime session-management tests (require MAKAIO_TEST_RUNTIME)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME_ENABLED)('session management — live runtime (requires MAKAIO_TEST_RUNTIME)', () => {
  /** Session IDs created during the test run — cleaned up in afterEach. */
  const createdSessionIds: string[] = [];

  afterEach(async () => {
    const { shutdown, deleteSession: del } = await import('../../src/runtime/index.js');

    // Best-effort cleanup of sessions created during tests.
    for (const id of createdSessionIds) {
      await del(id).catch(() => {
        // Ignore cleanup errors — session may already be gone.
      });
    }
    createdSessionIds.length = 0;

    await shutdown();
  });

  it('listSessions() returns at least one session after a query', async () => {
    const { startup, query, listSessions: listLive } = await import('../../src/runtime/index.js');

    await startup();

    const sessionId = crypto.randomUUID();
    const gen = await query({ prompt: 'Hello', options: { model: 'sonnet', sessionId, persistSession: true } });
    createdSessionIds.push(sessionId);

    // Drain the generator so the session is committed.
    for await (const _ of gen) {
      // no-op — just drain
    }

    const sessions = await listLive();

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it('getSessionInfo() returns the session created by a prior query', async () => {
    const { startup, query, getSessionInfo: getInfo } = await import('../../src/runtime/index.js');

    await startup();
    const sessionId = crypto.randomUUID();

    const gen = await query({ prompt: 'Hello', options: { model: 'sonnet', sessionId, persistSession: true } });
    createdSessionIds.push(sessionId);
    for await (const _ of gen) {
      // drain
    }

    const info = await getInfo(sessionId);

    expect(info).toBeDefined();
    expect(info!.sessionId).toBe(sessionId);
    expect(typeof info!.createdAt).toBe('string');
  });

  it('renameSession() updates the session title', async () => {
    const {
      startup,
      query,
      getSessionInfo: getInfo,
      renameSession: rename,
    } = await import('../../src/runtime/index.js');

    await startup();
    const sessionId = crypto.randomUUID();

    const gen = await query({ prompt: 'Hello', options: { model: 'sonnet', sessionId, persistSession: true } });
    createdSessionIds.push(sessionId);
    for await (const _ of gen) {
      // drain
    }

    await rename(sessionId, 'Integration Test Session');

    const info = await getInfo(sessionId);
    expect(info!.title).toBe('Integration Test Session');
  });

  it('deleteSession() removes the session from the list', async () => {
    const { startup, query, listSessions: listLive, deleteSession: del } = await import('../../src/runtime/index.js');

    await startup();
    const sessionId = crypto.randomUUID();

    const gen = await query({ prompt: 'Hello', options: { model: 'sonnet', sessionId, persistSession: true } });
    for await (const _ of gen) {
      // drain
    }

    await del(sessionId);

    const sessions = await listLive({ status: 'all' });
    const stillPresent = sessions.some((s) => s.sessionId === sessionId);
    expect(stillPresent).toBe(false);

    // Do not add to createdSessionIds — it has already been deleted.
  });
});
