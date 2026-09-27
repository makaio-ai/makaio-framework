import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleAgentStorage } from '../agent-drizzle-handler.js';
import { AgentStorageSubjects } from '../agent-namespace.js';

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
    currentAdapterSessionIdState: 'inherited',
    revision: 0,
    currencyFence: 0,
    ...overrides,
  };
}

/**
 * Creates a temp file SQLite database carrying the canonical session-storage
 * schema. A local copy of the DDL silently drifts from the real columns.
 * @returns Test database context with cleanup that removes the temp file
 */
async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath, exec } = await createTempDb('agent-storage-tool-lists');
  await installSessionStorageTestSchema(db);
  const handlerCleanup = registerDrizzleAgentStorage(MakaioBus, db);
  const cleanup = createDbCleanup(() => handlerCleanup(), close, dbPath);
  return { db, close, dbPath, exec, cleanup };
}

describe('registerDrizzleAgentStorage.allowedTools/disallowedTools', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;

    await ctx.exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES ('session-1', ${Date.now()}, ${Date.now()}, 'active')
    `);
  });

  afterEach(() => cleanup());

  it('round-trips allowedTools and disallowedTools', async () => {
    const agent = createTestAgent({
      agentId: 'agent-tools',
      allowedTools: ['read_file', 'edit_file'],
      disallowedTools: ['shell_exec'],
    });

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent,
    });

    const result = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'agent-tools',
    });

    expect(result.agent?.allowedTools).toEqual(['read_file', 'edit_file']);
    expect(result.agent?.disallowedTools).toEqual(['shell_exec']);
  });

  it('preserves an empty tool list rather than collapsing it to undefined', async () => {
    const agent = createTestAgent({
      agentId: 'agent-empty-tools',
      allowedTools: [],
      disallowedTools: [],
    });

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent,
    });

    const result = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'agent-empty-tools',
    });

    expect(result.agent?.allowedTools).toEqual([]);
    expect(result.agent?.disallowedTools).toEqual([]);
  });

  it('maps absent allowedTools/disallowedTools to undefined', async () => {
    const agent = createTestAgent({
      agentId: 'agent-no-tools',
      allowedTools: undefined,
      disallowedTools: undefined,
    });

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent,
    });

    const result = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'agent-no-tools',
    });

    expect(result.agent?.allowedTools).toBeUndefined();
    expect(result.agent?.disallowedTools).toBeUndefined();
  });
});
