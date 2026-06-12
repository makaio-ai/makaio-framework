import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { registerCompressLineageResolver } from '../compress-lineage-resolver.js';
import { useImportResolverTestLifecycle } from './shared.js';

const messagesBySession = new Map<string, SessionMessage[]>();

/**
 * Creates a minimal Makaio session for compress resolver tests.
 * @param sessionId - Session ID to create
 * @param overrides - Optional session field overrides
 */
async function createMakaioSession(
  sessionId: string,
  overrides: Partial<{
    adapterSessionId: string;
    parentExternalSessionId: string;
    parentSessionId: string;
    rootSessionId: string;
    branchKind: 'fork' | 'subagent' | 'compress';
    spawningToolCallId: string;
    source: string;
  }> = {},
): Promise<void> {
  const now = Date.now();
  await MakaioBus.request(SessionStorageSubjects.set, {
    sessionId,
    session: {
      sessionId,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      agents: [],
      source: 'claude-code',
      ...overrides,
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

/**
 * Emits the import completion event consumed by lineage resolvers.
 * @param sessionId - Makaio session ID that completed import
 * @param adapterSessionId - External adapter session ID for the imported session
 */
async function emitImportCompleted(sessionId: string, adapterSessionId: string): Promise<void> {
  await MakaioBus.emit(SessionSubjects.import.completed, {
    sessionId,
    adapterSessionId,
    source: 'claude-code',
  });
}

describe('registerCompressLineageResolver', () => {
  const testContext = useImportResolverTestLifecycle(
    { beforeEach, afterEach },
    {
      additionalHandlers: () => {
        const cleanupGetBySession = MakaioBus.on(MessageStorageSubjects.getBySession, (ctx) => {
          ctx.setResult({
            messages: messagesBySession.get(ctx.payload.sessionId) ?? [],
            nextCursor: null,
          });
        });
        const cleanupResolver = registerCompressLineageResolver(MakaioBus);
        return () => {
          cleanupResolver();
          cleanupGetBySession();
        };
      },
    },
  );

  afterEach(() => {
    messagesBySession.clear();
  });

  beforeEach(async () => {
    await getRawSqlExecutor(testContext.db).run(sql`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT,
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
  });

  it('reparents existing post-compaction subagents when a compress child import completes', async () => {
    await createMakaioSession('parent-session', { adapterSessionId: 'external-parent' });
    await createMakaioSession('compress-session', {
      adapterSessionId: 'external-compress',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'compress',
    });
    await createMakaioSession('subagent-session', {
      adapterSessionId: 'external-subagent',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'subagent',
    });
    messagesBySession.set('compress-session', [
      createAssistantMessage('compress-session', 'compress-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-after-compress',
          name: 'Agent',
          args: { task: 'continue after compaction' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-after-compress',
          output: 'spawned session external-subagent for follow-up work',
          isError: false,
        },
      ]),
    ]);

    await emitImportCompleted('compress-session', 'external-compress');

    await vi.waitFor(async () => {
      const { session } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'subagent-session',
      });
      expect(session?.parentSessionId).toBe('compress-session');
      expect(session?.spawningToolCallId).toBe('tool-call-after-compress');
    });
  });

  it('does not reparent duplicate subagent adapter session IDs from a compress child', async () => {
    await createMakaioSession('parent-session', { adapterSessionId: 'external-parent' });
    await createMakaioSession('compress-session', {
      adapterSessionId: 'external-compress',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'compress',
    });
    await createMakaioSession('subagent-session-a', {
      adapterSessionId: 'external-subagent',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'subagent',
    });
    await createMakaioSession('subagent-session-b', {
      adapterSessionId: 'external-subagent',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'subagent',
      source: 'codex',
    });
    messagesBySession.set('compress-session', [
      createAssistantMessage('compress-session', 'compress-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-after-compress',
          name: 'Agent',
          args: { task: 'continue after compaction' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-after-compress',
          output: 'spawned session external-subagent for follow-up work',
          isError: false,
        },
      ]),
    ]);

    await emitImportCompleted('compress-session', 'external-compress');

    const first = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'subagent-session-a',
    });
    const second = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'subagent-session-b',
    });
    expect(first.session?.parentSessionId).toBe('parent-session');
    expect(first.session?.spawningToolCallId).toBeUndefined();
    expect(second.session?.parentSessionId).toBe('parent-session');
    expect(second.session?.spawningToolCallId).toBeUndefined();
  });

  it('uses import-completed source when the compress child row has no source', async () => {
    await createMakaioSession('parent-session', { adapterSessionId: 'external-parent' });
    await createMakaioSession('compress-session', {
      adapterSessionId: 'external-compress',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'compress',
      source: undefined,
    });
    await createMakaioSession('subagent-session', {
      adapterSessionId: 'external-subagent',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'subagent',
    });
    messagesBySession.set('compress-session', [
      createAssistantMessage('compress-session', 'compress-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-after-compress',
          name: 'Agent',
          args: { task: 'continue after compaction' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-after-compress',
          output: 'spawned session external-subagent for follow-up work',
          isError: false,
        },
      ]),
    ]);

    await emitImportCompleted('compress-session', 'external-compress');

    await vi.waitFor(async () => {
      const { session } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'subagent-session',
      });
      expect(session?.parentSessionId).toBe('compress-session');
      expect(session?.spawningToolCallId).toBe('tool-call-after-compress');
    });
  });

  it('reparents a later-imported subagent to an existing compress child fallback', async () => {
    await createMakaioSession('parent-session', { adapterSessionId: 'external-parent' });
    await createMakaioSession('compress-session', {
      adapterSessionId: 'external-compress',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'compress',
    });
    await createMakaioSession('subagent-session', {
      adapterSessionId: 'external-subagent',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'subagent',
    });
    messagesBySession.set('compress-session', [
      createAssistantMessage('compress-session', 'compress-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-existing-compress',
          name: 'Agent',
          args: { task: 'fallback after compaction' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-existing-compress',
          output: 'created external-subagent',
          isError: false,
        },
      ]),
    ]);

    await emitImportCompleted('subagent-session', 'external-subagent');

    await vi.waitFor(async () => {
      const { session } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'subagent-session',
      });
      expect(session?.parentSessionId).toBe('compress-session');
      expect(session?.spawningToolCallId).toBe('tool-call-existing-compress');
    });
  });

  it('leaves parentage unchanged when multiple compress-child tool calls reference the same subagent', async () => {
    await createMakaioSession('parent-session', { adapterSessionId: 'external-parent' });
    await createMakaioSession('compress-session', {
      adapterSessionId: 'external-compress',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'compress',
    });
    await createMakaioSession('subagent-session', {
      adapterSessionId: 'external-subagent',
      parentExternalSessionId: 'external-parent',
      parentSessionId: 'parent-session',
      rootSessionId: 'parent-session',
      branchKind: 'subagent',
    });
    messagesBySession.set('compress-session', [
      createAssistantMessage('compress-session', 'compress-message', [
        {
          type: 'tool_call',
          toolCallId: 'tool-call-a',
          name: 'Agent',
          args: { task: 'first ambiguous task' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-a',
          output: 'created external-subagent',
          isError: false,
        },
        {
          type: 'tool_call',
          toolCallId: 'tool-call-b',
          name: 'Agent',
          args: { task: 'second ambiguous task' },
        },
        {
          type: 'tool_output',
          toolCallId: 'tool-call-b',
          output: 'also references external-subagent',
          isError: false,
        },
      ]),
    ]);

    await emitImportCompleted('compress-session', 'external-compress');

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'subagent-session',
    });
    expect(session?.parentSessionId).toBe('parent-session');
    expect(session?.spawningToolCallId).toBeUndefined();
  });
});
