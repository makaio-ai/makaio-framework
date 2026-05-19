import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { waitFor } from '@makaio/test-utils';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { registerMemorySessionStorage } from '../memory-handler.js';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession } from './shared.js';
import { describeSessionStorageBehavior } from './session-storage-behavior.js';

describe('registerMemorySessionStorage', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = registerMemorySessionStorage(MakaioBus);
  });

  afterEach(() => {
    cleanup();
  });

  // Shared behavioral tests (status filter, worktree, delete, getByAdapterSessionId)
  describeSessionStorageBehavior();

  describe('set and get', () => {
    it('should set and get session', async () => {
      const session = createSession({ sessionId: 'test-session-1' });

      const setResult = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });
      expect(setResult.success).toBe(true);

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(getResult.session).toEqual(session);
    });

    it('should return null for non-existent session', async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'non-existent-session',
      });

      expect(result.session).toBeNull();
    });

    it('should overwrite existing session on set', async () => {
      const sessionId = 'overwrite-test';
      const originalSession = createSession({
        sessionId,
        status: 'active',
        lastActivityAt: 1000,
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: originalSession,
      });

      const updatedSession = createSession({
        sessionId,
        status: 'closed',
        lastActivityAt: 2000,
      });

      const setResult = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: updatedSession,
      });
      expect(setResult.success).toBe(true);

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId,
      });
      expect(getResult.session).toEqual(updatedSession);
      expect(getResult.session?.status).toBe('closed');
      expect(getResult.session?.lastActivityAt).toBe(2000);
    });

    it('should not overwrite when ifAbsent is true', async () => {
      const sessionId = 'if-absent-test';
      const originalSession = createSession({
        sessionId,
        status: 'active',
        lastActivityAt: 1000,
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: originalSession,
      });

      const updatedSession = createSession({
        sessionId,
        status: 'closed',
        lastActivityAt: 2000,
        createdAt: originalSession.createdAt,
      });

      const setResult = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: updatedSession,
        ifAbsent: true,
      });
      expect(setResult.success).toBe(false);

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId,
      });
      expect(getResult.session).toEqual(originalSession);
    });
  });

  describe('list', () => {
    it('should list all sessions', async () => {
      const session1 = createSession({ sessionId: 'list-test-1', status: 'active' });
      const session2 = createSession({ sessionId: 'list-test-2', status: 'closed' });
      const session3 = createSession({ sessionId: 'list-test-3', status: 'active' });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session1.sessionId,
        session: session1,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session2.sessionId,
        session: session2,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session3.sessionId,
        session: session3,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.list, {});

      expect(result.sessions).toHaveLength(3);
      expect(result.sessions).toContainEqual(session1);
      expect(result.sessions).toContainEqual(session2);
      expect(result.sessions).toContainEqual(session3);
    });
  });

  describe('getByAdapterSessionId (memory-specific)', () => {
    it('should not match sessions with undefined adapterSessionId', async () => {
      const session = createSession({
        sessionId: 'no-adapter-session',
        adapterSessionId: undefined,
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'some-id',
      });

      expect(result.session).toBeNull();
    });
  });

  describe('update', () => {
    it('overwrites persisted client account linkage fields', async () => {
      const session = createSession({
        sessionId: 'client-account-linkage-update',
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: {
          clientId: 'claude-code',
          source: 'claude-agent-sdk',
          kind: 'account.observe',
          observedAt: 1_710_000_000_000,
          payload: {
            displayLabel: 'Chris',
          },
        },
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        clientId: 'codex',
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: {
          clientId: 'codex',
          source: 'codex-mcp',
          kind: 'account.observe',
          observedAt: 1_710_000_001_000,
          payload: {
            displayLabel: 'Chris (Codex)',
          },
        },
      });

      expect(updateResult.success).toBe(true);

      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });

      expect(result.session).toMatchObject({
        clientId: 'codex',
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: {
          clientId: 'codex',
          source: 'codex-mcp',
          kind: 'account.observe',
          observedAt: 1_710_000_001_000,
          payload: {
            displayLabel: 'Chris (Codex)',
          },
        },
      });
    });

    it('emits session.clientAccount.changed when storage updates the canonical account linkage', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-event',
        session: createSession({
          sessionId: 'memory-client-account-event',
          clientId: 'claude-code',
          clientAccountId: 'client-account-1',
          lastClientIdentityObservation: initialObservation,
        }),
      });

      const events: Array<Record<string, unknown>> = [];
      const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
        events.push(ctx.payload);
      });

      try {
        const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'memory-client-account-event',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        });

        expect(updateResult.success).toBe(true);
        await waitFor(() => {
          expect(events).toEqual([
            {
              sessionId: 'memory-client-account-event',
              clientId: 'claude-code',
              previousClientAccountId: 'client-account-1',
              clientAccountId: 'client-account-2',
              source: 'claude-agent-sdk',
              observedAt: 1_710_000_000_000,
              lastClientIdentityObservation: initialObservation,
            },
          ]);
        });
      } finally {
        cleanup();
      }
    });

    it('does not await session.clientAccount.changed listeners after a persisted update', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-non-blocking',
        session: createSession({
          sessionId: 'memory-client-account-non-blocking',
          clientId: 'claude-code',
          clientAccountId: 'client-account-1',
          lastClientIdentityObservation: initialObservation,
        }),
      });

      let releaseListener: (() => void) | undefined;
      let cleanup = (): void => undefined;
      const listenerStarted = new Promise<void>((resolve) => {
        cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseListener = release;
          });
        });
      });

      const requestPromise = MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: 'memory-client-account-non-blocking',
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: initialObservation,
      });

      try {
        await listenerStarted;
        await expect(
          Promise.race([
            requestPromise.then((result) => result.success),
            new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
          ]),
        ).resolves.toBe(true);
      } finally {
        releaseListener?.();
        cleanup();
        await requestPromise;
      }
    });

    it('logs listener failures without failing the persisted update', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-listener-error',
        session: createSession({
          sessionId: 'memory-client-account-listener-error',
          clientId: 'claude-code',
          clientAccountId: 'client-account-1',
          lastClientIdentityObservation: initialObservation,
        }),
      });

      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
      const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, () => {
        throw new Error('listener failed');
      });

      try {
        const result = await MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'memory-client-account-listener-error',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        });

        expect(result.success).toBe(true);
        await waitFor(() => {
          expect(consoleError).toHaveBeenCalledWith(
            '[SessionStorage] Failed to emit session.clientAccount.changed:',
            expect.any(Error),
          );
        });

        const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
          sessionId: 'memory-client-account-listener-error',
        });
        expect(retrieved.session?.clientAccountId).toBe('client-account-2');
      } finally {
        cleanup();
        consoleError.mockRestore();
      }
    });

    it('rejects canonical account transitions that have no persisted observation evidence', async () => {
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-missing-observation',
        session: createSession({
          sessionId: 'memory-client-account-missing-observation',
        }),
      });

      await expect(
        MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'memory-client-account-missing-observation',
          clientAccountId: 'client-account-2',
        }),
      ).rejects.toThrow(/cannot persist clientAccountId without lastClientIdentityObservation/i);
    });

    it('rejects linked sessions on set when clientId is omitted', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await expect(
        MakaioBus.request(SessionStorageSubjects.set, {
          sessionId: 'memory-client-account-set-missing-client-id',
          session: createSession({
            sessionId: 'memory-client-account-set-missing-client-id',
            clientAccountId: 'client-account-2',
            lastClientIdentityObservation: initialObservation,
          }),
        }),
      ).rejects.toThrow(/clientId is required when clientAccountId is provided/i);
    });

    it('rejects canonical account transitions when clientId disagrees with the persisted observation', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-mismatched-client-id',
        session: createSession({
          sessionId: 'memory-client-account-mismatched-client-id',
        }),
      });

      const events: Array<Record<string, unknown>> = [];
      const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
        events.push(ctx.payload);
      });

      try {
        await expect(
          MakaioBus.request(SessionStorageSubjects.update, {
            sessionId: 'memory-client-account-mismatched-client-id',
            clientId: 'codex',
            clientAccountId: 'client-account-2',
            lastClientIdentityObservation: initialObservation,
          }),
        ).rejects.toThrow(/lastClientIdentityObservation belongs to "claude-code"/i);
        expect(events).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('rejects stable linked sessions that try to change only clientId away from the persisted observation', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-stable-client-id-drift',
        session: createSession({
          sessionId: 'memory-client-account-stable-client-id-drift',
          clientId: 'claude-code',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        }),
      });

      await expect(
        MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'memory-client-account-stable-client-id-drift',
          clientId: 'codex',
        }),
      ).rejects.toThrow(/cannot persist clientId "codex".*belongs to "claude-code"/i);
    });

    it('rejects stable linked sessions that try to overwrite only the observation with a different clientId', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-stable-observation-drift',
        session: createSession({
          sessionId: 'memory-client-account-stable-observation-drift',
          clientId: 'claude-code',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        }),
      });

      await expect(
        MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'memory-client-account-stable-observation-drift',
          lastClientIdentityObservation: {
            ...initialObservation,
            clientId: 'codex',
          },
        }),
      ).rejects.toThrow(/cannot persist clientId "claude-code".*belongs to "codex"/i);
    });

    it('emits the observation clientId once the update provides the linked clientId', async () => {
      const initialObservation = {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1_710_000_000_000,
        payload: {
          displayLabel: 'Chris',
        },
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-client-account-event-observation-client',
        session: createSession({
          sessionId: 'memory-client-account-event-observation-client',
        }),
      });

      const events: Array<Record<string, unknown>> = [];
      const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
        events.push(ctx.payload);
      });

      try {
        const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'memory-client-account-event-observation-client',
          clientId: 'claude-code',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        });

        expect(updateResult.success).toBe(true);
        await waitFor(() => {
          expect(events).toEqual([
            {
              sessionId: 'memory-client-account-event-observation-client',
              clientId: 'claude-code',
              previousClientAccountId: null,
              clientAccountId: 'client-account-2',
              source: 'claude-agent-sdk',
              observedAt: 1_710_000_000_000,
              lastClientIdentityObservation: initialObservation,
            },
          ]);
        });
      } finally {
        cleanup();
      }
    });
  });
});
