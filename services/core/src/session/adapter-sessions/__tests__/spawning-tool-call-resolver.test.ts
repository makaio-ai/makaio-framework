import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { registerSpawningToolCallResolver } from '../spawning-tool-call-resolver.js';
import { useAdapterSessionTestLifecycle } from './shared.js';

/**
 * Creates a minimal Makaio session for resolver tests.
 * @param sessionId - Session ID to create
 */
async function createMakaioSession(sessionId: string): Promise<void> {
  const now = Date.now();
  await MakaioBus.request(SessionStorageSubjects.set, {
    sessionId,
    session: {
      sessionId,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      agents: [],
    },
  });
}

/**
 * Creates a minimal assistant message fixture.
 * @param sessionId - Session owning the message
 * @param messageId - Message ID
 * @param blocks - Structured message blocks
 * @returns Persistable message fixture
 */
function createAssistantMessage(
  sessionId: string,
  messageId: string,
  blocks: SessionMessage['blocks'],
): Omit<SessionMessage, 'messageId'> & { messageId: string } {
  return {
    messageId,
    turnId: null,
    sessionId,
    role: 'assistant',
    contentText: 'assistant',
    blocks,
    timestamp: Date.now(),
  };
}

describe('registerSpawningToolCallResolver', () => {
  let parentMessages: SessionMessage[] = [];

  const testContext = useAdapterSessionTestLifecycle(
    { beforeEach, afterEach },
    {
      additionalHandlers: () => {
        const cleanupGetBySession = MakaioBus.on(MessageStorageSubjects.getBySession, (ctx) => {
          if (ctx.payload.sessionId !== 'parent-session') {
            ctx.setResult({ messages: [], nextCursor: null });
            return;
          }

          ctx.setResult({ messages: parentMessages, nextCursor: null });
        });
        const cleanupResolver = registerSpawningToolCallResolver(MakaioBus);
        return () => {
          cleanupResolver();
          cleanupGetBySession();
        };
      },
    },
  );

  afterEach(() => {
    parentMessages = [];
  });

  beforeEach(async () => {
    await testContext.db.run(sql`
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'error')),
        error TEXT,
        usage TEXT
      )
    `);
    await testContext.db.run(sql`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT REFERENCES turns(turn_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content_text TEXT NOT NULL,
        blocks TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        adapter_session_id TEXT,
        adapter_message_id TEXT,
        timestamp INTEGER NOT NULL,
        edit_of TEXT REFERENCES messages(message_id),
        origin TEXT CHECK (origin IS NULL OR origin IN ('voice', 'text'))
      )
    `);
    await createMakaioSession('parent-session');
    await createMakaioSession('child-session-a');
    await createMakaioSession('child-session-b');

    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: 'child-session-a',
      parentSessionId: 'parent-session',
      branchKind: 'subagent',
    });
    await MakaioBus.request(SessionStorageSubjects.update, {
      sessionId: 'child-session-b',
      parentSessionId: 'parent-session',
      branchKind: 'subagent',
    });
  });

  it('backfills spawningToolCallId only when a tool_output proves the match', async () => {
    parentMessages = [
      createAssistantMessage('parent-session', 'parent-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'delegate A' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-a',
          output: 'child session id: child-session-a',
          isError: false,
        },
        {
          type: 'tool_call',
          toolCallId: 'tool-call-b',
          name: 'Agent',
          args: { task: 'delegate B' },
        },
      ]),
    ];

    await MakaioBus.emit(AdapterSubjects.session.linked, {
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      adapterSessionId: 'adapter-parent',
      sessionId: 'parent-session',
    });

    await vi.waitFor(async () => {
      const childA = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'child-session-a',
      });
      expect(childA.session?.spawningToolCallId).toBe('tool-call-a');
    });

    const childB = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-b',
    });
    expect(childB.session?.spawningToolCallId).toBeUndefined();
  });

  it('does not guess by position when no tool_output references a child session', async () => {
    parentMessages = [
      createAssistantMessage('parent-session', 'parent-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'delegate A' },
        },
        {
          type: 'tool_call',
          toolCallId: 'tool-call-b',
          name: 'Agent',
          args: { task: 'delegate B' },
        },
      ]),
    ];

    await MakaioBus.emit(AdapterSubjects.session.linked, {
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      adapterSessionId: 'adapter-parent',
      sessionId: 'parent-session',
    });

    await vi.waitFor(async () => {
      const { children } = await MakaioBus.request(SessionStorageSubjects.getChildren, {
        sessionId: 'parent-session',
      });
      expect(children).toHaveLength(2);
    });

    const childA = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-a',
    });
    const childB = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-b',
    });

    expect(childA.session?.spawningToolCallId).toBeUndefined();
    expect(childB.session?.spawningToolCallId).toBeUndefined();
  });

  it('does not match a session ID that only appears as a longer token prefix', async () => {
    parentMessages = [
      createAssistantMessage('parent-session', 'parent-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'delegate A' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-a',
          output: 'created session child-session-a-extra for nested task',
          isError: false,
        },
      ]),
    ];

    await MakaioBus.emit(AdapterSubjects.session.linked, {
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      adapterSessionId: 'adapter-parent',
      sessionId: 'parent-session',
    });

    const childA = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-a',
    });

    expect(childA.session?.spawningToolCallId).toBeUndefined();
  });

  it('does not assign a tool call when one output ambiguously references multiple child sessions', async () => {
    parentMessages = [
      createAssistantMessage('parent-session', 'parent-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'delegate A' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-a',
          output: 'spawned child-session-a and child-session-b during orchestration',
          isError: false,
        },
      ]),
    ];

    await MakaioBus.emit(AdapterSubjects.session.linked, {
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      adapterSessionId: 'adapter-parent',
      sessionId: 'parent-session',
    });

    const childA = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-a',
    });
    const childB = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-b',
    });

    expect(childA.session?.spawningToolCallId).toBeUndefined();
    expect(childB.session?.spawningToolCallId).toBeUndefined();
  });

  it('does not persist an assignment when multiple tool calls point at the same child session', async () => {
    parentMessages = [
      createAssistantMessage('parent-session', 'parent-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'delegate A' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-a',
          output: 'child session id: child-session-a',
          isError: false,
        },
        {
          type: 'tool_call',
          toolCallId: 'tool-call-b',
          name: 'Agent',
          args: { task: 'delegate B' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-b',
          output: 'child session id: child-session-a',
          isError: false,
        },
      ]),
    ];

    await MakaioBus.emit(AdapterSubjects.session.linked, {
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      adapterSessionId: 'adapter-parent',
      sessionId: 'parent-session',
    });

    const childA = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'child-session-a',
    });

    expect(childA.session?.spawningToolCallId).toBeUndefined();
  });

  it('backfills subagents whose spawningToolCallId is still missing on the child session', async () => {
    parentMessages = [
      createAssistantMessage('parent-session', 'parent-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'delegate A' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-a',
          output: 'child session id: child-session-a',
          isError: false,
        },
      ]),
    ];

    await testContext.db.run(sql`
      UPDATE sessions
      SET spawning_tool_call_id = NULL
      WHERE session_id = 'child-session-a'
    `);

    await MakaioBus.emit(AdapterSubjects.session.linked, {
      adapterName: 'claude-code',
      adapterId: 'adapter-1',
      adapterSessionId: 'adapter-parent',
      sessionId: 'parent-session',
    });

    await vi.waitFor(async () => {
      const childA = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'child-session-a',
      });
      expect(childA.session?.spawningToolCallId).toBe('tool-call-a');
    });
  });
});
