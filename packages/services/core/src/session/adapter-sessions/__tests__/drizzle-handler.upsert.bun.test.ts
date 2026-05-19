import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { useAdapterSessionTestLifecycle, createTestSession } from './shared.js';

describe('registerDrizzleAdapterSessionStorage', () => {
  const ctx = useAdapterSessionTestLifecycle({ beforeEach, afterEach });

  describe('upsert', () => {
    it('should insert new adapter session', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-1',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      expect(result.adapterSessionId).toBe('cc-session-1');
      expect(result.sessionId).toBeNull();
      expect(result.created).toBe(true);

      // Verify in DB
      type AdapterSessionRow = {
        adapter_name: string;
        status: string;
        kind: string;
        parent_adapter_session_id: string | null;
        fork_point_message_id: string | null;
        model: string | null;
        cwd: string | null;
        started_at: number;
        discovered_at: number;
      };
      const rows = await ctx.db.all<AdapterSessionRow>(
        sql`SELECT * FROM adapter_sessions WHERE adapter_session_id = 'cc-session-1'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.adapter_name).toBe('claude-code');
      expect(rows[0]!.status).toBe('discovered');
      expect(rows[0]!.kind).toBe('root');
    });

    it('should insert with optional fields', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-2',
        adapterName: 'claude-code',
        parentAdapterSessionId: 'cc-parent-1',
        forkPointMessageId: 'msg-fork-1',
        kind: 'fork',
        model: 'claude-3-opus',
        cwd: '/home/user/project',
      });

      expect(result.created).toBe(true);

      type AdapterSessionRow = {
        parent_adapter_session_id: string | null;
        fork_point_message_id: string | null;
        kind: string;
        model: string | null;
        cwd: string | null;
      };
      const rows = await ctx.db.all<AdapterSessionRow>(
        sql`SELECT * FROM adapter_sessions WHERE adapter_session_id = 'cc-session-2'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.parent_adapter_session_id).toBe('cc-parent-1');
      expect(rows[0]!.fork_point_message_id).toBe('msg-fork-1');
      expect(rows[0]!.kind).toBe('fork');
      expect(rows[0]!.model).toBe('claude-3-opus');
      expect(rows[0]!.cwd).toBe('/home/user/project');
    });

    it('should update existing adapter session on upsert', async () => {
      // First insert
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-3',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: 'claude-3-sonnet',
        cwd: null,
      });

      // Upsert with updated values
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-3',
        adapterName: 'claude-code',
        parentAdapterSessionId: 'cc-parent-new',
        forkPointMessageId: 'msg-fork-new',
        kind: 'fork',
        model: 'claude-3-opus',
        cwd: '/new/path',
      });

      expect(result.created).toBe(false);

      type AdapterSessionRow = {
        parent_adapter_session_id: string | null;
        fork_point_message_id: string | null;
        kind: string;
        model: string | null;
        cwd: string | null;
      };
      const rows = await ctx.db.all<AdapterSessionRow>(
        sql`SELECT * FROM adapter_sessions WHERE adapter_session_id = 'cc-session-3'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.parent_adapter_session_id).toBe('cc-parent-new');
      expect(rows[0]!.fork_point_message_id).toBe('msg-fork-new');
      expect(rows[0]!.kind).toBe('fork');
      expect(rows[0]!.model).toBe('claude-3-opus');
      expect(rows[0]!.cwd).toBe('/new/path');
    });

    it('should preserve existing model/cwd if not provided in update', async () => {
      // First insert with model and cwd
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-4',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: 'claude-3-sonnet',
        cwd: '/original/path',
      });

      // Upsert without model/cwd
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-4',
        adapterName: 'claude-code',
        parentAdapterSessionId: 'cc-parent',
        forkPointMessageId: null,
        kind: 'subagent',
        model: null,
        cwd: null,
      });

      type AdapterSessionRow = { model: string | null; cwd: string | null };
      const rows = await ctx.db.all<AdapterSessionRow>(
        sql`SELECT * FROM adapter_sessions WHERE adapter_session_id = 'cc-session-4'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe('claude-3-sonnet');
      expect(rows[0]!.cwd).toBe('/original/path');
    });

    it('should return existing sessionId if linked', async () => {
      // Create a Makaio session for FK
      await createTestSession(ctx.db, 'makaio-session-1');

      // Insert adapter session
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-5',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      // Manually link to Makaio session
      await ctx.db.run(
        sql`UPDATE adapter_sessions SET session_id = 'makaio-session-1' WHERE adapter_session_id = 'cc-session-5'`,
      );

      // Upsert again - should return the linked sessionId
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-session-5',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      expect(result.sessionId).toBe('makaio-session-1');
      expect(result.created).toBe(false);
    });

    it('should store an explicit startedAt value on insert', async () => {
      const startedAt = Date.now() - 90_000;

      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-started-insert',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        startedAt,
      });

      type StartedAtRow = { started_at: number };
      const rows = await ctx.db.all<StartedAtRow>(
        sql`SELECT started_at FROM adapter_sessions WHERE adapter_session_id = 'cc-started-insert'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.started_at).toBe(startedAt);
    });

    it('should not overwrite startedAt on re-upsert (write-once semantics)', async () => {
      const startedAtT1 = Date.now() - 60_000;
      const startedAtT2 = Date.now();

      // Insert with an explicit startedAt timestamp
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-started-once',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        startedAt: startedAtT1,
      });

      // Re-upsert with a different startedAt — should be ignored on conflict
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-started-once',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        startedAt: startedAtT2,
      });

      type StartedAtRow = { started_at: number };
      const rows = await ctx.db.all<StartedAtRow>(
        sql`SELECT started_at FROM adapter_sessions WHERE adapter_session_id = 'cc-started-once'`,
      );
      expect(rows).toHaveLength(1);
      // startedAt must still be the originally inserted value
      expect(rows[0]!.started_at).toBe(startedAtT1);
    });

    it('should backfill startedAt when the existing value is the auto-discovery placeholder', async () => {
      const canonicalStartedAt = Date.now() - 60_000;

      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-started-backfill',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      type TimestampRow = { discovered_at: number; started_at: number };
      const beforeRows = await ctx.db.all<TimestampRow>(
        sql`SELECT discovered_at, started_at FROM adapter_sessions WHERE adapter_session_id = 'cc-started-backfill'`,
      );
      expect(beforeRows).toHaveLength(1);
      expect(beforeRows[0]!.started_at).toBe(beforeRows[0]!.discovered_at);

      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-started-backfill',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        startedAt: canonicalStartedAt,
      });

      type StartedAtRow = { started_at: number };
      const afterRows = await ctx.db.all<StartedAtRow>(
        sql`SELECT started_at FROM adapter_sessions WHERE adapter_session_id = 'cc-started-backfill'`,
      );
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0]!.started_at).toBe(canonicalStartedAt);
    });

    it('should default startedAt to approximately Date.now() when not provided', async () => {
      const before = Date.now();

      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-started-default',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        // startedAt intentionally omitted — handler must default to ~Date.now()
      });

      const after = Date.now();

      type StartedAtRow = { started_at: number };
      const rows = await ctx.db.all<StartedAtRow>(
        sql`SELECT started_at FROM adapter_sessions WHERE adapter_session_id = 'cc-started-default'`,
      );
      expect(rows).toHaveLength(1);
      const storedStartedAt = rows[0]!.started_at;
      // Allow 5000ms tolerance to account for test environment variance
      expect(storedStartedAt).toBeGreaterThanOrEqual(before - 5000);
      expect(storedStartedAt).toBeLessThanOrEqual(after + 5000);
    });
  });
});
