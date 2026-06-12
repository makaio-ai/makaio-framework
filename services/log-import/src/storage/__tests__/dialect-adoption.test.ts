/**
 * Dialect-adoption tests for the log-import storage handlers.
 *
 * Pins the resolveSchema seam: a Postgres-branded handle resolves to the
 * Postgres twin record, an unbranded handle resolves to the canonical SQLite
 * record, and registration against a Postgres-branded handle subscribes
 * exactly one handler per storage subject on an isolated bus (and the
 * returned cleanup unsubscribes them).
 *
 * Behavioral correctness of the handler bodies is covered by the existing
 * SQLite suite in `../storage-handlers.test.ts`. Real-Postgres query
 * conformance is the conformance package's responsibility.
 */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { createTestBusInstance, expectSubjectHandlerLifecycle, makeStubExtensionContext } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';
import { LogImportSubjects } from '../../namespace.js';
import { logImportSettingsSchema } from '../schema.variants.js';
import { registerDrizzleLogImportStorage } from '../handlers.js';
import { logImportSettings } from '../schema.js';

describe('log-import storage dialect adoption', () => {
  it('resolves the postgres twins for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, logImportSettingsSchema);
    expect(resolved).toBe(logImportSettingsSchema.postgres);
    expect(is(resolved.logImportSettings, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite tables for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), logImportSettingsSchema);
    expect(resolved).toBe(logImportSettingsSchema.sqlite);
    expect(resolved.logImportSettings).toBe(logImportSettings);
  });

  it('registers exactly one handler per storage subject on an isolated bus and cleanup removes them', async () => {
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(bus);
    // The storage registration owns exactly these subjects of the wider
    // log-import namespace; the remaining subjects belong to the import
    // service, not to Drizzle storage.
    const subjects = [LogImportSubjects.getMode, LogImportSubjects.setMode, LogImportSubjects.listSettings];

    expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleLogImportStorage(bus, db, ctx));
  });
});
