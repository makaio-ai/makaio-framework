/**
 * Vitest lifecycle binding for per-suite isolated database contexts.
 *
 * Owns the beforeAll/afterAll pair every conformance suite needs, so the
 * teardown invariant lives in exactly one place: cleanup is a no-op for a
 * context that was never provisioned, and a provisioning failure stays the
 * suite's only failure signal instead of being followed by a secondary
 * teardown error.
 * @packageDocumentation
 */
import { afterAll, beforeAll } from 'vitest';
import type { CreateDatabaseContextOptions, StorageConformanceConfig, StorageDatabaseContext } from './config.js';

/**
 * Provision one isolated database context for the enclosing suite.
 *
 * Call inside a `describe` body (or the `describeStorageConformance` callback).
 * Registers a `beforeAll` that provisions the context and an `afterAll` that
 * releases it, and returns an accessor for the provisioned context.
 *
 * Hook ordering: `beforeAll` hooks run in registration order and `afterAll`
 * hooks in reverse registration order, so hooks registered after this call
 * always run with the context available and before it is released — suites
 * that register handlers in their own `beforeAll` unregister them in their
 * own `afterAll` while the database still exists.
 * @param config - Active conformance config.
 * @param options - Provisioning options forwarded to
 *   {@link StorageConformanceConfig.createDatabaseContext}.
 * @returns Accessor for the suite's context. Throws when called before
 *   provisioning completed (e.g. from a `describe` body or a hook registered
 *   ahead of this call).
 */
export function useSuiteDatabaseContext(
  config: StorageConformanceConfig,
  options?: CreateDatabaseContextOptions,
): () => StorageDatabaseContext {
  let ctx: StorageDatabaseContext | undefined;

  beforeAll(async () => {
    ctx = await config.createDatabaseContext(options);
  });

  afterAll(async () => {
    // Guarded: when provisioning failed, there is nothing to release and the
    // provisioning error must remain the suite's only failure signal.
    await ctx?.cleanup();
  });

  return () => {
    if (ctx === undefined) {
      throw new Error(
        'Storage conformance database context accessed before provisioning completed — ' +
          'use the accessor only inside tests or hooks registered after useSuiteDatabaseContext().',
      );
    }
    return ctx;
  };
}
