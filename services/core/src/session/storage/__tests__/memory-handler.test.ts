import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('import storage subjects', () => {
    it('upserts and retrieves imported sessions by adapter identity and log file path', async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-external-1',
        source: 'claude-code',
        adapterId: 'memory-adapter-1',
        cwd: '/repo',
        logFilePath: '/logs/memory-external-1.jsonl',
        startedAt: 1_000,
        title: 'Memory import',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });

      expect(result.created).toBe(true);

      const byLogPath = await MakaioBus.request(SessionStorageSubjects.getByLogFilePath, {
        logFilePath: '/logs/memory-external-1.jsonl',
      });
      expect(byLogPath.session).toMatchObject({
        sessionId: result.sessionId,
        status: 'discovered',
        isImported: true,
        importStatus: 'discovered',
        adapterName: 'claude-code',
        adapterSessionId: 'memory-external-1',
        adapterId: 'memory-adapter-1',
        source: 'claude-code',
        targetWorkingDirectory: '/repo',
        logFilePath: '/logs/memory-external-1.jsonl',
        title: 'Memory import',
        createdAt: 1_000,
        lastActivityAt: 1_000,
      });
      expect(byLogPath.session?.discoveredAt).toEqual(expect.any(Number));
    });

    it('converges an existing adapter-session row on import conflict', async () => {
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-existing-adopted',
        session: createSession({
          sessionId: 'memory-existing-adopted',
          status: 'active',
          adapterSessionId: 'memory-external-adopt',
          adapterName: 'codex',
          source: 'codex',
          isImported: false,
        }),
      });

      const result = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-external-adopt',
        source: 'codex',
        adapterId: 'memory-adapter-2',
        cwd: '/adopted',
        logFilePath: '/logs/memory-external-adopt.jsonl',
        startedAt: 2_000,
        title: 'Adopted memory import',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });

      expect(result).toEqual({ sessionId: 'memory-existing-adopted', created: false });

      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'memory-existing-adopted',
      });
      expect(stored.session).toMatchObject({
        status: 'discovered',
        isImported: true,
        importStatus: 'discovered',
        adapterName: 'codex',
        source: 'codex',
        targetWorkingDirectory: '/adopted',
        logFilePath: '/logs/memory-external-adopt.jsonl',
        title: 'Adopted memory import',
        createdAt: 2_000,
        lastActivityAt: 2_000,
      });
    });

    it('does not adopt an unsourced adapter-session row into a sourced import', async () => {
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-existing-unsourced',
        session: createSession({
          sessionId: 'memory-existing-unsourced',
          status: 'active',
          adapterSessionId: 'memory-external-unsourced',
          adapterName: 'codex',
          source: undefined,
          isImported: false,
        }),
      });

      const result = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-external-unsourced',
        source: 'codex',
        adapterId: 'memory-adapter-unsourced',
        cwd: '/sourced',
        logFilePath: '/logs/memory-external-unsourced.jsonl',
        startedAt: 2_500,
        title: 'Sourced memory import',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });

      expect(result.created).toBe(true);
      expect(result.sessionId).not.toBe('memory-existing-unsourced');

      const unsourced = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'memory-existing-unsourced',
      });
      const sourced = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: result.sessionId,
      });

      expect(unsourced.session).toMatchObject({
        sessionId: 'memory-existing-unsourced',
        isImported: false,
        source: undefined,
      });
      expect(sourced.session).toMatchObject({
        sessionId: result.sessionId,
        isImported: true,
        source: 'codex',
        adapterSessionId: 'memory-external-unsourced',
      });
    });

    it('lists, counts, updates status, and emits completion for imported sessions', async () => {
      const first = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-external-list-1',
        source: 'claude-code',
        adapterId: 'memory-adapter-1',
        cwd: '/repo',
        logFilePath: '/logs/memory-external-list-1.jsonl',
        startedAt: 3_000,
        title: 'First memory import',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });
      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-external-list-2',
        source: 'claude-code',
        adapterId: 'memory-adapter-1',
        cwd: '/repo',
        logFilePath: '/logs/memory-external-list-2.jsonl',
        startedAt: 4_000,
        title: 'Second memory import',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });
      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-external-other',
        source: 'codex',
        adapterId: 'memory-adapter-2',
        cwd: '/repo',
        logFilePath: '/logs/memory-external-other.jsonl',
        startedAt: 5_000,
        title: 'Other memory import',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });

      const completed: Array<Record<string, unknown>> = [];
      const cleanup = MakaioBus.on(SessionSubjects.import.completed, (ctx) => {
        completed.push(ctx.payload);
      });

      try {
        const updateResult = await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
          sessionId: first.sessionId,
          importStatus: 'imported',
        });
        expect(updateResult.success).toBe(true);
        await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
          sessionId: first.sessionId,
          importStatus: 'tracking',
        });

        const listed = await MakaioBus.request(SessionStorageSubjects.listImported, {
          source: 'claude-code',
        });
        expect(listed.sessions.map((session) => session.adapterSessionId)).toEqual([
          'memory-external-list-2',
          'memory-external-list-1',
        ]);

        const counts = await MakaioBus.request(SessionStorageSubjects.countBySource, {
          source: 'claude-code',
        });
        expect(counts).toEqual({ total: 2, imported: 0, tracking: 1, discovered: 1 });

        await vi.waitFor(() => {
          expect(completed).toEqual([
            {
              sessionId: first.sessionId,
              adapterSessionId: 'memory-external-list-1',
              source: 'claude-code',
            },
          ]);
        });
      } finally {
        cleanup();
      }
    });

    it('preserves user lifecycle status when tracking settles back to imported', async () => {
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'memory-closed-tracking-import',
        session: createSession({
          sessionId: 'memory-closed-tracking-import',
          status: 'closed',
          isImported: true,
          importStatus: 'tracking',
          adapterName: 'claude-code',
          adapterSessionId: 'memory-external-closed-tracking',
          source: 'claude-code',
        }),
      });

      const result = await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
        sessionId: 'memory-closed-tracking-import',
        importStatus: 'imported',
      });
      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'memory-closed-tracking-import',
      });

      expect(result.success).toBe(true);
      expect(stored.session).toMatchObject({
        status: 'closed',
        importStatus: 'imported',
      });
    });

    it('keeps same external IDs separate across import sources', async () => {
      const claude = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-shared-external-id',
        source: 'claude-code',
        adapterId: 'memory-adapter-1',
        cwd: '/claude',
        logFilePath: '/logs/memory-shared-claude.jsonl',
        startedAt: 6_000,
        title: 'Claude memory shared ID',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });
      const codex = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        externalSessionId: 'memory-shared-external-id',
        source: 'codex',
        adapterId: 'memory-adapter-2',
        cwd: '/codex',
        logFilePath: '/logs/memory-shared-codex.jsonl',
        startedAt: 7_000,
        title: 'Codex memory shared ID',
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      });

      expect(codex.sessionId).not.toBe(claude.sessionId);

      const claudeLookup = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'memory-shared-external-id',
        source: 'claude-code',
      });
      const codexLookup = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'memory-shared-external-id',
        source: 'codex',
      });
      expect(claudeLookup.session?.sessionId).toBe(claude.sessionId);
      expect(codexLookup.session?.sessionId).toBe(codex.sessionId);
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
        await vi.waitFor(() => {
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

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
        await vi.waitFor(() => {
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
        await vi.waitFor(() => {
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
