/**
 * Postgres dialect implementation of the conformance config.
 *
 * Provisions a fresh isolated schema per suite using a dedicated `search_path`
 * so every pooled connection lands in the schema automatically.
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
 * Drop a conformance isolation schema via a fresh short-lived admin client.
 *
 * `sql.identifier` performs proper identifier quoting (quote-doubling),
 * matching how the migration runner renders dynamic identifiers.
 * @param baseUrl - Base Postgres connection URL.
 * @param schemaName - Name of the isolation schema to drop.
 */
async function dropIsolationSchema(baseUrl: string, schemaName: string): Promise<void> {
  ensurePostgresEngineRegistered();
  const admin = await createDatabaseClient({ url: baseUrl });
  try {
    await getRawSqlExecutor(admin.db).run(sql`DROP SCHEMA ${sql.identifier(schemaName)} CASCADE`);
  } finally {
    await admin.close();
  }
}

/**
 * Create a fresh Postgres conformance context isolated to a dedicated schema.
 * @param baseUrl - Base Postgres connection URL.
 * @param schemaName - Name of the freshly created schema to isolate this context.
 * @param options - Provisioning options.
 * @returns Initialized database context.
 */
async function createPostgresDatabaseContext(
  baseUrl: string,
  schemaName: string,
  options: CreateDatabaseContextOptions,
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
      // error. The schema itself is dropped by createDatabaseContext.
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
    // skip the schema drop (no-orphaned-schema invariant). Collected failures
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

    // Drop the schema via a fresh short-lived admin client.
    try {
      await dropIsolationSchema(baseUrl, schemaName);
    } catch (error) {
      failures.push(error);
    }

    rethrowCleanupFailures(
      failures,
      `Postgres conformance cleanup for schema '${schemaName}' failed; resources may have leaked`,
    );
  };

  return {
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
 * fresh isolated schema (`conformance_<12 lowercase hex chars>`) on the database
 * at `baseUrl`.
 * @param baseUrl - Postgres connection URL for the target database.
 * @returns Postgres conformance config.
 */
export function createPostgresConfig(baseUrl: string): StorageConformanceConfig {
  return {
    name: 'postgres',
    dialect: 'postgres',
    capabilities: POSTGRES_CAPABILITIES,
    async createDatabaseContext(options: CreateDatabaseContextOptions = {}): Promise<StorageDatabaseContext> {
      ensurePostgresEngineRegistered();
      // Generate a unique schema name: conformance_ + 12 lowercase hex chars from UUID.
      const schemaName = 'conformance_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);

      // Create the schema via a short-lived admin client.
      const admin = await createDatabaseClient({ url: baseUrl });
      try {
        // sql.identifier performs proper identifier quoting (quote-doubling),
        // matching how the migration runner renders dynamic identifiers.
        await getRawSqlExecutor(admin.db).run(sql`CREATE SCHEMA ${sql.identifier(schemaName)}`);
      } finally {
        await admin.close();
      }

      try {
        return await createPostgresDatabaseContext(baseUrl, schemaName, options);
      } catch (error) {
        // The context never reached the caller, so its cleanup() can never
        // run. Drop the freshly created schema best-effort so failed
        // provisioning does not accumulate orphaned conformance_* schemas on
        // a long-lived database; the provisioning error stays the signal.
        try {
          await dropIsolationSchema(baseUrl, schemaName);
        } catch {
          // Best-effort only: a failed drop must not mask the original error.
        }
        throw error;
      }
    },
  };
}
