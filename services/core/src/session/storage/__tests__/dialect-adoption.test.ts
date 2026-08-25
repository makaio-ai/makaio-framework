import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { SessionSubjects } from '@makaio/contracts';
import { createTestBusInstance, expectSubjectHandlerLifecycle } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';
import { sessionStorageSchema } from '../schema.variants.js';
import { messagesSchema } from '../../messages/schema.variants.js';
import { sessions, agents, runtimeInstanceIncarnationCounters, runtimeInstances } from '../schema.js';
import { messages } from '../../messages/schema.js';
import { SessionStorageSubjects } from '../namespace.js';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { registerDrizzleSessionStorage } from '../drizzle-handler.js';
import { registerDrizzleAgentStorage } from '../agent-drizzle-handler.js';
import { registerParentResolver } from '../../import/parent-resolver.js';

describe('session storage dialect adoption', () => {
  describe('sessionStorageSchema resolution', () => {
    it('resolves postgres twins for a pg-branded handle', async () => {
      const { db } = await createPgBrandedTestDb();
      const resolved = resolveSchema(db, sessionStorageSchema);
      expect(resolved).toBe(sessionStorageSchema.postgres);
      expect(is(resolved.sessions, PgTable)).toBe(true);
      expect(is(resolved.agents, PgTable)).toBe(true);
      expect(is(resolved.runtimeInstanceIncarnationCounters, PgTable)).toBe(true);
      expect(is(resolved.runtimeInstances, PgTable)).toBe(true);
    });

    it('resolves canonical sqlite tables for an unbranded handle', () => {
      const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), sessionStorageSchema);
      expect(resolved).toBe(sessionStorageSchema.sqlite);
      expect(resolved.sessions).toBe(sessions);
      expect(resolved.agents).toBe(agents);
      expect(resolved.runtimeInstanceIncarnationCounters).toBe(runtimeInstanceIncarnationCounters);
      expect(resolved.runtimeInstances).toBe(runtimeInstances);
    });
  });

  describe('messagesSchema resolution', () => {
    it('resolves postgres twins for a pg-branded handle', async () => {
      const { db } = await createPgBrandedTestDb();
      const resolved = resolveSchema(db, messagesSchema);
      expect(resolved).toBe(messagesSchema.postgres);
      expect(is(resolved.messages, PgTable)).toBe(true);
    });

    it('resolves canonical sqlite table for an unbranded handle', () => {
      const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), messagesSchema);
      expect(resolved).toBe(messagesSchema.sqlite);
      expect(resolved.messages).toBe(messages);
    });
  });

  // The pg-branded handle carries no Postgres engine, so live round-trips are
  // impossible here; SQLite behavioral coverage lives in the session storage
  // suites and the storage conformance suite runs against live Postgres in
  // CI. These cases prove the registration path adopts the pg-branded handle
  // on buses isolated from the process-global singleton.
  describe('PG-brand registration lifecycle', () => {
    it('registers exactly one session storage handler per subject on an isolated bus', async () => {
      const bus = createTestBusInstance();
      const { db } = await createPgBrandedTestDb();
      const subjects = [
        SessionStorageSubjects.get,
        SessionStorageSubjects.set,
        SessionStorageSubjects.delete,
        SessionStorageSubjects.update,
        SessionStorageSubjects.list,
        SessionStorageSubjects.getStatusCounts,
      ];

      expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleSessionStorage(bus, db));
    });

    it('registers exactly one agent storage handler per subject on an isolated bus', async () => {
      const bus = createTestBusInstance();
      const { db } = await createPgBrandedTestDb();
      const subjects = [
        AgentStorageSubjects.get,
        AgentStorageSubjects.set,
        AgentStorageSubjects.delete,
        AgentStorageSubjects.listByAdapter,
        AgentStorageSubjects.listBySession,
        AgentStorageSubjects.updateStatus,
        AgentStorageSubjects.updateActivity,
        AgentStorageSubjects.updateRuntime,
      ];

      expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleAgentStorage(bus, db));
    });

    it('registers the parent resolver on the import-completed event of an isolated bus', async () => {
      const bus = createTestBusInstance();
      const { db } = await createPgBrandedTestDb();

      expectSubjectHandlerLifecycle(bus, [SessionSubjects.import.completed], () => registerParentResolver(bus, db));
    });
  });
});
