/* eslint max-lines: ["error", { "max": 500 }] */
import { describe, it, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { createSession, createAgent, useDrizzleTestLifecycle } from './shared.js';
import { describeSessionStorageBehavior } from './session-storage-behavior.js';

describe('registerDrizzleSessionStorage', () => {
  const ctx = useDrizzleTestLifecycle();

  // Shared behavioral tests (status filter, worktree, delete, getByAdapterSessionId)
  describeSessionStorageBehavior();

  describe('set (persist session)', () => {
    it('should persist session to SQLite', async () => {
      const session = createSession({ sessionId: 'persist-test-1' });
      const result = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });
      expect(result.success).toBe(true);

      // Verify directly in DB
      const rows = await ctx.db.all<{ session_id: string }>(
        sql`SELECT * FROM sessions WHERE session_id = 'persist-test-1'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe('persist-test-1');
    });
    it('should persist session with agents', async () => {
      const leadAgent = createAgent({
        agentId: 'lead-1',
        sessionId: 'agents-test-1',
        role: 'lead',
        adapterName: 'claude-code',
      });
      const memberAgent = createAgent({
        agentId: 'member-1',
        sessionId: 'agents-test-1',
        role: 'member',
        adapterName: 'copilot',
      });
      const session = createSession({
        sessionId: 'agents-test-1',
        leadAgentId: leadAgent.agentId,
        agents: [leadAgent, memberAgent],
      });

      const result = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });
      expect(result.success).toBe(true);

      // Persist agents independently
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: leadAgent.agentId,
        agent: leadAgent,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: memberAgent.agentId,
        agent: memberAgent,
      });

      // Verify agents in DB
      const agentRows = await ctx.db.all<{ session_id: string }>(
        sql`SELECT * FROM agents WHERE session_id = 'agents-test-1'`,
      );
      expect(agentRows).toHaveLength(2);
    });
    it('should update session on conflict (upsert)', async () => {
      const session = createSession({
        sessionId: 'upsert-test',
        status: 'active',
        lastActivityAt: 1000,
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const updatedSession = createSession({
        sessionId: 'upsert-test',
        status: 'closed',
        lastActivityAt: 2000,
        createdAt: session.createdAt,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: updatedSession.sessionId,
        session: updatedSession,
      });
      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'upsert-test',
      });
      expect(retrieved.session?.status).toBe('closed');
      expect(retrieved.session?.lastActivityAt).toBe(2000);
    });
    it('should not overwrite when ifAbsent is true', async () => {
      const session = createSession({
        sessionId: 'if-absent-test',
        status: 'active',
        lastActivityAt: 1000,
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const updatedSession = createSession({
        sessionId: 'if-absent-test',
        status: 'closed',
        lastActivityAt: 2000,
        createdAt: session.createdAt,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: updatedSession.sessionId,
        session: updatedSession,
        ifAbsent: true,
      });
      expect(result.success).toBe(false);

      const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'if-absent-test',
      });
      expect(retrieved.session?.status).toBe('active');
      expect(retrieved.session?.lastActivityAt).toBe(1000);
    });

    it('should replace agents on update', async () => {
      const originalAgent = createAgent({
        agentId: 'original-agent',
        sessionId: 'replace-agents-test',
        role: 'lead',
      });
      const session = createSession({
        sessionId: 'replace-agents-test',
        agents: [originalAgent],
        leadAgentId: originalAgent.agentId,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: originalAgent.agentId,
        agent: originalAgent,
      });

      const newAgent = createAgent({
        agentId: 'new-agent',
        sessionId: 'replace-agents-test',
        role: 'lead',
      });
      const updatedSession = createSession({
        sessionId: 'replace-agents-test',
        agents: [newAgent],
        leadAgentId: newAgent.agentId,
        createdAt: session.createdAt,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: updatedSession.sessionId,
        session: updatedSession,
      });

      // Delete old agent and set new agent
      await MakaioBus.request(AgentStorageSubjects.delete, {
        agentId: originalAgent.agentId,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: newAgent.agentId,
        agent: newAgent,
      });

      const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'replace-agents-test',
      });
      expect(retrieved.session?.agents).toHaveLength(1);
      expect(retrieved.session?.agents[0].agentId).toBe('new-agent');
    });
  });

  describe('get (retrieve session)', () => {
    it('should retrieve session by ID', async () => {
      const session = createSession({ sessionId: 'retrieve-test-1' });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(result.session).toEqual(session);
    });

    it('should return null for non-existent session', async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'non-existent-session',
      });

      expect(result.session).toBeNull();
    });

    it('should reconstruct session with agents via join', async () => {
      const leadAgent = createAgent({
        agentId: 'lead-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        sessionId: 'join-test',
        status: 'idle',
        createdAt: 1000,
        lastActivityAt: 1000,
        role: 'lead',
      });
      const memberAgent = createAgent({
        agentId: 'member-agent',
        adapterId: 'adapter-2',
        adapterName: 'copilot',
        sessionId: 'join-test',
        status: 'idle',
        createdAt: 2000,
        lastActivityAt: 2000,
        role: 'member',
      });

      const session = createSession({
        sessionId: 'join-test',
        leadAgentId: leadAgent.agentId,
        agents: [leadAgent, memberAgent],
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      // Persist agents independently
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: leadAgent.agentId,
        agent: leadAgent,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: memberAgent.agentId,
        agent: memberAgent,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'join-test',
      });

      expect(result.session).not.toBeNull();
      expect(result.session?.agents).toHaveLength(2);
      expect(result.session?.leadAgentId).toBe('lead-agent');

      // Verify agent properties are correctly mapped
      const retrieved = result.session?.agents.find((a) => a.agentId === 'lead-agent');
      expect(retrieved?.adapterId).toBe('adapter-1');
      expect(retrieved?.adapterName).toBe('claude-code');
      expect(retrieved?.role).toBe('lead');
    });
  });

  describe('list', () => {
    it('should default to all sessions when status not specified', async () => {
      const activeSession = createSession({ sessionId: 'default-active', status: 'active' });
      const closedSession = createSession({ sessionId: 'default-closed', status: 'closed' });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: activeSession.sessionId,
        session: activeSession,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: closedSession.sessionId,
        session: closedSession,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.list, {});
      expect(result.sessions).toHaveLength(2);
    });

    it('should batch-fetch agents and group by sessionId', async () => {
      const agent1 = createAgent({
        agentId: 'batch-agent-1',
        sessionId: 'batch-session-1',
        role: 'lead',
      });
      const agent2 = createAgent({
        agentId: 'batch-agent-2',
        sessionId: 'batch-session-2',
        role: 'member',
      });

      const session1 = createSession({
        sessionId: 'batch-session-1',
        agents: [agent1],
        leadAgentId: agent1.agentId,
      });
      const session2 = createSession({
        sessionId: 'batch-session-2',
        agents: [agent2],
        leadAgentId: agent2.agentId,
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session1.sessionId,
        session: session1,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session2.sessionId,
        session: session2,
      });

      // Persist agents independently
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent1.agentId,
        agent: agent1,
      });
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent2.agentId,
        agent: agent2,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.list, {});

      expect(result.sessions).toHaveLength(2);

      const s1 = result.sessions.find((s) => s.sessionId === 'batch-session-1');
      const s2 = result.sessions.find((s) => s.sessionId === 'batch-session-2');

      expect(s1?.agents).toHaveLength(1);
      expect(s1?.agents[0].agentId).toBe('batch-agent-1');
      expect(s2?.agents).toHaveLength(1);
      expect(s2?.agents[0].agentId).toBe('batch-agent-2');
    });

    it('should include first user message preview without scanning all user messages in memory', async () => {
      await ctx.db.run(sql`
        CREATE TABLE IF NOT EXISTS turns (
          turn_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          status TEXT NOT NULL,
          error TEXT,
          usage TEXT
        )
      `);
      await ctx.db.run(sql`
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          turn_id TEXT REFERENCES turns(turn_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content_text TEXT NOT NULL,
          blocks TEXT NOT NULL DEFAULT '[]',
          agent_id TEXT,
          adapter_session_id TEXT,
          adapter_message_id TEXT,
          timestamp INTEGER NOT NULL,
          edit_of TEXT REFERENCES messages(message_id),
          origin TEXT
        )
      `);

      const previewSession = createSession({
        sessionId: 'preview-session',
        createdAt: 10,
        lastActivityAt: 20,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: previewSession.sessionId,
        session: previewSession,
      });

      await ctx.db.run(sql`
        INSERT INTO messages (message_id, turn_id, session_id, role, content_text, blocks, timestamp)
        VALUES
          ('msg-assistant', null, 'preview-session', 'assistant', 'assistant text', '[]', 100),
          ('msg-user-early', null, 'preview-session', 'user', 'first user message', '[]', 200),
          ('msg-user-late', null, 'preview-session', 'user', 'later user message', '[]', 300)
      `);

      const result = await MakaioBus.request(SessionStorageSubjects.list, {
        status: 'all',
        includePreview: true,
      });

      const listed = result.sessions.find((session) => session.sessionId === 'preview-session');
      expect(listed?.preview?.firstUserMessage).toBe('first user message');
      expect(listed?.preview?.messageCount).toBe(3);
    });
  });

  describe('native session import fields', () => {
    it('should persist session with origin tracking fields', async () => {
      const session = createSession({
        sessionId: 'native-import-test',
        rootSessionId: 'root-session-123',
        adapterName: 'claude-code',
        adapterSessionId: 'cc-session-abc',
        adapterId: 'machine-xyz',
        isOrchestrated: false,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });
      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(retrieved.session?.rootSessionId).toBe('root-session-123');
      expect(retrieved.session?.adapterName).toBe('claude-code');
      expect(retrieved.session?.adapterSessionId).toBe('cc-session-abc');
      expect(retrieved.session?.adapterId).toBe('machine-xyz');
      expect(retrieved.session?.isOrchestrated).toBe(false);
    });
  });

  describe('delete (drizzle-specific)', () => {
    it('should cascade delete to agents', async () => {
      const agent = createAgent({
        agentId: 'cascade-agent',
        sessionId: 'cascade-test',
        role: 'lead',
      });
      const session = createSession({
        sessionId: 'cascade-test',
        agents: [agent],
        leadAgentId: agent.agentId,
      });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      // Persist agent independently
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId: agent.agentId,
        agent,
      });

      const agentsBefore = await ctx.db.all<{ session_id: string }>(
        sql`SELECT * FROM agents WHERE session_id = 'cascade-test'`,
      );
      expect(agentsBefore).toHaveLength(1);

      await MakaioBus.request(SessionStorageSubjects.delete, { sessionId: session.sessionId });

      const agentsAfter = await ctx.db.all<{ session_id: string }>(
        sql`SELECT * FROM agents WHERE session_id = 'cascade-test'`,
      );
      expect(agentsAfter).toHaveLength(0);
    });
  });
});
