/**
 * Shared test utilities for session events Drizzle handler tests.
 */
import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { getRawSqlExecutor, type MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import type { MakaioSessionEvent, SessionEventType, SessionEventTypeMap } from '@makaio/contracts';
import { registerDrizzleSessionEventStorage } from '../drizzle-handler.js';

// Test-only event type extension
declare module '@makaio/contracts' {
  interface SessionEventTypeMap {
    'git.commit': {
      hash: string;
      message: string;
      branch: string;
      repoPath: string;
      author: string;
      email: string;
      commitTimestamp: string;
      worktree?: string;
    };
    'git.checkout': {
      previousBranch?: string;
      currentBranch: string;
      repoPath: string;
      worktree?: string;
    };
    'git.merge': {
      sourceBranch: string;
      targetBranch: string;
      mergeCommit: string;
      repoPath: string;
      worktree?: string;
    };
    'git.pr.context': {
      prId: string;
      prNumber: number;
      prTitle: string;
      prUrl: string;
      repoPath: string;
      branch: string;
    };
    'question-extractor.result': {
      turnId: string;
      questions: Array<{
        question: string;
        choices: string[];
      }>;
    };
    'timeline.summary': {
      messageId: string;
      role: 'user' | 'assistant';
      summary: string;
    };
    'tool.tracked': {
      trackedCallId: string;
      toolCallId: string;
      toolName: string;
      operationCount: number;
    };
    /**
     * Fork summary generation event.
     * Matches the UI chat view contract.
     */
    'fork-summary.generated': {
      fromMessageId: string;
      toMessageId: string;
      summaryText: string;
      personaName?: string;
    };
  }
}

/**
 * SQL statement to create the sessions table for testing.
 * Required as session_events has FK to sessions.
 */
export const CREATE_SESSIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'closed', 'archived', 'discovered')),
    lead_agent_id TEXT
  )
`;

/**
 * SQL statement to create the session_events table for testing.
 * Mirrors the schema from schema.ts.
 */
export const CREATE_SESSION_EVENTS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    agent_id TEXT,
    adapter_id TEXT,
    originating_message_id TEXT,
    message_id TEXT,
    turn_id TEXT,
    content_text TEXT,
    payload TEXT NOT NULL
  )
`;

/**
 * SQL statement to create indexes for session_events table.
 */
export const CREATE_INDEXES_SQL = [
  sql`CREATE INDEX IF NOT EXISTS idx_events_session_ts ON session_events(session_id, timestamp)`,
  sql`CREATE INDEX IF NOT EXISTS idx_events_session_type ON session_events(session_id, type)`,
  sql`CREATE INDEX IF NOT EXISTS idx_events_turn ON session_events(turn_id)`,
  sql`CREATE INDEX IF NOT EXISTS idx_events_originating_message ON session_events(originating_message_id)`,
];

/**
 * Test database context containing the database and cleanup function.
 * Note: This context doesn't include dbPath since it uses :memory: database.
 */
export interface TestDbContext {
  db: MakaioDatabase;
  /** Deregisters storage handlers and closes the database connection. */
  cleanup: () => void;
}

/**
 * Creates an in-memory SQLite database for testing.
 * Initializes sessions and session_events tables.
 * @returns Test database context
 */
export async function createTestDb(): Promise<TestDbContext> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });
  const rawSql = getRawSqlExecutor(db);

  // Create tables in order (sessions first due to FK)
  await rawSql.run(CREATE_SESSIONS_TABLE_SQL);
  await rawSql.run(CREATE_SESSION_EVENTS_TABLE_SQL);

  // Create indexes
  for (const indexSql of CREATE_INDEXES_SQL) {
    await rawSql.run(indexSql);
  }

  // Register the storage handler
  const deregister = registerDrizzleSessionEventStorage(MakaioBus, db);

  const cleanup = (): void => {
    try {
      deregister();
    } finally {
      close();
    }
  };

  return { db, cleanup };
}

/**
 * Insert a test session into the sessions table.
 * Required before inserting session events due to FK constraint.
 * @param db - The database instance
 * @param sessionId - The session ID to create
 */
export async function insertTestSession(db: MakaioDatabase, sessionId: string): Promise<void> {
  const now = Date.now();
  await getRawSqlExecutor(db).run(
    sql`INSERT OR IGNORE INTO sessions (session_id, created_at, last_activity_at, status)
        VALUES (${sessionId}, ${now}, ${now}, 'active')`,
  );
}

/**
 * Create a test session event with sensible defaults.
 * Uses discriminated union to ensure payload matches event type.
 * @param overrides - Partial event fields including required sessionId and type
 * @returns A MakaioSessionEvent for testing
 */
export function createEvent(
  overrides: { sessionId: string; type: SessionEventType } & Partial<
    Pick<MakaioSessionEvent, 'eventId' | 'timestamp'>
  > &
    Partial<{
      content: string | { blocks: Array<{ type: 'text'; content: string }> };
      turnId: string;
      turnNumber: number;
      messageId: string;
      agentId: string;
      adapterId: string;
      payload:
        | Partial<SessionEventTypeMap['tool.tracked']>
        | Partial<SessionEventTypeMap['git.commit']>
        | Partial<SessionEventTypeMap['git.checkout']>
        | Partial<SessionEventTypeMap['git.merge']>
        | Partial<SessionEventTypeMap['git.pr.context']>
        | Partial<SessionEventTypeMap['question-extractor.result']>
        | Partial<SessionEventTypeMap['fork-summary.generated']>
        | Partial<SessionEventTypeMap['skill.catalog.built']>
        | Partial<SessionEventTypeMap['skill.activated']>
        | Partial<SessionEventTypeMap['skill.deactivated']>
        | Partial<SessionEventTypeMap['locality.degraded']>;
    }>,
): MakaioSessionEvent {
  const base = {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    sessionId: overrides.sessionId,
  };

  // Create type-safe event based on discriminated union
  switch (overrides.type) {
    case 'agent.added':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'agent.added',
        payload: {
          sessionId: overrides.sessionId,
          adapterSessionId: `adapter-session-${Math.random().toString(36).slice(2)}`,
          agentId: overrides.agentId ?? `agent-${Math.random().toString(36).slice(2)}`,
          adapterId: overrides.adapterId ?? 'test-adapter',
          adapterName: 'Test Adapter',
        },
      };
    case 'user_message.sent':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'user_message.sent',
        payload: {
          sessionId: overrides.sessionId,
          turnId: overrides.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
          turnNumber: overrides.turnNumber ?? 1,
          messageId: overrides.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          content: overrides.content ?? 'Test message',
          agentIds: ['agent-1'],
        },
      };
    case 'user_message.acknowledged':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'user_message.acknowledged',
        payload: {
          sessionId: overrides.sessionId,
          turnId: overrides.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
          turnNumber: overrides.turnNumber ?? 1,
          messageId: overrides.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          agentId: overrides.agentId ?? 'agent-1',
        },
      };
    case 'user_message.completed':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'user_message.completed',
        payload: {
          sessionId: overrides.sessionId,
          turnId: overrides.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
          turnNumber: overrides.turnNumber ?? 1,
          messageId: overrides.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          agentId: overrides.agentId ?? 'agent-1',
          outcome: 'completed',
        },
      };
    case 'turn.started':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'turn.started',
        payload: {
          sessionId: overrides.sessionId,
          turnId: overrides.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
          turnNumber: overrides.turnNumber ?? 1,
          messageId: overrides.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          agentIds: ['agent-1'],
        },
      };
    case 'turn.completed':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'turn.completed',
        payload: {
          sessionId: overrides.sessionId,
          turnId: overrides.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
          turnNumber: overrides.turnNumber ?? 1,
          success: true,
        },
      };
    case 'branch.created':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'branch.created',
        payload: {
          childSessionId: `child-${Math.random().toString(36).slice(2)}`,
          parentSessionId: overrides.sessionId,
          kind: 'fork',
          forkPointMessageId: overrides.messageId,
        },
      };
    case 'branch.merged':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'branch.merged',
        payload: {
          childSessionId: `child-${Math.random().toString(36).slice(2)}`,
          parentSessionId: overrides.sessionId,
          resultJson: '{"summary":"merged"}',
          resultMessageId: overrides.messageId,
        },
      };
    case 'squash':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'squash',
        payload: {
          summaryJson: '{"summary":"compressed"}',
          tokensBefore: 1000,
          tokensAfter: 200,
          compressedMessageIds: overrides.messageId ? [overrides.messageId] : undefined,
        },
      };
    case 'message':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'message',
        payload: {
          messageId: overrides.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          turnId: overrides.turnId ?? null,
          role: 'user' as const,
        },
      };
    case 'timeline.summary':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'timeline.summary',
        payload: {
          messageId: overrides.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          role: 'user' as const,
          summary: 'Test summary',
        },
      };
    case 'git.commit': {
      const gitCommitPayload = overrides.payload as Partial<SessionEventTypeMap['git.commit']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'git.commit',
        payload: {
          hash: gitCommitPayload?.hash ?? `sha-${Math.random().toString(36).slice(2)}`,
          message: gitCommitPayload?.message ?? 'Test commit',
          branch: gitCommitPayload?.branch ?? 'main',
          repoPath: gitCommitPayload?.repoPath ?? '/test/repo',
          author: gitCommitPayload?.author ?? 'Test Author',
          email: gitCommitPayload?.email ?? 'test@example.com',
          commitTimestamp: gitCommitPayload?.commitTimestamp ?? new Date().toISOString(),
          ...(gitCommitPayload?.worktree !== undefined && { worktree: gitCommitPayload.worktree }),
        },
      };
    }
    case 'git.checkout': {
      const gitCheckoutPayload = overrides.payload as Partial<SessionEventTypeMap['git.checkout']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'git.checkout',
        payload: {
          previousBranch: gitCheckoutPayload?.previousBranch ?? 'main',
          currentBranch: gitCheckoutPayload?.currentBranch ?? 'feature',
          repoPath: gitCheckoutPayload?.repoPath ?? '/test/repo',
          ...(gitCheckoutPayload?.worktree !== undefined && { worktree: gitCheckoutPayload.worktree }),
        },
      };
    }
    case 'git.merge': {
      const gitMergePayload = overrides.payload as Partial<SessionEventTypeMap['git.merge']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'git.merge',
        payload: {
          sourceBranch: gitMergePayload?.sourceBranch ?? 'feature',
          targetBranch: gitMergePayload?.targetBranch ?? 'main',
          mergeCommit: gitMergePayload?.mergeCommit ?? `merge-${Math.random().toString(36).slice(2)}`,
          repoPath: gitMergePayload?.repoPath ?? '/test/repo',
          ...(gitMergePayload?.worktree !== undefined && { worktree: gitMergePayload.worktree }),
        },
      };
    }
    case 'git.pr.context': {
      const gitPrContextPayload = overrides.payload as Partial<SessionEventTypeMap['git.pr.context']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'git.pr.context',
        payload: {
          prId: gitPrContextPayload?.prId ?? 'owner/repo#123',
          prNumber: gitPrContextPayload?.prNumber ?? 123,
          prTitle: gitPrContextPayload?.prTitle ?? 'Test PR',
          prUrl: gitPrContextPayload?.prUrl ?? 'https://github.com/test/repo/pull/123',
          repoPath: gitPrContextPayload?.repoPath ?? '/test/repo',
          branch: gitPrContextPayload?.branch ?? 'feature',
        },
      };
    }
    case 'tool.tracked': {
      const ttPayload = overrides.payload as Partial<SessionEventTypeMap['tool.tracked']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'tool.tracked',
        payload: {
          trackedCallId: ttPayload?.trackedCallId ?? `tracked-${Math.random().toString(36).slice(2)}`,
          toolCallId: ttPayload?.toolCallId ?? `tool-call-${Math.random().toString(36).slice(2)}`,
          toolName: ttPayload?.toolName ?? 'Read',
          operationCount: ttPayload?.operationCount ?? 1,
        },
      };
    }
    case 'question-extractor.result': {
      const qePayload = overrides.payload as Partial<SessionEventTypeMap['question-extractor.result']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'question-extractor.result',
        payload: {
          turnId: overrides.turnId ?? qePayload?.turnId ?? `turn-${Math.random().toString(36).slice(2)}`,
          questions: qePayload?.questions ?? [{ question: 'Test question?', choices: ['Yes', 'No'] }],
        },
      };
    }
    case 'fork-summary.generated': {
      const fsPayload = overrides.payload as Partial<SessionEventTypeMap['fork-summary.generated']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'fork-summary.generated',
        payload: {
          fromMessageId: fsPayload?.fromMessageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          toMessageId: fsPayload?.toMessageId ?? `msg-${Math.random().toString(36).slice(2)}`,
          summaryText: fsPayload?.summaryText ?? 'Test summary',
          ...(fsPayload?.personaName !== undefined && { personaName: fsPayload.personaName }),
        },
      };
    }
    case 'session.compacted':
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'session.compacted',
        payload: {
          trigger: 'manual' as const,
          preTokens: 1000,
          summary: '',
          compressChildSessionId: `child-${Math.random().toString(36).slice(2)}`,
        },
      };
    case 'skill.catalog.built': {
      const scbPayload = overrides.payload as Partial<SessionEventTypeMap['skill.catalog.built']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'skill.catalog.built',
        payload: {
          agentId: overrides.agentId ?? scbPayload?.agentId ?? `agent-${Math.random().toString(36).slice(2)}`,
          cwd: scbPayload?.cwd ?? '/test/cwd',
          ...((overrides.adapterId ?? scbPayload?.adapterId)
            ? { adapterId: overrides.adapterId ?? scbPayload?.adapterId }
            : {}),
          skillNames: scbPayload?.skillNames ?? ['test-skill'],
        },
      };
    }
    case 'skill.activated': {
      const saPayload = overrides.payload as Partial<SessionEventTypeMap['skill.activated']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'skill.activated',
        payload: {
          agentId: overrides.agentId ?? saPayload?.agentId ?? `agent-${Math.random().toString(36).slice(2)}`,
          skillName: saPayload?.skillName ?? 'test-skill',
          trigger: saPayload?.trigger ?? 'auto',
          ...((overrides.turnNumber ?? saPayload?.turnNumber)
            ? { turnNumber: overrides.turnNumber ?? saPayload?.turnNumber }
            : {}),
        },
      };
    }
    case 'skill.deactivated': {
      const sdPayload = overrides.payload as Partial<SessionEventTypeMap['skill.deactivated']> | undefined;
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'skill.deactivated',
        payload: {
          agentId: overrides.agentId ?? sdPayload?.agentId ?? `agent-${Math.random().toString(36).slice(2)}`,
          skillName: sdPayload?.skillName ?? 'test-skill',
          reason: sdPayload?.reason ?? 'user',
        },
      };
    }
    case 'locality.degraded': {
      const ldPayload = overrides.payload as Partial<SessionEventTypeMap['locality.degraded']> | undefined;
      const verdictKind = ldPayload?.verdictKind ?? 'degrade';
      // Build variant-specific fields matching the discriminated union:
      // 'degrade' requires reason, 'foreign' requires foreignMachineId.
      const variantFields =
        verdictKind === 'foreign'
          ? {
              verdictKind: 'foreign' as const,
              foreignMachineId:
                (ldPayload as Partial<Extract<SessionEventTypeMap['locality.degraded'], { verdictKind: 'foreign' }>>)
                  ?.foreignMachineId ?? 'remote-machine',
            }
          : {
              verdictKind: 'degrade' as const,
              reason:
                (ldPayload as Partial<Extract<SessionEventTypeMap['locality.degraded'], { verdictKind: 'degrade' }>>)
                  ?.reason ?? 'adapter-unsupported',
            };
      return {
        ...base,
        eventId: overrides.eventId ?? base.eventId,
        timestamp: overrides.timestamp ?? base.timestamp,
        type: 'locality.degraded',
        payload: {
          intent: ldPayload?.intent ?? 'resume',
          ...variantFields,
          ...((overrides.agentId ?? ldPayload?.agentId) !== undefined
            ? { agentId: overrides.agentId ?? ldPayload?.agentId }
            : {}),
          ...((overrides.adapterId ?? ldPayload?.adapterId) !== undefined
            ? { adapterId: overrides.adapterId ?? ldPayload?.adapterId }
            : {}),
          ...((overrides.turnId ?? ldPayload?.turnId) !== undefined
            ? { turnId: overrides.turnId ?? ldPayload?.turnId }
            : {}),
        },
      };
    }
    default: {
      const exhaustiveCheck: never = overrides.type;
      throw new Error(`Unhandled event type: ${exhaustiveCheck}`);
    }
  }
}
