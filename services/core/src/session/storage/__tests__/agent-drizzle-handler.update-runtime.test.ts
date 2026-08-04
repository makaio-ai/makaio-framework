import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleAgentStorage } from '../agent-drizzle-handler.js';
import { AgentStorageSubjects } from '../agent-namespace.js';

/**
 * Creates a temp file SQLite database carrying the canonical session-storage
 * schema. A local copy of the DDL silently drifts from the real columns.
 * @returns Test database context with cleanup that removes the temp file
 */
async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath, exec } = await createTempDb('agent-storage-update-runtime');
  await installSessionStorageTestSchema(db);
  const handlerCleanup = registerDrizzleAgentStorage(MakaioBus, db);
  const cleanup = createDbCleanup(() => handlerCleanup(), close, dbPath);
  return { db, close, dbPath, exec, cleanup };
}

describe('registerDrizzleAgentStorage.updateRuntime', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;

    await ctx.exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES ('session-1', ${Date.now()}, ${Date.now()}, 'active')
    `);

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: 'runtime-test',
      agent: {
        agentId: 'runtime-test',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
        role: 'lead',
        status: 'idle',
        createdAt: 1000,
        lastActivityAt: 1000,
        model: 'model-v1',
        cwd: '/tmp/old',
        allowedDirectories: ['/tmp/old'],
      },
    });
  });

  afterEach(() => cleanup());

  it('updates runtime fields without overwriting status', async () => {
    const beforeUpdate = Date.now();
    const result = await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'runtime-test',
      model: 'model-v2',
    });

    expect(result.success).toBe(true);

    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'runtime-test',
    });

    expect(agent?.model).toBe('model-v2');
    expect(agent?.cwd).toBe('/tmp/old');
    expect(agent?.allowedDirectories).toEqual(['/tmp/old']);
    expect(agent?.status).toBe('idle');
    expect(agent?.lastActivityAt).toBeGreaterThanOrEqual(beforeUpdate);
  });

  it('updates allowedDirectories without overwriting other runtime fields', async () => {
    const result = await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'runtime-test',
      allowedDirectories: ['/tmp/new'],
    });

    expect(result.success).toBe(true);

    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'runtime-test',
    });

    expect(agent?.allowedDirectories).toEqual(['/tmp/new']);
    expect(agent?.model).toBe('model-v1');
    expect(agent?.cwd).toBe('/tmp/old');
    expect(agent?.status).toBe('idle');
  });

  it('returns false when agent is missing', async () => {
    const result = await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'missing',
      cwd: '/tmp/new',
    });
    expect(result.success).toBe(false);
  });

  it('updates providerConfigId without overwriting other runtime fields', async () => {
    const result = await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'runtime-test',
      providerConfigId: 'provider-2',
    });

    expect(result.success).toBe(true);

    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'runtime-test',
    });

    expect(agent?.providerConfigId).toBe('provider-2');
    expect(agent?.model).toBe('model-v1');
    expect(agent?.cwd).toBe('/tmp/old');
    expect(agent?.allowedDirectories).toEqual(['/tmp/old']);
  });

  it('clears providerConfigId without treating null as an omitted update', async () => {
    await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'runtime-test',
      providerConfigId: 'provider-2',
    });

    const result = await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'runtime-test',
      providerConfigId: null,
    });

    expect(result.success).toBe(true);
    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'runtime-test',
    });
    expect(agent?.providerConfigId).toBeUndefined();
    expect(agent?.model).toBe('model-v1');
  });

  it('updates adapterId without overwriting other runtime fields', async () => {
    const result = await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
      agentId: 'runtime-test',
      adapterId: 'adapter-2',
    });

    expect(result.success).toBe(true);

    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'runtime-test',
    });

    expect(agent?.adapterId).toBe('adapter-2');
    expect(agent?.model).toBe('model-v1');
    expect(agent?.cwd).toBe('/tmp/old');
    expect(agent?.allowedDirectories).toEqual(['/tmp/old']);
    expect(agent?.status).toBe('idle');
  });
});
