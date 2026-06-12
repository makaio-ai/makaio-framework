/**
 * Dialect-adoption seam tests for services-core satellite packages:
 * messages, session-events, turns, message-routing, import-cursors, harness.
 *
 * Each suite verifies:
 *  - A Postgres-branded handle resolves to the .postgres record (reference identity)
 *    and every table key is a real PgTable at runtime.
 *  - An unbranded handle resolves to .sqlite with reference identity against the
 *    canonical SQLite table exports.
 *  - Registering all handlers against a PG-branded handle succeeds and returns a
 *    cleanup function, executing every registration-time resolveSchema call.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { PgTable } from 'drizzle-orm/pg-core';
import { MakaioBus } from '@makaio/bus-core';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { resolveSchema } from '@makaio/storage-drizzle';

// Variants modules
import { messagesSchema } from '../session/messages/schema.variants.js';
import { sessionEventsSchema } from '../session/session-events/schema.variants.js';
import { turnsSchema } from '../session/turns/schema.variants.js';
import { messageRoutingSchema } from '../session/message-routing/schema.variants.js';
import { importCursorsSchema } from '../session/import-cursors/schema.variants.js';
import { harnessStorageSchema } from '../harness/storage/schema.variants.js';

// Canonical SQLite table exports (test-only imports — not adopted modules)
import { messages } from '../session/messages/schema.js';
import { sessionEvents } from '../session/session-events/schema.js';
import { turns } from '../session/turns/schema.js';
import { messageRouting } from '../session/message-routing/schema.js';
import { importCursors } from '../session/import-cursors/schema.js';
import { harnessDefinitions } from '../harness/storage/schema.js';

// Registration entrypoints
import { registerDrizzleMessageStorage } from '../session/messages/drizzle-handler.js';
import { registerDrizzleSessionEventStorage } from '../session/session-events/drizzle-handler.js';
import { registerDrizzleTurnStorage } from '../session/turns/drizzle-handler.js';
import { registerDrizzleMessageRoutingStorage } from '../session/message-routing/drizzle-handler.js';
import { registerDrizzleImportCursorStorage } from '../session/import-cursors/drizzle-handler.js';
import { registerDrizzleHarnessStorage } from '../harness/storage/handler.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Creates an in-memory unbranded handle for SQLite resolution tests. */
function makeUnbrandedDb() {
  return drizzle({ connection: { url: ':memory:' } });
}

// ---------------------------------------------------------------------------
// messagesSchema
// ---------------------------------------------------------------------------

describe('messagesSchema dialect resolution', () => {
  it('resolves to the postgres record for a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const resolved = resolveSchema(db, messagesSchema);
    expect(resolved).toBe(messagesSchema.postgres);
    expect(is(resolved.messages, PgTable)).toBe(true);
  });

  it('resolves to the sqlite record for an unbranded handle', () => {
    const resolved = resolveSchema(makeUnbrandedDb(), messagesSchema);
    expect(resolved).toBe(messagesSchema.sqlite);
    expect(resolved.messages).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// sessionEventsSchema
// ---------------------------------------------------------------------------

describe('sessionEventsSchema dialect resolution', () => {
  it('resolves to the postgres record for a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const resolved = resolveSchema(db, sessionEventsSchema);
    expect(resolved).toBe(sessionEventsSchema.postgres);
    expect(is(resolved.sessionEvents, PgTable)).toBe(true);
  });

  it('resolves to the sqlite record for an unbranded handle', () => {
    const resolved = resolveSchema(makeUnbrandedDb(), sessionEventsSchema);
    expect(resolved).toBe(sessionEventsSchema.sqlite);
    expect(resolved.sessionEvents).toBe(sessionEvents);
  });
});

// ---------------------------------------------------------------------------
// turnsSchema
// ---------------------------------------------------------------------------

describe('turnsSchema dialect resolution', () => {
  it('resolves to the postgres record for a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const resolved = resolveSchema(db, turnsSchema);
    expect(resolved).toBe(turnsSchema.postgres);
    expect(is(resolved.turns, PgTable)).toBe(true);
  });

  it('resolves to the sqlite record for an unbranded handle', () => {
    const resolved = resolveSchema(makeUnbrandedDb(), turnsSchema);
    expect(resolved).toBe(turnsSchema.sqlite);
    expect(resolved.turns).toBe(turns);
  });
});

// ---------------------------------------------------------------------------
// messageRoutingSchema
// ---------------------------------------------------------------------------

describe('messageRoutingSchema dialect resolution', () => {
  it('resolves to the postgres record for a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const resolved = resolveSchema(db, messageRoutingSchema);
    expect(resolved).toBe(messageRoutingSchema.postgres);
    expect(is(resolved.messageRouting, PgTable)).toBe(true);
  });

  it('resolves to the sqlite record for an unbranded handle', () => {
    const resolved = resolveSchema(makeUnbrandedDb(), messageRoutingSchema);
    expect(resolved).toBe(messageRoutingSchema.sqlite);
    expect(resolved.messageRouting).toBe(messageRouting);
  });
});

// ---------------------------------------------------------------------------
// importCursorsSchema
// ---------------------------------------------------------------------------

describe('importCursorsSchema dialect resolution', () => {
  it('resolves to the postgres record for a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const resolved = resolveSchema(db, importCursorsSchema);
    expect(resolved).toBe(importCursorsSchema.postgres);
    expect(is(resolved.importCursors, PgTable)).toBe(true);
  });

  it('resolves to the sqlite record for an unbranded handle', () => {
    const resolved = resolveSchema(makeUnbrandedDb(), importCursorsSchema);
    expect(resolved).toBe(importCursorsSchema.sqlite);
    expect(resolved.importCursors).toBe(importCursors);
  });
});

// ---------------------------------------------------------------------------
// harnessStorageSchema
// ---------------------------------------------------------------------------

describe('harnessStorageSchema dialect resolution', () => {
  it('resolves to the postgres record for a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const resolved = resolveSchema(db, harnessStorageSchema);
    expect(resolved).toBe(harnessStorageSchema.postgres);
    expect(is(resolved.harnessDefinitions, PgTable)).toBe(true);
  });

  it('resolves to the sqlite record for an unbranded handle', () => {
    const resolved = resolveSchema(makeUnbrandedDb(), harnessStorageSchema);
    expect(resolved).toBe(harnessStorageSchema.sqlite);
    expect(resolved.harnessDefinitions).toBe(harnessDefinitions);
  });
});

// ---------------------------------------------------------------------------
// PG-brand registration smoke tests
// ---------------------------------------------------------------------------

describe('PG-brand handler registration', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('registers all message handlers against a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(MakaioBus);
    cleanup = registerDrizzleMessageStorage(MakaioBus, db, ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers all session-event handlers against a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(MakaioBus);
    cleanup = registerDrizzleSessionEventStorage(MakaioBus, db, ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers all turn handlers against a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(MakaioBus);
    cleanup = registerDrizzleTurnStorage(MakaioBus, db, ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers all message-routing handlers against a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(MakaioBus);
    cleanup = registerDrizzleMessageRoutingStorage(MakaioBus, db, ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers all import-cursor handlers against a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(MakaioBus);
    cleanup = registerDrizzleImportCursorStorage(MakaioBus, db, ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers all harness handlers against a pg-branded handle', () => {
    const { db } = createPgBrandedTestDb();
    const ctx = makeStubExtensionContext(MakaioBus);
    cleanup = registerDrizzleHarnessStorage(MakaioBus, db, ctx);
    expect(typeof cleanup).toBe('function');
  });
});
