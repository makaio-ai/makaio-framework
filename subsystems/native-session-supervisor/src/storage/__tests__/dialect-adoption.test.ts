import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { createTestBusInstance, expectSubjectHandlerLifecycle } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';
import { supervisorRuntimesSchema } from '../schema.variants.js';
import { SupervisorRuntimeStorageSubjects } from '../namespace.js';
import { registerDrizzleSupervisorRuntimeStorage } from '../drizzle-handler.js';
import { supervisorRuntimes } from '../schema.js';

describe('native-session-supervisor dialect adoption', () => {
  it('resolves the postgres twins for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, supervisorRuntimesSchema);
    expect(resolved).toBe(supervisorRuntimesSchema.postgres);
    expect(is(resolved.supervisorRuntimes, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite tables for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), supervisorRuntimesSchema);
    expect(resolved).toBe(supervisorRuntimesSchema.sqlite);
    expect(resolved.supervisorRuntimes).toBe(supervisorRuntimes);
  });

  it('registers exactly one handler per storage subject on an isolated bus and cleanup removes them', async () => {
    // createPgBrandedTestDb's executor records statements instead of
    // executing them, so a live round-trip is impossible here; the storage
    // conformance suite runs these handlers against live Postgres in CI.
    // This case proves the registration path adopts the pg-branded handle on
    // a bus isolated from the process-global singleton.
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    // Every concrete subject in the namespace is registered; only the $all
    // wildcard accessor is not an individually subscribable storage subject.
    const subjects = Object.values(SupervisorRuntimeStorageSubjects).filter((subject) => subject.subject !== '*');

    expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleSupervisorRuntimeStorage(bus, db));
  });
});
