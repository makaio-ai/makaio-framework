/**
 * node-postgres driver glue.
 *
 * Delegation target of the engine's `createClient` — deliberately kept off
 * the package barrel: consumers create Postgres clients through the engine
 * registry (`createDatabaseClient` in `@makaio/storage-drizzle/client`),
 * never by calling the driver glue directly.
 * @packageDocumentation
 */
import { brandDatabase, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { DatabaseClient, PostgresClientOptions } from '@makaio/storage-drizzle/client';
import { attachPgPoolErrorLogger, createPostgresRawSqlExecutor, type PostgresPoolLike } from './raw-sql.js';

/** Structural surface of the `pg` module used by {@link createNodePgClient}. */
interface PgModule {
  default: { Pool: new (config: { connectionString: string; max: number }) => PostgresPoolLike };
}

/** Structural surface of the `drizzle-orm/node-postgres` module used by {@link createNodePgClient}. */
interface NodePgDrizzleModule {
  drizzle: (pool: PostgresPoolLike) => object;
}

/**
 * Lazy loaders for the Postgres driver modules.
 *
 * Internal seam: the production defaults are the literal dynamic imports below;
 * tests inject a loader that throws to exercise the missing-driver error-wrap
 * path without mocking the module system.
 */
export interface NodePgDriverLoaders {
  /** Loads the `pg` module. */
  readonly loadPg: () => Promise<PgModule>;
  /** Loads the `drizzle-orm/node-postgres` module. */
  readonly loadDrizzlePg: () => Promise<NodePgDrizzleModule>;
}

/**
 * Production driver loaders: direct dynamic imports resolved relative to this
 * module. Both specifiers are declared dependencies of this package, so the
 * import resolves correctly even under strict installs (pnpm, Yarn PnP).
 */
const defaultDriverLoaders: NodePgDriverLoaders = {
  loadPg: () => import('pg'),
  loadDrizzlePg: () => import('drizzle-orm/node-postgres'),
};

/**
 * Default maximum pool size for Postgres connections.
 *
 * Sized for direct connections to a small managed Postgres tier without an
 * external connection pooler. Callers that need a different limit pass
 * `postgres.poolMax` in `DatabaseClientConfig`.
 */
const DEFAULT_PG_POOL_MAX = 4;

/**
 * Creates a database client backed by the node-postgres (`pg`) driver.
 *
 * Delegation target of the Postgres engine's `createClient`: the engine
 * package owns both the dialect-specific behavior registered through the
 * engine seam and this driver glue.
 *
 * Both `'pg'` and `'drizzle-orm/node-postgres'` load through direct dynamic
 * `import()` calls, so the drivers load on the first Postgres client rather
 * than at module load (laziness is preserved). Resolution happens from this
 * module, which declares both as regular dependencies, so it stays
 * strict-install-safe (pnpm, Yarn PnP) where the drivers are only resolvable
 * from this package. Bundle-time resolvability is acceptable here precisely
 * because they are declared dependencies of this package — the build leaves
 * them external (see `build.ts`); bundler-opacity is only required for
 * specifiers the resolving package does not declare.
 * @param url - Postgres connection URL (`postgres://` or `postgresql://`).
 * @param options - Optional pool tuning options.
 * @param loaders - Internal driver-loader seam; defaults to the literal
 *   dynamic imports. Tests inject a throwing loader to exercise the error path.
 * @returns Database client with drizzle ORM instance and async close method.
 */
export async function createNodePgClient(
  url: string,
  options: PostgresClientOptions | undefined,
  loaders: NodePgDriverLoaders = defaultDriverLoaders,
): Promise<DatabaseClient> {
  let pg: PgModule['default'];
  let drizzlePg: NodePgDrizzleModule['drizzle'];
  try {
    ({ default: pg } = await loaders.loadPg());
    ({ drizzle: drizzlePg } = await loaders.loadDrizzlePg());
  } catch (error) {
    throw new Error(
      'createNodePgClient: failed to load the Postgres driver modules ' +
        "('pg' and 'drizzle-orm/node-postgres'). 'pg' is a dependency of " +
        "@makaio/storage-pg — verify the host application's install is intact.",
      { cause: error },
    );
  }

  const pool = new pg.Pool({ connectionString: url, max: options?.poolMax ?? DEFAULT_PG_POOL_MAX });
  // node-postgres re-emits idle-connection failures on the pool itself; an
  // unhandled 'error' event there would crash the host process, so the pool
  // always gets the framework's logging listener.
  attachPgPoolErrorLogger(pool);
  const db = drizzlePg(pool);
  brandDatabase(db, 'postgres', createPostgresRawSqlExecutor(pool));

  // NodePgDatabase and LibSQLDatabase share the portable query-builder surface
  // (select, insert, update, delete, transaction) with compatible call
  // signatures.  MakaioDatabase already excludes every libsql-only member
  // (run, all, get, values, batch, $client, resultKind), so the remaining
  // contract is dialect-portable.  At runtime the handle is a real Postgres
  // database, so drizzle emits dialect-correct SQL — the bridge is types-only,
  // the same documented honesty model as the Bun cast.
  // Validated against drizzle-orm 0.45.2.
  let closed = false;
  return {
    db: db as unknown as MakaioDatabase,
    dialect: 'postgres',
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
