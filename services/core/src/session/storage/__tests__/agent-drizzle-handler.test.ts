/* eslint max-lines: ["error", { "max": 500 }] */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor, type MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { registerDrizzleAgentStorage } from '../agent-drizzle-handler.js';
import { AgentStorageSubjects } from '../agent-namespace.js';

/**
 * SQL statement to create the sessions table for testing.
 * Intentionally minimal — only the columns needed to satisfy the agents FK.
 * Agents FK references sessions, so we need this table.
 */
const CREATE_SESSIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    spawning_tool_call_id TEXT
  )
`;

/**
 * SQL statement to create the agents table for testing.
 * Mirrors the agent-storage shape used by the Drizzle handler.
 */
const CREATE_AGENTS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY NOT NULL,
    adapter_id TEXT NOT NULL,
    adapter_name TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    adapter_session_id TEXT,
    model TEXT,
    cwd TEXT,
    provider_config_id TEXT,
    persona_id TEXT,
    profile_id TEXT,
    harness_id TEXT,
    client_id TEXT,
    compression_mode TEXT,
    role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
    status TEXT NOT NULL CHECK (status IN ('idle', 'active', 'dead', 'disposed')),
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  )
`;

/**
 * Index for agent lookups by parent session.
 */
const CREATE_AGENTS_INDEX_SQL = sql`
  CREATE INDEX IF NOT EXISTS agents_session_id_idx ON agents(session_id)
`;

/**
 * Creates a test agent with sensible defaults.
 * @param overrides - Properties to override
 * @returns A MakaioSessionAgent for testing
 */
function createTestAgent(overrides: Partial<MakaioSessionAgent> = {}): MakaioSessionAgent {
  const now = Date.now();
  return {
    agentId: `agent-${crypto.randomUUID()}`,
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    sessionId: 'session-1',
    role: 'lead',
    status: 'idle',
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

/**
 * Creates a temp file SQLite database for testing agent storage.
 * @returns Test database context with cleanup that removes temp file
 */
async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath, exec } = await createTempDb('agent-storage');

  // Create tables through the dialect-portable raw SQL executor
  await exec(CREATE_SESSIONS_TABLE_SQL);
  await exec(CREATE_AGENTS_TABLE_SQL);
  await exec(CREATE_AGENTS_INDEX_SQL);

  // Register handlers
  const handlerCleanup = registerDrizzleAgentStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));

  // Combined cleanup: unsubscribe handlers, close connection, delete temp file
  const cleanup = createDbCleanup(() => handlerCleanup(), close, dbPath);

  return { db, close, dbPath, exec, cleanup };
}

describe('registerDrizzleAgentStorage', () => {
  let cleanup: () => void;
  let db: MakaioDatabase;
  let exec: TestDbContextWithCleanup['exec'];

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    exec = ctx.exec;
    cleanup = ctx.cleanup;

    // Insert a parent session row since agents FK requires it
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES ('session-1', ${Date.now()}, ${Date.now()}, 'active')
    `);
  });

  afterEach(() => cleanup());

  describe('get', () => {
    it('returns null for non-existent agent', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'non-existent',
      });

      expect(result.agent).toBeNull();
    });

    it('returns agent with all fields mapped correctly', async () => {
      const agent = createTestAgent({
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        sessionId: 'session-1',
        role: 'lead',
        status: 'active',
        model: 'claude-4',
        cwd: '/home/user/project',
        adapterSessionId: 'external-session-123',
        createdAt: 1000,
        lastActivityAt: 2000,
      });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const result = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'agent-1',
      });

      expect(result.agent).toEqual(agent);
    });

    it('maps nullable fields (model, cwd, adapterSessionId) to undefined', async () => {
      const agent = createTestAgent({
        agentId: 'agent-minimal',
        model: undefined,
        cwd: undefined,
        adapterSessionId: undefined,
      });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const result = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'agent-minimal',
      });

      expect(result.agent).not.toBeNull();
      expect(result.agent?.model).toBeUndefined();
      expect(result.agent?.cwd).toBeUndefined();
      expect(result.agent?.adapterSessionId).toBeUndefined();
    });
  });

  describe('set', () => {
    it('inserts a new agent', async () => {
      const agent = createTestAgent({ agentId: 'insert-test' });

      const result = await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      expect(result.success).toBe(true);

      // Verify in DB
      const rows = await getRawSqlExecutor(db).all<{ agent_id: unknown }>(
        sql`SELECT * FROM agents WHERE agent_id = 'insert-test'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent_id).toBe('insert-test');
    });

    it('updates an existing agent (upsert)', async () => {
      const agent = createTestAgent({
        agentId: 'upsert-test',
        status: 'idle',
        model: 'model-v1',
        createdAt: 1000,
        lastActivityAt: 1000,
      });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const updatedAgent = createTestAgent({
        agentId: 'upsert-test',
        status: 'active',
        model: 'model-v2',
        createdAt: 1000,
        lastActivityAt: 2000,
      });

      const result = await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: updatedAgent.agentId,
        agent: updatedAgent,
      });

      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'upsert-test',
      });

      expect(retrieved.agent?.status).toBe('active');
      expect(retrieved.agent?.model).toBe('model-v2');
      expect(retrieved.agent?.lastActivityAt).toBe(2000);
    });

    it('preserves createdAt on update, changes lastActivityAt', async () => {
      const agent = createTestAgent({
        agentId: 'preserve-test',
        createdAt: 1000,
        lastActivityAt: 1000,
      });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const updatedAgent = { ...agent, createdAt: 1000, lastActivityAt: 2000 };

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: updatedAgent.agentId,
        agent: updatedAgent,
      });

      const retrieved = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'preserve-test',
      });

      expect(retrieved.agent?.createdAt).toBe(1000);
      expect(retrieved.agent?.lastActivityAt).toBe(2000);
    });
  });

  describe('delete', () => {
    it('returns true when agent deleted', async () => {
      const agent = createTestAgent({ agentId: 'delete-test' });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const result = await MakaioBus.request(AgentStorageSubjects.delete, {
        agentId: 'delete-test',
      });

      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'delete-test',
      });

      expect(retrieved.agent).toBeNull();
    });

    it('returns false when agent not found', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.delete, {
        agentId: 'non-existent',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('listByAdapter', () => {
    beforeEach(async () => {
      // Insert agents with different adapters and statuses
      const agents = [
        createTestAgent({
          agentId: 'agent-1',
          adapterName: 'claude-code',
          status: 'idle',
        }),
        createTestAgent({
          agentId: 'agent-2',
          adapterName: 'claude-code',
          status: 'active',
        }),
        createTestAgent({
          agentId: 'agent-3',
          adapterName: 'claude-code',
          status: 'dead',
        }),
        createTestAgent({
          agentId: 'agent-4',
          adapterName: 'other-adapter',
          status: 'idle',
        }),
      ];

      for (const agent of agents) {
        await MakaioBus.request(AgentStorageSubjects.set, {
          agentId: agent.agentId,
          agent,
        });
      }
    });

    it('returns agents matching adapter name', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.listByAdapter, {
        adapterName: 'claude-code',
      });

      expect(result.agents).toHaveLength(3);
      expect(result.agents.every((a) => a.adapterName === 'claude-code')).toBe(true);
    });

    it('filters by status when provided', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.listByAdapter, {
        adapterName: 'claude-code',
        status: 'idle',
      });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].agentId).toBe('agent-1');
      expect(result.agents[0].status).toBe('idle');
    });

    it('returns all statuses when status is all', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.listByAdapter, {
        adapterName: 'claude-code',
        status: 'all',
      });

      expect(result.agents).toHaveLength(3);
      const statuses = result.agents.map((a) => a.status).sort();
      expect(statuses).toEqual(['active', 'dead', 'idle']);
    });

    it('returns all statuses when status is undefined', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.listByAdapter, {
        adapterName: 'claude-code',
      });

      expect(result.agents).toHaveLength(3);
    });

    it('returns empty array when no matches', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.listByAdapter, {
        adapterName: 'non-existent-adapter',
      });

      expect(result.agents).toHaveLength(0);
      expect(result.agents).toEqual([]);
    });
  });

  describe('listBySession', () => {
    it('returns agents in the session', async () => {
      // Insert second session for isolation testing
      await exec(sql`
        INSERT INTO sessions (session_id, created_at, last_activity_at, status)
        VALUES ('session-2', ${Date.now()}, ${Date.now()}, 'active')
      `);

      const agent1 = createTestAgent({ agentId: 'agent-1', sessionId: 'session-1' });
      const agent2 = createTestAgent({ agentId: 'agent-2', sessionId: 'session-1' });
      const agent3 = createTestAgent({ agentId: 'agent-3', sessionId: 'session-2' });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent1.agentId,
        agent: agent1,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent2.agentId,
        agent: agent2,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent3.agentId,
        agent: agent3,
      });

      const result = await MakaioBus.request(AgentStorageSubjects.listBySession, {
        sessionId: 'session-1',
      });

      expect(result.agents).toHaveLength(2);
      expect(result.agents.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-2']);
      expect(result.agents.every((a) => a.sessionId === 'session-1')).toBe(true);
    });

    it('returns empty array for unknown session', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.listBySession, {
        sessionId: 'non-existent-session',
      });

      expect(result.agents).toHaveLength(0);
      expect(result.agents).toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('updates status and lastActivityAt', async () => {
      const agent = createTestAgent({
        agentId: 'status-test',
        status: 'idle',
        lastActivityAt: 1000,
      });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const beforeUpdate = Date.now();
      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId: 'status-test',
        status: 'active',
      });

      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'status-test',
      });

      expect(retrieved.agent?.status).toBe('active');
      expect(retrieved.agent?.lastActivityAt).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('returns false for non-existent agent', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId: 'non-existent',
        status: 'dead',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('updateActivity', () => {
    it('updates lastActivityAt only', async () => {
      const agent = createTestAgent({
        agentId: 'activity-test',
        status: 'idle',
        lastActivityAt: 1000,
      });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const result = await MakaioBus.request(AgentStorageSubjects.updateActivity, {
        agentId: 'activity-test',
        lastActivityAt: 3000,
      });

      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(AgentStorageSubjects.get, {
        agentId: 'activity-test',
      });

      expect(retrieved.agent?.lastActivityAt).toBe(3000);
      expect(retrieved.agent?.status).toBe('idle'); // Should not change
    });

    it('returns false for non-existent agent', async () => {
      const result = await MakaioBus.request(AgentStorageSubjects.updateActivity, {
        agentId: 'non-existent',
        lastActivityAt: 5000,
      });

      expect(result.success).toBe(false);
    });
  });
});
