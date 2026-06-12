/**
 * Dialect-adoption tests for the client subsystem storage handlers.
 *
 * Verifies that:
 * - Each variants schema resolves to the correct branch (postgres vs sqlite)
 *   for a pg-branded and an unbranded handle respectively.
 * - The resolved postgres branch tables are genuine `PgTable` instances.
 * - Every handler registration entrypoint accepts a pg-branded handle and
 *   subscribes exactly one handler per storage subject on an isolated bus
 *   (and the returned cleanup unsubscribes them).
 *
 * Behavioral correctness (actual Postgres queries) is the conformance suite's
 * responsibility. The SQLite suites (runtime-drizzle-handler.test.ts, etc.)
 * cover handler body logic and constitute the regression guard for the sqlite
 * branch.
 */

import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { createTestBusInstance, expectSubjectHandlerLifecycle, makeStubExtensionContext } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';
import { clientRuntimesSchema } from '../runtime-schema.variants.js';
import { clientBinarySchema } from '../client-binary-schema.variants.js';
import { clientProfilesSchema } from '../profile-schema.variants.js';
import { clientRuntimes } from '../runtime-schema.js';
import { clientBinaryVersions, clientBinaryState } from '../client-binary-schema.js';
import { clientProfiles } from '../profile-schema.js';
import { ClientRuntimeStorageSubjects } from '../runtime-storage-namespace.js';
import { ClientBinaryStorageSubjects } from '../client-binary-storage-namespace.js';
import { ClientProfileStorageSubjects } from '../profile-storage-namespace.js';
import { registerDrizzleRuntimeStorage } from '../runtime-drizzle-handler.js';
import { registerDrizzleClientBinaryStorage } from '../client-binary-drizzle-handler.js';
import { ClientProfileStorageNamespace, registerDrizzleProfileStorage } from '../profile-drizzle-handler.js';

// ---------------------------------------------------------------------------
// clientRuntimesSchema
// ---------------------------------------------------------------------------

describe('clientRuntimesSchema dialect adoption', () => {
  it('resolves the postgres twin for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, clientRuntimesSchema);
    expect(resolved).toBe(clientRuntimesSchema.postgres);
    expect(is(resolved.clientRuntimes, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite table for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), clientRuntimesSchema);
    expect(resolved).toBe(clientRuntimesSchema.sqlite);
    expect(resolved.clientRuntimes).toBe(clientRuntimes);
  });
});

// ---------------------------------------------------------------------------
// clientBinarySchema
// ---------------------------------------------------------------------------

describe('clientBinarySchema dialect adoption', () => {
  it('resolves the postgres twins for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, clientBinarySchema);
    expect(resolved).toBe(clientBinarySchema.postgres);
    expect(is(resolved.clientBinaryVersions, PgTable)).toBe(true);
    expect(is(resolved.clientBinaryState, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite tables for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), clientBinarySchema);
    expect(resolved).toBe(clientBinarySchema.sqlite);
    expect(resolved.clientBinaryVersions).toBe(clientBinaryVersions);
    expect(resolved.clientBinaryState).toBe(clientBinaryState);
  });
});

// ---------------------------------------------------------------------------
// clientProfilesSchema
// ---------------------------------------------------------------------------

describe('clientProfilesSchema dialect adoption', () => {
  it('resolves the postgres twin for a pg-branded handle', async () => {
    const { db } = await createPgBrandedTestDb();
    const resolved = resolveSchema(db, clientProfilesSchema);
    expect(resolved).toBe(clientProfilesSchema.postgres);
    expect(is(resolved.clientProfiles, PgTable)).toBe(true);
  });

  it('resolves the canonical sqlite table for an unbranded handle', () => {
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), clientProfilesSchema);
    expect(resolved).toBe(clientProfilesSchema.sqlite);
    expect(resolved.clientProfiles).toBe(clientProfiles);
  });
});

// ---------------------------------------------------------------------------
// PG-brand registration lifecycle
//
// The pg-branded handle carries no Postgres engine, so live round-trips are
// impossible here; the SQLite suites cover handler bodies and the storage
// conformance suite runs against live Postgres in CI. Each registration runs
// on a bus isolated from the process-global singleton. Every concrete subject
// of each namespace is registered; only the $all wildcard accessor is not an
// individually subscribable storage subject.
// ---------------------------------------------------------------------------

describe('client subsystem handler registration against a pg-branded handle', () => {
  it('registers exactly one runtime handler per subject on an isolated bus and cleanup removes them', async () => {
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(bus);
    const subjects = Object.values(ClientRuntimeStorageSubjects).filter((subject) => subject.subject !== '*');

    expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleRuntimeStorage(bus, db, ctx));
  });

  it('registers exactly one client-binary handler per subject on an isolated bus and cleanup removes them', async () => {
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(bus);
    const subjects = Object.values(ClientBinaryStorageSubjects).filter((subject) => subject.subject !== '*');

    expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleClientBinaryStorage(bus, db, ctx));
  });

  it('registers exactly one profile handler per subject on an isolated bus and cleanup removes them', async () => {
    const bus = createTestBusInstance();
    const { db } = await createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(bus);
    bus.registerNamespace(ClientProfileStorageNamespace);
    const subjects = Object.values(ClientProfileStorageSubjects).filter((subject) => subject.subject !== '*');

    expectSubjectHandlerLifecycle(bus, subjects, () => registerDrizzleProfileStorage(bus, db, ctx));
  });
});
