/**
 * \@makaio/storage-conformance
 *
 * Public harness surface for dual-dialect storage conformance suites.
 *
 * ## Using the harness
 *
 * Suite files import `describeStorageConformance` and wrap all content in one
 * call. `useSuiteDatabaseContext` owns the beforeAll/afterAll lifecycle with
 * guarded teardown (a provisioning failure stays the only failure signal):
 * ```typescript
 * import { describeStorageConformance, useSuiteDatabaseContext } from '@makaio/storage-conformance';
 *
 * describeStorageConformance('my suite', (config) => {
 *   const getCtx = useSuiteDatabaseContext(config);
 *   it('…', async () => {
 *     const ctx = getCtx();
 *     // ... assertions over ctx.db / ctx.executor
 *   });
 * });
 * ```
 * @packageDocumentation
 */

// Config types
export type {
  StorageConformanceCapabilities,
  SiblingClientOptions,
  SiblingClient,
  StorageDatabaseContext,
  CreateDatabaseContextOptions,
  StorageConformanceConfig,
} from './harness/config.js';

// Environment resolution and suite entry point
export {
  STORAGE_TEST_DIALECT_ENV,
  STORAGE_TEST_URL_ENV,
  resolveStorageConformanceConfig,
  describeStorageConformance,
} from './harness/env.js';

// Suite lifecycle helper
export { useSuiteDatabaseContext } from './harness/suite-context.js';

// Config factories
export { createSqliteConfig } from './harness/sqlite-config.js';
export { createPostgresConfig, buildPostgresOptionsUrl } from './harness/postgres-config.js';

// Central chain reader
export { readCentralChain } from './harness/chains.js';

// Fixture builders
export { fixtureMigration } from './harness/fixture-migrations.js';
export { conformanceKvSqlite, fixtureKv, fixtureKvDdl } from './harness/fixture-table.js';
export { makeSession } from './harness/fixture-session.js';
