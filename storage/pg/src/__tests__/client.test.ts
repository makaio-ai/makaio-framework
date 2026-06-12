/**
 * Tests for {@link createNodePgClient} (the node-postgres driver glue).
 *
 * `pg` is a dependency of this package and pool construction is lazy, so
 * client creation is exercised for real without a running server. The single
 * exception is the missing-pg fault-injection test, which feeds a throwing
 * loader through the driver-loader seam so the real error-wrap path runs
 * without mocking the module system.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getDatabaseDialect } from '@makaio/storage-drizzle';
import type { DatabaseClient } from '@makaio/storage-drizzle/client';
import { createNodePgClient, type NodePgDriverLoaders } from '../client.js';

/** Connection URL shared by the no-connect smoke and fault-injection cases. */
const PG_URL = 'postgres://user:pw@localhost:5432/makaio';

describe('createNodePgClient (Postgres driver glue)', () => {
  let openClients: DatabaseClient[] = [];

  afterEach(async () => {
    for (const client of openClients) {
      await client.close();
    }
    openClients = [];
  });

  /**
   * Registers a client for automatic afterEach cleanup and returns it unchanged.
   * @param client - The database client to track.
   * @returns The same client, for chaining.
   */
  function track(client: DatabaseClient): DatabaseClient {
    openClients.push(client);
    return client;
  }

  it('resolves to a postgres-branded client without connecting', async () => {
    const client = track(await createNodePgClient(PG_URL, undefined));

    expect(client.dialect).toBe('postgres');
    expect(getDatabaseDialect(client.db)).toBe('postgres');
  });

  it('wraps a failing pg import in an actionable error with the cause attached', async () => {
    // Fault injection through the documented driver-loader seam: a broken or
    // hoisting-damaged install is simulated by a loader that throws. The real
    // catch block in createNodePgClient must wrap the failure with the
    // actionable hint and preserve the underlying cause.
    const failingLoaders: NodePgDriverLoaders = {
      loadPg: () => Promise.reject(new Error('simulated missing pg module')),
      loadDrizzlePg: () => Promise.reject(new Error('unreachable: pg load fails first')),
    };
    await expect(createNodePgClient(PG_URL, undefined, failingLoaders)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('dependency of @makaio/storage-pg') &&
        error.cause !== undefined,
    );
  });
});
