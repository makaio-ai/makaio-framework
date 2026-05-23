import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession, useDrizzleTestLifecycle } from './shared.js';

describe('Drizzle session import storage handlers', () => {
  const ctx = useDrizzleTestLifecycle();

  it('inserts a discovered imported session with canonical adapter identity', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-insert',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: '/repo',
      logFilePath: '/logs/external-insert.jsonl',
      startedAt: 1_000,
      title: 'Imported session',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(result.created).toBe(true);

    const stored = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: result.sessionId,
    });
    expect(stored.session).toMatchObject({
      sessionId: result.sessionId,
      status: 'discovered',
      isImported: true,
      importStatus: 'discovered',
      adapterName: 'claude-code',
      adapterSessionId: 'external-insert',
      adapterId: 'adapter-1',
      source: 'claude-code',
      targetWorkingDirectory: '/repo',
      logFilePath: '/logs/external-insert.jsonl',
      title: 'Imported session',
      createdAt: 1_000,
      lastActivityAt: 1_000,
    });
    expect(stored.session?.discoveredAt).toEqual(expect.any(Number));
  });

  it('converges an existing adapter-session row into an imported session on conflict', async () => {
    const existing = createSession({
      sessionId: 'existing-adopted-session',
      status: 'active',
      adapterSessionId: 'external-adopt',
      isImported: false,
      adapterName: 'codex',
      source: 'codex',
      importStatus: undefined,
      discoveredAt: undefined,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: existing.sessionId,
      session: existing,
    });

    const result = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-adopt',
      source: 'codex',
      adapterId: 'adapter-2',
      cwd: '/adopted',
      logFilePath: '/logs/external-adopt.jsonl',
      startedAt: 2_000,
      title: 'Adopted import',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(result).toEqual({ sessionId: 'existing-adopted-session', created: false });

    const stored = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: existing.sessionId,
    });
    expect(stored.session).toMatchObject({
      sessionId: existing.sessionId,
      status: 'discovered',
      isImported: true,
      importStatus: 'discovered',
      adapterName: 'codex',
      adapterSessionId: 'external-adopt',
      adapterId: 'adapter-2',
      source: 'codex',
      targetWorkingDirectory: '/adopted',
      logFilePath: '/logs/external-adopt.jsonl',
      title: 'Adopted import',
      createdAt: 2_000,
      lastActivityAt: 2_000,
    });
    expect(stored.session?.discoveredAt).toEqual(expect.any(Number));
  });

  it('does not adopt an unsourced adapter-session row into a sourced import', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'existing-unsourced-session',
      session: createSession({
        sessionId: 'existing-unsourced-session',
        status: 'active',
        adapterSessionId: 'external-unsourced',
        adapterName: 'codex',
        source: undefined,
        isImported: false,
      }),
    });

    const result = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-unsourced',
      source: 'codex',
      adapterId: 'adapter-unsourced',
      cwd: '/sourced',
      logFilePath: '/logs/external-unsourced.jsonl',
      startedAt: 2_500,
      title: 'Sourced import',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(result.created).toBe(true);
    expect(result.sessionId).not.toBe('existing-unsourced-session');

    const unsourced = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'existing-unsourced-session',
    });
    const sourced = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: result.sessionId,
    });

    expect(unsourced.session).toMatchObject({
      sessionId: 'existing-unsourced-session',
      isImported: false,
      source: undefined,
    });
    expect(sourced.session).toMatchObject({
      sessionId: result.sessionId,
      isImported: true,
      source: 'codex',
      adapterSessionId: 'external-unsourced',
    });
  });

  it('keeps discoveredAt write-once while allowing later scans to fill missing metadata', async () => {
    const inserted = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-discovered-once',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: null,
      logFilePath: null,
      startedAt: undefined,
      title: null,
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });
    const first = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: inserted.sessionId,
    });

    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-discovered-once',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: '/later',
      logFilePath: '/logs/external-discovered-once.jsonl',
      startedAt: 3_000,
      title: 'Later title',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    const second = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: inserted.sessionId,
    });
    expect(second.session?.discoveredAt).toBe(first.session?.discoveredAt);
    expect(second.session).toMatchObject({
      targetWorkingDirectory: '/later',
      logFilePath: '/logs/external-discovered-once.jsonl',
      title: 'Later title',
      createdAt: 3_000,
      lastActivityAt: 3_000,
    });
  });

  it('looks up imported sessions by log file path', async () => {
    const inserted = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-log-path',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: '/repo',
      logFilePath: '/logs/external-log-path.jsonl',
      startedAt: 4_000,
      title: 'Log path session',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    const result = await MakaioBus.request(SessionStorageSubjects.getByLogFilePath, {
      logFilePath: '/logs/external-log-path.jsonl',
    });

    expect(result.session?.sessionId).toBe(inserted.sessionId);
    expect(result.session?.adapterName).toBe('claude-code');
  });

  it('lists and counts imported sessions with source filters', async () => {
    const first = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-list-1',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: '/repo',
      logFilePath: '/logs/external-list-1.jsonl',
      startedAt: 5_000,
      title: 'First',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });
    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-list-2',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: '/repo',
      logFilePath: '/logs/external-list-2.jsonl',
      startedAt: 6_000,
      title: 'Second',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });
    await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'external-list-other',
      source: 'codex',
      adapterId: 'adapter-2',
      cwd: '/repo',
      logFilePath: '/logs/external-list-other.jsonl',
      startedAt: 7_000,
      title: 'Other',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });
    await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
      sessionId: first.sessionId,
      importStatus: 'imported',
    });
    await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
      sessionId: first.sessionId,
      importStatus: 'tracking',
    });

    const listed = await MakaioBus.request(SessionStorageSubjects.listImported, {
      source: 'claude-code',
    });
    expect(listed.sessions.map((session) => session.adapterSessionId)).toEqual(['external-list-2', 'external-list-1']);

    const counts = await MakaioBus.request(SessionStorageSubjects.countBySource, {
      source: 'claude-code',
    });
    expect(counts).toEqual({ total: 2, imported: 0, tracking: 1, discovered: 1 });
  });

  it('keeps same external IDs separate across import sources', async () => {
    const claude = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'shared-external-id',
      source: 'claude-code',
      adapterId: 'adapter-1',
      cwd: '/claude',
      logFilePath: '/logs/shared-claude.jsonl',
      startedAt: 8_000,
      title: 'Claude shared ID',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });
    const codex = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: 'shared-external-id',
      source: 'codex',
      adapterId: 'adapter-2',
      cwd: '/codex',
      logFilePath: '/logs/shared-codex.jsonl',
      startedAt: 9_000,
      title: 'Codex shared ID',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(codex.sessionId).not.toBe(claude.sessionId);

    const claudeLookup = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'shared-external-id',
      source: 'claude-code',
    });
    const codexLookup = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'shared-external-id',
      source: 'codex',
    });
    expect(claudeLookup.session?.sessionId).toBe(claude.sessionId);
    expect(codexLookup.session?.sessionId).toBe(codex.sessionId);
  });

  it('updates NULL importStatus, promotes storage status, and emits completion', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'null-import-status',
      session: createSession({
        sessionId: 'null-import-status',
        status: 'discovered',
        isImported: true,
        adapterName: 'claude-code',
        adapterSessionId: 'external-null-status',
        source: 'claude-code',
      }),
    });

    const events: Array<Record<string, unknown>> = [];
    const cleanup = MakaioBus.on(SessionSubjects.import.completed, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      const result = await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
        sessionId: 'null-import-status',
        importStatus: 'imported',
      });

      expect(result.success).toBe(true);
      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'null-import-status',
      });
      expect(stored.session).toMatchObject({
        status: 'active',
        importStatus: 'imported',
      });
      await vi.waitFor(() => {
        expect(events).toEqual([
          {
            sessionId: 'null-import-status',
            adapterSessionId: 'external-null-status',
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
      sessionId: 'closed-tracking-import',
      session: createSession({
        sessionId: 'closed-tracking-import',
        status: 'closed',
        isImported: true,
        importStatus: 'tracking',
        adapterName: 'claude-code',
        adapterSessionId: 'external-closed-tracking',
        source: 'claude-code',
      }),
    });

    const result = await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
      sessionId: 'closed-tracking-import',
      importStatus: 'imported',
    });
    const stored = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'closed-tracking-import',
    });

    expect(result.success).toBe(true);
    expect(stored.session).toMatchObject({
      status: 'closed',
      importStatus: 'imported',
    });
  });

  it('does not re-emit completion when importStatus is already at the requested value', async () => {
    await ctx.db.run(sql`
      INSERT INTO sessions (
        session_id, created_at, last_activity_at, status, adapter_name,
        adapter_session_id, is_imported, source, import_status
      )
      VALUES (
        'already-imported', 1, 1, 'active', 'claude-code',
        'external-already-imported', 1, 'claude-code', 'imported'
      )
    `);

    const events: Array<Record<string, unknown>> = [];
    const cleanup = MakaioBus.on(SessionSubjects.import.completed, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      const result = await MakaioBus.request(SessionStorageSubjects.updateImportStatus, {
        sessionId: 'already-imported',
        importStatus: 'imported',
      });

      expect(result.success).toBe(false);
      expect(events).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
