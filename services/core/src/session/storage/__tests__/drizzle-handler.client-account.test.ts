import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession, useDrizzleTestLifecycle } from './shared.js';

describe('registerDrizzleSessionStorage - client account state', () => {
  const ctx = useDrizzleTestLifecycle();

  const initialObservation = {
    clientId: 'claude-code',
    source: 'claude-agent-sdk',
    kind: 'account.observe',
    observedAt: 1710000000000,
    payload: {
      displayLabel: 'Chris',
      plan: 'pro',
    },
  };

  it('round-trips client account state and the identity observation blob', async () => {
    const session = createSession({
      sessionId: 'client-account-roundtrip',
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: initialObservation,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const rows = await getRawSqlExecutor(ctx.db).all<{
      client_id: unknown;
      client_account_id: unknown;
      last_client_identity_observation: unknown;
    }>(sql`
      SELECT client_id, client_account_id, last_client_identity_observation
      FROM sessions
      WHERE session_id = 'client-account-roundtrip'
    `);

    expect(rows[0]?.client_id).toBe('claude-code');
    expect(rows[0]?.client_account_id).toBe('client-account-1');
    expect(JSON.parse(String(rows[0]?.last_client_identity_observation))).toEqual(initialObservation);

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session?.clientId).toBe('claude-code');
    expect(retrieved.session?.clientAccountId).toBe('client-account-1');
    expect(retrieved.session?.lastClientIdentityObservation).toEqual(initialObservation);
  });

  it('drops malformed persisted identity observations when hydrating a session', async () => {
    await ctx.exec(sql`
      INSERT INTO sessions (
        session_id,
        created_at,
        last_activity_at,
        status,
        last_client_identity_observation
      )
      VALUES (
        'client-account-invalid-observation',
        1710000000000,
        1710000000000,
        'active',
        '{"clientId":"claude-code","source":"claude-agent-sdk","kind":"account.observe","observedAt":1710000000000,"payload":"invalid"}'
      )
    `);

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'client-account-invalid-observation',
    });

    expect(retrieved.session?.lastClientIdentityObservation).toBeUndefined();
  });

  it('partially updates only clientAccountId', async () => {
    const session = createSession({
      sessionId: 'client-account-partial-update',
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: initialObservation,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: session.sessionId,
      clientAccountId: 'client-account-2',
      lastClientIdentityObservation: initialObservation,
    });

    expect(updateResult.success).toBe(true);

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session?.clientId).toBe('claude-code');
    expect(retrieved.session?.clientAccountId).toBe('client-account-2');
    expect(retrieved.session?.lastClientIdentityObservation).toEqual(initialObservation);
  });

  it('overwrites lastClientIdentityObservation on update', async () => {
    const session = createSession({
      sessionId: 'client-account-observation-overwrite',
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: initialObservation,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const nextObservation = {
      clientId: 'claude-code',
      source: 'claude-agent-sdk',
      kind: 'account.observe',
      observedAt: 1710000001000,
      payload: {
        displayLabel: 'Christopher',
        team: 'makaio',
      },
    };

    const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: session.sessionId,
      lastClientIdentityObservation: nextObservation,
    });

    expect(updateResult.success).toBe(true);

    const rows = await getRawSqlExecutor(ctx.db).all<{ last_client_identity_observation: unknown }>(sql`
      SELECT last_client_identity_observation
      FROM sessions
      WHERE session_id = 'client-account-observation-overwrite'
    `);

    expect(JSON.parse(String(rows[0]?.last_client_identity_observation))).toEqual(nextObservation);

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session?.lastClientIdentityObservation).toEqual(nextObservation);
  });

  it('emits session.clientAccount.changed when storage updates the canonical account linkage', async () => {
    const session = createSession({
      sessionId: 'client-account-event-update',
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: initialObservation,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const events: Array<Record<string, unknown>> = [];
    const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: initialObservation,
      });

      expect(updateResult.success).toBe(true);
      await vi.waitFor(() => {
        expect(events).toEqual([
          {
            sessionId: session.sessionId,
            clientId: 'claude-code',
            previousClientAccountId: 'client-account-1',
            clientAccountId: 'client-account-2',
            source: 'claude-agent-sdk',
            observedAt: 1710000000000,
            lastClientIdentityObservation: initialObservation,
          },
        ]);
      });
    } finally {
      cleanup();
    }
  });

  it('updates unrelated fields on linked sessions without reporting a client-account change', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-non-linkage-update',
      session: createSession({
        sessionId: 'client-account-non-linkage-update',
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: initialObservation,
        title: 'Before',
      }),
    });

    const result = await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: 'client-account-non-linkage-update',
      title: 'After',
    });

    expect(result).toEqual({
      success: true,
      clientAccountChanged: false,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'client-account-non-linkage-update',
    });

    expect(retrieved.session).toMatchObject({
      sessionId: 'client-account-non-linkage-update',
      title: 'After',
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: initialObservation,
    });
  });

  it('does not assert or emit when ifAbsent skips an existing row', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-if-absent-existing',
      session: createSession({
        sessionId: 'client-account-if-absent-existing',
      }),
    });

    const events: Array<Record<string, unknown>> = [];
    const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      const result = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'client-account-if-absent-existing',
        ifAbsent: true,
        session: createSession({
          sessionId: 'client-account-if-absent-existing',
          clientId: 'claude-code',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        }),
      });

      expect(result.success).toBe(false);

      const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'client-account-if-absent-existing',
      });

      expect(retrieved.session).toMatchObject({
        sessionId: 'client-account-if-absent-existing',
        clientId: undefined,
        clientAccountId: undefined,
        lastClientIdentityObservation: undefined,
      });
      expect(events).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('does not await session.clientAccount.changed listeners after a persisted update', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-event-non-blocking-drizzle',
      session: createSession({
        sessionId: 'client-account-event-non-blocking-drizzle',
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
      sessionId: 'client-account-event-non-blocking-drizzle',
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-event-error-drizzle',
      session: createSession({
        sessionId: 'client-account-event-error-drizzle',
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: initialObservation,
      }),
    });

    const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, () => {
      throw new Error('listener failed');
    });

    try {
      const result = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: 'client-account-event-error-drizzle',
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
        sessionId: 'client-account-event-error-drizzle',
      });
      expect(retrieved.session?.clientAccountId).toBe('client-account-2');
    } finally {
      cleanup();
      consoleError.mockRestore();
    }
  });

  it('rejects canonical account transitions that have no persisted observation evidence', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-missing-observation',
      session: createSession({
        sessionId: 'client-account-missing-observation',
      }),
    });

    await expect(
      MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: 'client-account-missing-observation',
        clientAccountId: 'client-account-2',
      }),
    ).rejects.toThrow(/cannot persist clientAccountId without lastClientIdentityObservation/i);
  });

  it('rejects linked sessions on set when clientId is omitted', async () => {
    await expect(
      MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'client-account-set-missing-client-id',
        session: createSession({
          sessionId: 'client-account-set-missing-client-id',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: initialObservation,
        }),
      }),
    ).rejects.toThrow(/clientId is required when clientAccountId is provided/i);
  });

  it('rejects canonical account transitions when clientId disagrees with the persisted observation', async () => {
    const mismatchObservation = {
      clientId: 'claude-code',
      source: 'claude-agent-sdk',
      kind: 'account.observe',
      observedAt: 1710000000000,
      payload: {
        displayLabel: 'Chris',
      },
    };

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-mismatched-client-id',
      session: createSession({
        sessionId: 'client-account-mismatched-client-id',
      }),
    });

    const events: Array<Record<string, unknown>> = [];
    const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      await expect(
        MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'client-account-mismatched-client-id',
          clientId: 'codex',
          clientAccountId: 'client-account-2',
          lastClientIdentityObservation: mismatchObservation,
        }),
      ).rejects.toThrow(/lastClientIdentityObservation belongs to "claude-code"/i);
      expect(events).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('rejects stable linked sessions that try to change only clientId away from the persisted observation', async () => {
    const stableClientIdObservation = {
      clientId: 'claude-code',
      source: 'claude-agent-sdk',
      kind: 'account.observe',
      observedAt: 1710000000000,
      payload: {
        displayLabel: 'Chris',
      },
    };

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-stable-client-id-drift',
      session: createSession({
        sessionId: 'client-account-stable-client-id-drift',
        clientId: 'claude-code',
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: stableClientIdObservation,
      }),
    });

    await expect(
      MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: 'client-account-stable-client-id-drift',
        clientId: 'codex',
      }),
    ).rejects.toThrow(/cannot persist clientId "codex".*belongs to "claude-code"/i);
  });

  it('rejects stable linked sessions that try to overwrite only the observation with a different clientId', async () => {
    const stableObservationDriftBaseline = {
      clientId: 'claude-code',
      source: 'claude-agent-sdk',
      kind: 'account.observe',
      observedAt: 1710000000000,
      payload: {
        displayLabel: 'Chris',
      },
    };

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-stable-observation-drift',
      session: createSession({
        sessionId: 'client-account-stable-observation-drift',
        clientId: 'claude-code',
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: stableObservationDriftBaseline,
      }),
    });

    await expect(
      MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: 'client-account-stable-observation-drift',
        lastClientIdentityObservation: {
          ...stableObservationDriftBaseline,
          clientId: 'codex',
        },
      }),
    ).rejects.toThrow(/cannot persist clientId "claude-code".*belongs to "codex"/i);
  });

  it('emits the observation clientId once the update provides the linked clientId', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'client-account-event-observation-client',
      session: createSession({
        sessionId: 'client-account-event-observation-client',
      }),
    });

    const events: Array<Record<string, unknown>> = [];
    const cleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: 'client-account-event-observation-client',
        clientId: 'claude-code',
        clientAccountId: 'client-account-2',
        lastClientIdentityObservation: initialObservation,
      });

      expect(updateResult.success).toBe(true);
      await vi.waitFor(() => {
        expect(events).toEqual([
          {
            sessionId: 'client-account-event-observation-client',
            clientId: 'claude-code',
            previousClientAccountId: null,
            clientAccountId: 'client-account-2',
            source: 'claude-agent-sdk',
            observedAt: 1710000000000,
            lastClientIdentityObservation: initialObservation,
          },
        ]);
      });
    } finally {
      cleanup();
    }
  });
});
