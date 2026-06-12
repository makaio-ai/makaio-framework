/**
 * Dialect-adoption tests for the preferences storage handlers.
 *
 * Pins the resolveSchema seam: a Postgres-branded handle resolves to the
 * Postgres twin record, an unbranded handle resolves to the canonical SQLite
 * record, and registration against a Postgres-branded handle subscribes
 * exactly one handler per preferences subject on an isolated bus (and the
 * returned cleanup unsubscribes them).
 *
 * Behavioral correctness of the handler bodies is covered by the existing
 * SQLite suite in `preferences-service.test.ts`. Real-Postgres query
 * conformance is the conformance package's responsibility.
 */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import { createTestBusInstance, expectSubjectHandlerLifecycle, makeStubExtensionContext } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';
import { preferencesSchema } from '../storage/schema.variants.js';
import { registerDrizzlePreferencesStorage } from '../storage/drizzle-handler.js';
import { registerHybridPreferencesStorage } from '../storage/hybrid-handler.js';
import { preferences } from '../storage/schema.js';

/**
 * Every concrete subject in the preferences namespace; both registration
 * functions subscribe each of them exactly once. The $all wildcard accessor is
 * not an individually subscribable storage subject.
 */
const preferencesSubjects = Object.values(PreferencesSubjects).filter((subject) => subject.subject !== '*');

describe('preferences dialect adoption', () => {
  it('resolves the postgres twins for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, preferencesSchema);
    expect(resolved).toBe(preferencesSchema.postgres);
    expect(is(resolved.preferences, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite tables for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), preferencesSchema);
    expect(resolved).toBe(preferencesSchema.sqlite);
    expect(resolved.preferences).toBe(preferences);
  });

  // The registration cases below prove handler adoption of the pg-branded
  // handle on buses isolated from the process-global singleton; see the file
  // header for where behavioral and real-Postgres coverage lives.

  it('registers exactly one hybrid handler per subject on an isolated bus and cleanup removes them', async () => {
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(bus);

    expectSubjectHandlerLifecycle(bus, preferencesSubjects, () => registerHybridPreferencesStorage(bus, db, ctx));
  });

  it('registers exactly one drizzle handler per subject on an isolated bus and cleanup removes them', async () => {
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();

    expectSubjectHandlerLifecycle(bus, preferencesSubjects, () => registerDrizzlePreferencesStorage(bus, db));
  });
});
