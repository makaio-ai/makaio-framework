/**
 * Runtime-lifecycle integration tests.
 *
 * These tests verify that the embedded Makaio runtime boots cleanly, shuts
 * down, and can be re-booted after shutdown.  They require a full runtime
 * environment — SQLite storage, adapter packages in `node_modules`, etc. —
 * and therefore run only when `MAKAIO_TEST_RUNTIME=1` is set.
 *
 * To run locally:
 * ```
 * MAKAIO_TEST_RUNTIME=1 yarn test framework/sdks/agent-sdk
 * ```
 */

import { afterEach, describe, expect, it } from 'vitest';

// Guard: all tests in this file require a live runtime environment.
const RUNTIME_ENABLED = Boolean(process.env['MAKAIO_TEST_RUNTIME']);

describe.skipIf(!RUNTIME_ENABLED)('runtime lifecycle integration', () => {
  // -------------------------------------------------------------------------
  // Teardown: always shut down between tests so the singleton is clean.
  // Import lazily inside afterEach to avoid a module-load side-effect when
  // the suite is skipped.
  // -------------------------------------------------------------------------

  afterEach(async () => {
    const { shutdown } = await import('../../src/runtime/index.js');
    await shutdown();
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  it('startup() completes without error', { timeout: 60_000 }, async () => {
    const { startup } = await import('../../src/runtime/index.js');

    await expect(startup()).resolves.toBeUndefined();
  });

  it('startup() is idempotent — second call is a no-op', { timeout: 60_000 }, async () => {
    const { startup } = await import('../../src/runtime/index.js');

    await startup();
    await expect(startup()).resolves.toBeUndefined();
  });

  it('ensureRuntime() returns the MakaioBus singleton', { timeout: 60_000 }, async () => {
    const { ensureRuntime } = await import('../../src/runtime/index.js');
    const { MakaioBus } = await import('@makaio/bus-core');

    const bus = await ensureRuntime();

    // The /runtime entry point always returns the global MakaioBus singleton.
    expect(bus).toBe(MakaioBus);
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  it('shutdown() cleans up without error after a successful boot', { timeout: 60_000 }, async () => {
    const { startup, shutdown } = await import('../../src/runtime/index.js');

    await startup();
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('shutdown() is a no-op when the runtime was never started', { timeout: 60_000 }, async () => {
    const { shutdown } = await import('../../src/runtime/index.js');

    // afterEach already called shutdown, so the runtime is not running here.
    await expect(shutdown()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Re-boot after shutdown
  // -------------------------------------------------------------------------

  it('re-boots cleanly after a prior shutdown', { timeout: 120_000 }, async () => {
    const { startup, shutdown, ensureRuntime } = await import('../../src/runtime/index.js');

    // First boot.
    await startup();
    await shutdown();

    // Second boot — must succeed and return the bus.
    const bus = await ensureRuntime();
    expect(bus).toBeDefined();
  });
});
