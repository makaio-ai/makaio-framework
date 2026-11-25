/**
 * Postgres dialect implementation of the conformance config.
 *
 * Provisions a fresh schema per suite, or an exclusive database when tests
 * observe database-wide signals. Both modes pin the clients' `search_path`.
 * @packageDocumentation
 */
import { sql } from 'drizzle-orm';
import { findStorageEngine, getRawSqlExecutor, registerStorageEngine } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { applyMigrations } from '@makaio/storage-migrations';
import { postgresStorageEngine } from '@makaio/storage-pg';
import type {
  CreateDatabaseContextOptions,
  SiblingClient,
  SiblingClientOptions,
  StorageConformanceCapabilities,
  StorageConformanceConfig,
  StorageDatabaseContext,
} from './config.js';
import { readCentralChain } from './chains.js';
import { collectRejections, rethrowCleanupFailures } from './cleanup-failures.js';

/**
 * Capability flags for the Postgres dialect.
 *
 * Full-text search is backed by the `messages.content_tsv` stored generated
 * column (tsvector, english regconfig) plus a GIN index applied by the central
 * Postgres migration chain.
 */
const POSTGRES_CAPABILITIES: StorageConformanceCapabilities = {
  fts: true,
};

/**
 * Idempotently register the Postgres storage engine.
 *
 * The conformance harness is its own composition root: it creates database
 * clients directly through `createDatabaseClient`, so it owns explicit engine
 * registration (the runtime hosts' URL auto-resolve never runs here). Called
 * first in every client-creating entry point of this module so no code path
 * can reach the registry-dispatched factory before the engine is registered.
 * Exported for suites that use engine-owned migration mechanics (ledger
 * naming, journal-dialect guard, chain folders) before any database context
 * exists.
 */
export function ensurePostgresEngineRegistered(): void {
  if (findStorageEngine('postgres') === undefined) {
    registerStorageEngine(postgresStorageEngine);
  }
}

/**
 * Build a Postgres connection URL that appends GUC settings via the `options`
 * query parameter.
 *
 * Each key-value pair from `settings` is serialized as `-c key=value`, with
 * spaces inside values backslash-escaped. The pairs are space-joined into one
 * string and appended as a single `options` query parameter. The value is
 * percent-encoded with `encodeURIComponent` (never `URLSearchParams`, whose
 * `+`-space encoding is ambiguous to pg-connection-string).
 *
 * Existing query parameters in `baseUrl` are preserved.
 * @param baseUrl - Base Postgres connection URL.
 * @param settings - GUC settings to apply to every pooled connection.
 * @returns URL with the `options` query parameter appended.
 */
export function buildPostgresOptionsUrl(baseUrl: string, settings: Readonly<Record<string, string>>): string {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return baseUrl;
  }

  // Serialize each setting as `-c key=value`, escaping spaces in values.
  const parts = entries.map(([k, v]) => `-c ${k}=${v.replaceAll(' ', '\\ ')}`);
  const optionsValue = encodeURIComponent(parts.join(' '));

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}options=${optionsValue}`;
}

/**
 * Provision a Postgres isolation unit and transfer its ownership to the context.
 * @param baseUrl - Base Postgres connection URL.
 * @param options - Provisioning options.
 * @returns Initialized database context.
 */
async function provisionPostgresContext(
  baseUrl: string,
  options: CreateDatabaseContextOptions,
): Promise<StorageDatabaseContext> {
  ensurePostgresEngineRegistered();
  const name = 'conformance_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const identifier = sql.identifier(name);
  const exclusive = options.postgresIsolation === 'database';
  const url = new URL(baseUrl);
  if (exclusive) url.pathname = `/${name}`;

  const dropIsolation = async (): Promise<void> => {
    const admin = await createDatabaseClient({ url: baseUrl });
    try {
      const ddl = exclusive ? sql`DROP DATABASE ${identifier} WITH (FORCE)` : sql`DROP SCHEMA ${identifier} CASCADE`;
      await getRawSqlExecutor(admin.db).run(ddl);
    } finally {
      await admin.close();
    }
  };

  const admin = await createDatabaseClient({ url: baseUrl });
  try {
    const ddl = exclusive ? sql`CREATE DATABASE ${identifier} TEMPLATE template0` : sql`CREATE SCHEMA ${identifier}`;
    await getRawSqlExecutor(admin.db).run(ddl);
  } catch (error) {
    try {
      await admin.close();
    } catch {
      // Preserve the provisioning error.
    }
    throw error;
  }

  try {
    await admin.close();
    return await createPostgresDatabaseContext(
      exclusive ? url.href : baseUrl,
      exclusive ? 'public' : name,
      options,
      dropIsolation,
    );
  } catch (error) {
    // Ownership never reached the suite's teardown hook.
    try {
      await dropIsolation();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Postgres isolation setup and cleanup both failed');
    }
    throw error;
  }
}

/**
 * Open the clients over the provisioned isolation unit.
 * @param baseUrl - Connection URL for the context's database.
 * @param schemaName - Schema pinned on each client.
 * @param options - Provisioning options.
 * @param dropIsolation - Releases the owned schema or database after closing clients.
 * @returns Initialized database context.
 */
async function createPostgresDatabaseContext(
  baseUrl: string,
  schemaName: string,
  options: CreateDatabaseContextOptions,
  dropIsolation: () => Promise<void>,
): Promise<StorageDatabaseContext> {
  ensurePostgresEngineRegistered();
  // The harness-owned schema pin is spread LAST so it always supersedes
  // caller settings: a caller-provided search_path would silently escape the
  // per-context isolation schema and bleed data across contexts.
  const primaryUrl = buildPostgresOptionsUrl(baseUrl, {
    ...options.postgresSettings,
    search_path: schemaName,
  });

  const primary = await createDatabaseClient({
    url: primaryUrl,
    postgres: { poolMax: options.poolMax ?? 4 },
  });
  const executor = getRawSqlExecutor(primary.db);

  if (options.applyCentralChain !== false) {
    try {
      await applyMigrations(primary.db, readCentralChain('postgres'));
    } catch (error) {
      // Provisioning failed before the context (and its cleanup contract)
      // reached the caller: close the pool here so the process can shut down
      // cleanly. Best-effort — a close error must not mask the migration
      // error. The isolation unit is dropped by provisionPostgresContext.
      try {
        await primary.close();
      } catch {
        // Best-effort only.
      }
      throw error;
    }
  }

  const siblings: SiblingClient[] = [];

  const createSiblingClient = async (siblingOptions?: SiblingClientOptions): Promise<SiblingClient> => {
    ensurePostgresEngineRegistered();
    // Same pin-wins ordering as the primary URL: the isolation schema is
    // harness-owned and never overridable by sibling settings.
    const siblingUrl = buildPostgresOptionsUrl(baseUrl, {
      ...siblingOptions?.postgresSettings,
      search_path: schemaName,
    });

    const siblingClient = await createDatabaseClient({
      url: siblingUrl,
      postgres: { poolMax: siblingOptions?.poolMax ?? 4 },
    });
    const siblingExecutor = getRawSqlExecutor(siblingClient.db);

    let closed = false;
    const sibling: SiblingClient = {
      db: siblingClient.db,
      executor: siblingExecutor,
      close: async () => {
        if (closed) return;
        closed = true;
        await siblingClient.close();
      },
    };
    siblings.push(sibling);
    return sibling;
  };

  const cleanup = async (): Promise<void> => {
    // Every resource the context owns gets a release attempt: failures are
    // collected instead of aborting teardown, so one failing close can never
    // skip removal of the isolation unit. Collected failures
    // are rethrown once teardown has reached the end (loud leak detection).
    const failures: unknown[] = [];

    // Close all tracked siblings (independent pools, closed concurrently).
    collectRejections(failures, await Promise.allSettled(siblings.map((sibling) => sibling.close())));

    // Close primary pool.
    try {
      await primary.close();
    } catch (error) {
      failures.push(error);
    }

    try {
      await dropIsolation();
    } catch (error) {
      failures.push(error);
    }

    rethrowCleanupFailures(failures, 'Postgres conformance cleanup failed; resources may have leaked');
  };

  return {
    url: primaryUrl,
    db: primary.db,
    dialect: 'postgres',
    capabilities: POSTGRES_CAPABILITIES,
    executor,
    createSiblingClient,
    cleanup,
  };
}

/**
 * Build a Postgres conformance config for a given base connection URL.
 *
 * Each call to {@link StorageConformanceConfig.createDatabaseContext} provisions a
 * fresh isolation unit (`conformance_<12 lowercase hex chars>`) using the
 * connection at `baseUrl`.
 * @param baseUrl - Postgres connection URL for the target database.
 * @returns Postgres conformance config.
 */
export function createPostgresConfig(baseUrl: string): StorageConformanceConfig {
  return {
    name: 'postgres',
    dialect: 'postgres',
    capabilities: POSTGRES_CAPABILITIES,
    createDatabaseContext(options = {}) {
      return provisionPostgresContext(baseUrl, options);
    },
  };
}
